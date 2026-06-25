# WIS2 Global Cache Downloader — Configuration Reference

This document covers every option in `configuration.yml`. It is intended for administrators deploying and operating the downloader, not for developers modifying the flow itself.

---

## How configuration works

At startup the application reads `configuration.yml` once and validates its content. If validation fails, the flow halts and logs the errors — no downloading or subscribing takes place until the problem is fixed and the application is restarted.

A subset of settings can also be changed at runtime through the `/set` HTTP endpoint without restarting. Those settings are marked **runtime-settable** throughout this document. Changes made via `/set` are applied immediately to the running instance but are **not written back** to `configuration.yml`. After a restart the file values take effect again.

---

## File structure

```yaml
global:          # Identity, logging, and local MQTT brokers
  ...
subscriber:      # Global broker connections and topic filters
  ...
downloader:      # aria2, file naming, S3, and cache identity
  ...
cleaner:         # File retention policy
  ...
replayer:        # Historical replay service
  ...
```

Sections not listed in `global.roles` are ignored by the validator, but they must still be syntactically valid YAML.

---

## `global`

Identity and shared settings that apply to the whole instance.

---

### `global.roles`

**Required.** Comma-separated list of roles this instance will perform.

```yaml
global:
  roles: SUBSCRIBER,DOWNLOADER,CLEANER,REPLAYER,REPORTER
```

| Role | What it does |
|---|---|
| `SUBSCRIBER` | Connects to global brokers, receives WIS2 notification messages, and feeds them into the download queue. Requires a `subscriber:` section. |
| `DOWNLOADER` | Picks items from the queue, downloads the referenced files via aria2, verifies them, and publishes completion notifications to the local broker. Requires a `downloader:` section. |
| `CLEANER` | Periodically deletes cached files that have exceeded the retention period. Requires a `cleaner:` section. |
| `REPORTER` | Publishes Prometheus metrics on a local HTTP endpoint. No dedicated section required. |
| `REPLAYER` | On demand, fetches historical WIS2 messages from a remote replay service and re-injects them into the queue. Requires a `replayer:` section. |

In a single-node deployment all five roles are usually enabled. In a distributed deployment you may split them across instances — for example, run several DOWNLOADER instances while keeping only one SUBSCRIBER/CLEANER/REPORTER.

> **Note:** the validator cross-checks roles against sections. If `SUBSCRIBER` is listed but no `subscriber:` section exists, startup fails with an error.

---

### `global.worker`

**Required.** A unique name that identifies this instance within the Redis cluster.

```yaml
global:
  worker: worker3
```

The worker name is used as part of Redis key names (e.g. `wis2gc:downloader:worker3:stream_id:…`). Each running instance **must have a distinct worker name**. Reusing the same name across two live instances will cause them to compete for the same Redis keys and corrupt queue tracking.

Choose a stable, descriptive name. Renaming a worker while it has pending downloads in Redis will leave orphaned keys behind.

---

### `global.queue`

**Required.** The name of the Redis stream this instance reads from and writes to.

```yaml
global:
  queue: queue1
```

All instances that share the same `queue` participate in the same Redis consumer group and process messages from the same stream. Instances with different `queue` values operate completely independently.

In a typical deployment all instances share a single queue. Using multiple queues allows you to partition work by topic or priority, but this requires separate SUBSCRIBER instances writing to each queue.

---

### `global.log-level`

**Required. Runtime-settable.**

Controls how much the application logs to the Node-RED debug panel and the `logIO` log stream.

```yaml
global:
  log-level: info
```

| Value | What gets logged |
|---|---|
| `info` | Normal operational events: downloads started, completed, retried, WNMs published. |
| `warn` | Warnings and errors only: failures, retries, unexpected states. Less verbose. |
| `debug` | Everything, including internal state changes, Redis operations, and message payloads. Use only for troubleshooting — output is very high volume. |

> **Runtime change:** `POST /set` with `{"log-level": "debug"}` takes effect immediately. Restart resets to the file value.

---

### `global.global-cache`

**Optional. Default: `false`.**

Set to `true` when this instance is operating as a WIS2 Global Cache (as opposed to a national centre or observer node).

```yaml
global:
  global-cache: true
```

When `true`, the subscriber applies additional routing logic: messages received from the global broker that have `properties.cache = false` (the `no-cache` flag) are still forwarded to the local broker for other consumers, but are **not** sent to the downloader. This prevents the cache from storing files that data providers have explicitly marked as not to be cached globally.

When `false` (the default), the `no-cache` flag is ignored and all matching messages are downloaded.

---

### `global.test-mode-duration`

**Optional.**

When set to a positive integer, the application runs in test mode and automatically halts after the given number of seconds. Intended for CI/CD pipeline validation.

```yaml
global:
  test-mode-duration: 60
```

After the timeout the flow sets `process-mode` to `halt` and stops all subscriber and downloader activity. This is the same state as calling `POST /set` with `{"process-mode": "halt"}`.

Leave this unset in production.

---

### `global.localbroker`

**Optional** (warning if missing when SUBSCRIBER or DOWNLOADER role is active).

One or two local MQTT brokers to which the downloader publishes completed-download notifications and to which the subscriber forwards received WIS2 messages.

```yaml
global:
  localbroker:
    - broker: mqtts://emqx1:8883
      username: everyone
      password: everyone
    - broker: mqtts://emqx2:8883
      username: everyone
      password: everyone
```

The flow wires the first entry to **PUB1** and the second to **PUB2**. Both publish the same messages in parallel, providing redundancy. Only the first two entries are used; additional entries are ignored with a warning.

If omitted, completed download notifications are not published anywhere. This is valid only for pure-downloader setups where an external process reads directly from Redis.

#### `global.localbroker[*].broker`

**Required.** Connection URL for the broker.

Supported protocols:

| Protocol | Use case |
|---|---|
| `mqtt://` | Unencrypted TCP. Development/LAN only. |
| `mqtts://` | TLS-encrypted TCP. Recommended for production. |
| `ws://` | WebSocket (unencrypted). |
| `wss://` | WebSocket over TLS. |

Include the hostname and port: `mqtts://emqx1:8883`.

#### `global.localbroker[*].username` / `.password`

**Optional** (warning if missing). Credentials for the broker connection.

#### `global.localbroker[*].version`

**Optional.** MQTT protocol version: `3`, `4`, or `5`. If omitted the client negotiates with the broker. Specify `5` if you rely on MQTT 5 message properties (user properties, message expiry, etc.).

#### `global.localbroker[*].verifycert`

**Optional.** Boolean. When using `mqtts://` or `wss://`, set to `false` to disable TLS certificate verification. Useful for internal brokers with self-signed certificates.

```yaml
- broker: mqtts://internal-emqx:8883
  verifycert: false
```

> **Security note:** disabling certificate verification removes protection against man-in-the-middle attacks. Use only on isolated internal networks.

---

## `subscriber`

Settings for connecting to WIS2 Global Brokers and filtering the message stream. This section is required when `SUBSCRIBER` is in `global.roles`.

---

### `subscriber.globalbroker`

**Required.** One or two WIS2 Global Brokers to subscribe to.

```yaml
subscriber:
  globalbroker:
    - broker: mqtts://globalbroker.meteo.fr
      username: everyone
      password: everyone
    - broker: mqtts://globalbroker.inmet.gov.br
      username: everyone
      password: everyone
```

The flow connects the first entry to **GB1** and the second to **GB2**. Messages from GB1 are processed immediately; messages from GB2 are delayed by 2 seconds before deduplication. This intentional asymmetry means that when the same notification arrives on both brokers, the GB1 copy is processed and the GB2 copy is silently dropped as a duplicate. If GB1 is unavailable, GB2 takes over automatically.

Only the first two entries are used; additional entries are ignored with a warning.

The broker object fields (`broker`, `username`, `password`, `version`, `verifycert`) are identical to those described under `global.localbroker`.

---

### `subscriber.priority-global-cache`

**Optional.**

An ordered list of WIS2 Global Cache `global-cache` property values, used to rank competing download sources when the same file is announced by multiple caches.

```yaml
subscriber:
  priority-global-cache:
    - "jp-jma-global-cache"
    - "data-metoffice-noaa-global-cache"
    - "kr-kma-global-cache"
    - "cn-cma-global-cache"
```

When a WIS2 notification message arrives, its `properties.global-cache` field is checked against this list. The notification from the highest-priority matching cache is scheduled for download; lower-priority duplicates are deduped and discarded.

If a notification's cache is not in this list at all, it is still downloaded — the list only determines preference when competing sources exist simultaneously.

If this option is omitted, the first notification received for a given file wins regardless of source.

---

### `subscriber.mqtt`

The MQTT topic filter rules. **Required** (error if missing).

---

### `subscriber.mqtt.whitelist`

**Required. Runtime-settable.**

The list of MQTT topic patterns to subscribe to on the global brokers. The downloader only ever sees messages matching these patterns — nothing outside the whitelist reaches the download queue.

```yaml
subscriber:
  mqtt:
    whitelist:
      - "origin/a/wis2/jp-jma-gts-to-wis2/#"
      - "cache/a/wis2/jp-jma-gts-to-wis2/#"
```

**Topic format rules** (validated at startup):

- Level 1 must be `origin`, `cache`, `monitor`, or `+`
- Level 2 must be `a`
- Level 3 must be `wis2`
- Level 4 must be a centre identifier containing at least one hyphen (e.g. `jp-jma-gts-to-wis2`), or `+`
- Level 5 must be `data`, `metadata`, or `+`
- Subsequent levels: lowercase alphanumeric with hyphens, `+`, or `#` (only at the end)

The MQTT wildcard `#` matches all sub-levels and must appear only as the last level. The `+` wildcard matches exactly one level.

> **Runtime change:** `POST /set` with `{"whitelist": ["origin/a/wis2/+/data/#"]}` replaces the active subscription list immediately. The brokers are re-subscribed in the background. Existing replay subscriptions are preserved.

---

### `subscriber.mqtt.blacklist`

**Optional. Runtime-settable.**

Topic patterns that are filtered out **after** the whitelist. Any message whose topic matches a blacklist entry is silently dropped before reaching the download queue.

```yaml
subscriber:
  mqtt:
    blacklist:
      - "+/+/+/de-dwd-gts-to-wis2/#"
      - "origin/a/wis2/co-ideam/#"
      - "origin/a/wis2/it-meteoam/#"
      - "+/+/+/+/+/recommended/#"
```

Blacklist patterns are less strictly validated than whitelist patterns — they accept any combination of alphanumeric characters, hyphens, `/`, `+`, and `#`. This allows patterns like `+/+/+/de-dwd-gts-to-wis2/#` that do not conform to the strict WIS2 topic hierarchy (useful for blocking a centre across all topic prefixes).

**Order of operations:** the whitelist is applied first (at MQTT subscription level), then the blacklist is applied to messages that arrive. A topic can therefore match the whitelist and still be blocked by the blacklist.

If omitted, no messages are filtered out beyond what the whitelist restricts.

> **Runtime change:** `POST /set` with `{"blacklist": ["origin/a/wis2/uk-metoffice/#"]}` replaces the active blacklist immediately.

---

### `subscriber.mqtt.global-replay`

**Optional. Runtime-settable.**

When set to a non-null string, the subscriber also subscribes to the `replay/a/wis2/<value>/#` topic pattern on the global brokers. This receives replayed historical messages injected by a remote replay service.

```yaml
subscriber:
  mqtt:
    global-replay: "some-replay-uuid"
```

In normal operation this is left `null` or omitted. The Replayer role sets and clears this automatically when a replay is triggered via `/set`. You do not normally need to set it manually.

> **Cross-check:** if this is set to a non-null value but `REPLAYER` is not in `global.roles`, the validator emits a warning (the subscription will work but no replay orchestration is active).

---

## `downloader`

Settings for the aria2 download manager, file storage, and the identity the downloader uses when publishing notifications. This section is required when `DOWNLOADER` is in `global.roles`.

---

### `downloader.aria-secret`

**Required.**

The authentication token for the aria2 JSON-RPC interface. This must match the `--rpc-secret` value aria2 was started with.

```yaml
downloader:
  aria-secret: secret
```

All requests from the downloader to aria2 are authenticated with this token. If the token is wrong, downloads will fail silently with a JSON-RPC authentication error.

---

### `downloader.aria-url`

**Required.**

The WebSocket endpoint for the aria2 JSON-RPC API.

```yaml
downloader:
  aria-url: ws://aria2:6800/jsonrpc
```

Must start with `ws://` or `wss://`. In a Docker Compose deployment the hostname is the aria2 service name. Use `wss://` if aria2 is exposed behind a TLS proxy.

---

### `downloader.aria-inqueue`

**Required.**

The maximum number of downloads that can be queued or in-progress at one time. When this threshold is reached, the downloader stops pulling new messages from the Redis stream until a slot becomes available.

```yaml
downloader:
  aria-inqueue: 200
```

This is the primary backpressure knob. Setting it too high causes aria2 to be overwhelmed and individual downloads to time out. Setting it too low leaves bandwidth unused.

The right value depends on your network bandwidth and the average file size. For a high-volume global cache handling many small GTS files, values between 100 and 500 are typical.

Must be a positive integer.

---

### `downloader.cache-name`

**Optional** (warning if missing).

The WIS2 identifier for this cache, used in the `properties.global-cache` field of every notification the downloader publishes after a successful download.

```yaml
downloader:
  cache-name: "fr-meteofrance-global-cache"
```

Downstream consumers and other global caches use this value to identify the source of a cached file and to apply priority rules (see `subscriber.priority-global-cache`).

This should follow the WIS2 naming convention: `<country-code>-<organisation>-global-cache`.

---

### `downloader.download-url`

**Required.**

The public base URL at which downloaded files are accessible. This is prepended to the stored file path to form the `links[0].href` value in published notifications.

```yaml
downloader:
  download-url: "https://globalcache.meteo.fr"
```

The full published URL is constructed as `<download-url>/<path>`, where `<path>` depends on the `rename-to` setting. Make sure this URL is publicly routable and that the web server serving it has access to the aria2 download directory.

---

### `downloader.rename-to`

**Optional. Default: no renaming.**

Controls how downloaded files are named and where they are stored. This has a significant impact on the storage layout and the URLs published in outgoing notifications.

```yaml
downloader:
  rename-to: "topic"
```

| Value | Behaviour |
|---|---|
| `"topic"` | The file is saved using a path derived from the WIS2 topic. The centre ID is stripped and the remaining topic levels become the directory structure. E.g. `origin/a/wis2/jp-jma/data/core/weather/…` → `a/wis2/jp-jma/data/core/weather/…/<filename>`. |
| `"date"` | The file is saved under a date-based path: `YYYY/MM/DD/<filename>`. |
| `"s3"` | The file is uploaded to an S3-compatible object store (MinIO) instead of the local filesystem. Requires the `downloader.s3access` section. |
| `false` or omitted | The file is kept in aria2's default download directory with its original name. |

> When `rename-to` is `"s3"`, the `s3access` section is mandatory. If `s3access` is present but `rename-to` is not `"s3"`, the validator emits a warning and the S3 configuration is ignored.

---

### `downloader.s3access`

**Required when `rename-to` is `"s3"`.** Ignored otherwise.

Connection details for the S3-compatible object store.

```yaml
downloader:
  s3access:
    url: http://garage:3900
    accesskey: GKa8d15f52879e2af84ceea0b3
    secretkey: 75b14920662fc5073f34ea232a94d6964788a205320dbdefcd0a954ea0811066
    bucket: global-cache
    region: garage
```

#### `downloader.s3access.url`

**Required.** The endpoint URL of the S3 or MinIO service. Include the protocol and port: `http://garage:3900` or `https://s3.example.org`.

#### `downloader.s3access.accesskey`

**Required.** The S3 access key ID (equivalent to a username).

#### `downloader.s3access.secretkey`

**Required.** The S3 secret access key (equivalent to a password). Keep this value out of version control.

#### `downloader.s3access.bucket`

**Required.** The name of the bucket where files will be stored. The bucket must exist before the downloader starts — the application does not create it automatically.

#### `downloader.s3access.region`

**Optional** (warning if missing). The AWS-style region name for the bucket. MinIO typically uses a custom value like `garage` or `us-east-1`. If omitted, the MinIO client uses its default.

---

## `cleaner`

Controls how long downloaded files are kept in the local cache before being deleted. This section is only meaningful when `CLEANER` is in `global.roles`.

---

### `cleaner.keep-in-cache`

**Required when the `cleaner:` section is present.**

The number of seconds a downloaded file is kept before the cleaner deletes it.

```yaml
cleaner:
  keep-in-cache: 180
```

The cleaner is triggered by Redis keyspace notifications: when the Redis key associated with a download expires, the cleaner receives the event and deletes the corresponding file from disk (or removes it from S3, if applicable). This means `keep-in-cache` is not a hard deadline — the actual deletion happens within a few seconds of the Redis TTL firing.

Common values:

| Value | Retention |
|---|---|
| `180` | 3 minutes (typical for real-time global cache) |
| `3600` | 1 hour |
| `86400` | 24 hours |

Setting this to `0` or a negative number means files are deleted almost immediately after they are written — probably not what you want.

> If you are using `rename-to: s3`, the cleaner deletes objects from the S3 bucket. Make sure the S3 credentials have delete permissions.

> If the `cleaner:` section is omitted while `CLEANER` is in the roles list, the validator emits a warning and the role has no effect — files accumulate on disk indefinitely.

---

## `replayer`

Settings for the historical replay service. Required when `REPLAYER` is in `global.roles`.

---

### `replayer.global-replay-url`

**Required.**

The URL of the WIS2-GREP replay API endpoint. When a replay is triggered (via `/set`), the replayer POSTs to this URL to request historical notifications for the configured time window and topics.

```yaml
replayer:
  global-replay-url: "https://wis2-grep.weather.gc.ca/processes/wis2-grep-subscriber/execution"
```

Must be a valid `http://` or `https://` URL. The endpoint is expected to implement the WIS2-GREP OGC API Processes interface.

---

## Runtime-settable settings (`/set` API)

These settings can be changed without restarting the application by sending a POST request to the `/set` HTTP endpoint. Changes take effect immediately and are lost on restart (the file values are reloaded).

**Endpoint:** `POST http://<host>:<port>/set`  
**Content-Type:** `application/json`

You can set multiple values in a single request. The response reports which values were applied and which caused errors. If some values are invalid, the valid ones are still applied.

| Key | Type | Roles required | Description |
|---|---|---|---|
| `process-mode` | `"run"` or `"halt"` | any | `"halt"` stops all subscriber and downloader activity. `"run"` resumes it. Useful for planned maintenance without restarting. |
| `log-level` | `"info"`, `"warn"`, `"debug"` | any | Changes log verbosity immediately. |
| `whitelist` | array of topic strings | SUBSCRIBER | Replaces the active MQTT subscription list. Existing replay subscriptions are preserved. Same validation rules as in the config file. |
| `blacklist` | array of topic strings | SUBSCRIBER | Replaces the active blacklist. |
| `global-replay` | string | REPLAYER | Sets the active replay source UUID. |
| `replay` | object `{from, to}` | REPLAYER | Triggers a one-off historical replay. `from` and `to` are integers in **minutes before now**. `from` must be greater than `to`. Example: `{"from": 60, "to": 0}` replays the last hour. |

**Example — pause the downloader:**
```bash
curl -X POST http://localhost:1880/set \
  -H "Content-Type: application/json" \
  -d '{"process-mode": "halt"}'
```

**Example — trigger a 2-hour replay:**
```bash
curl -X POST http://localhost:1880/set \
  -H "Content-Type: application/json" \
  -d '{"replay": {"from": 120, "to": 0}}'
```

**Example — add a temporary blacklist entry:**
```bash
curl -X POST http://localhost:1880/set \
  -H "Content-Type: application/json" \
  -d '{"blacklist": ["origin/a/wis2/some-centre/#"]}'
```

> **GET `/get`** — returns the current value of all runtime-accessible settings. Add `?key=<name>` to query a single key.

---

## Validation summary

The validator runs at startup and classifies issues into three levels:

| Level | Meaning | Behaviour |
|---|---|---|
| **Error** | A required field is missing, has the wrong type, or an invalid value. | Startup halts. No subscribing or downloading until fixed. |
| **Warning** | A field is missing but has a safe default, or a configuration choice may cause unexpected behaviour. | Startup continues, but the warning is logged. |
| **Info** | Confirmation of an accepted value (e.g. how many whitelist topics were loaded). | Logged for reference. |

To see validation output, check the Node-RED startup logs or the Setup tab debug output.

---

## Complete annotated example

```yaml
global:
  # Roles this instance performs. All five shown here.
  roles: SUBSCRIBER,DOWNLOADER,CLEANER,REPLAYER,REPORTER

  # Unique name for this worker within the Redis cluster.
  # Must differ from every other running instance.
  worker: worker3

  # Redis stream name. Instances sharing a queue share work.
  queue: queue1

  # Log verbosity: info | warn | debug
  log-level: info

  # Set to true on a WIS2 Global Cache deployment.
  # global-cache: true

  # Local MQTT brokers for publishing download notifications (up to 2).
  localbroker:
    - broker: mqtts://emqx1:8883
      username: everyone
      password: everyone
    - broker: mqtts://emqx2:8883
      username: everyone
      password: everyone

subscriber:
  # WIS2 Global Brokers to subscribe to (up to 2).
  # The first is preferred; the second is the fallback.
  globalbroker:
    - broker: mqtts://globalbroker.meteo.fr
      username: everyone
      password: everyone
    - broker: mqtts://globalbroker.inmet.gov.br
      username: everyone
      password: everyone

  # Preferred cache sources, in order. Used to deduplicate
  # announcements from competing caches for the same file.
  priority-global-cache:
    - "jp-jma-global-cache"
    - "data-metoffice-noaa-global-cache"
    - "kr-kma-global-cache"
    - "cn-cma-global-cache"

  mqtt:
    # Only these topics are subscribed to on the global brokers.
    whitelist:
      - "origin/a/wis2/jp-jma-gts-to-wis2/#"
      - "cache/a/wis2/jp-jma-gts-to-wis2/#"

    # Messages matching these patterns are dropped after receipt.
    blacklist:
      - "+/+/+/de-dwd-gts-to-wis2/#"
      - "origin/a/wis2/co-ideam/#"
      - "+/+/+/+/+/recommended/#"

downloader:
  # aria2 RPC token — must match aria2's --rpc-secret.
  aria-secret: secret

  # aria2 JSON-RPC WebSocket endpoint.
  aria-url: ws://aria2:6800/jsonrpc

  # Maximum concurrent downloads. Tune to your bandwidth.
  aria-inqueue: 200

  # This cache's WIS2 identifier, published in outgoing WNMs.
  cache-name: "fr-meteofrance-global-cache"

  # Public base URL where downloaded files are served.
  download-url: "https://globalcache.meteo.fr"

  # File naming: "topic" | "date" | "s3" | false
  rename-to: "topic"

  # Required only when rename-to is "s3".
  # s3access:
  #   url: http://garage:3900
  #   accesskey: <access-key>
  #   secretkey: <secret-key>
  #   bucket: global-cache
  #   region: garage

cleaner:
  # Delete files after this many seconds (180 = 3 minutes).
  keep-in-cache: 180

replayer:
  # WIS2-GREP OGC API endpoint for historical replay requests.
  global-replay-url: "https://wis2-grep.weather.gc.ca/processes/wis2-grep-subscriber/execution"
```
