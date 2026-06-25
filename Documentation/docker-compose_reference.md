# WIS2 Global Cache Downloader — Docker Compose Reference

This document explains every entry in the worker service template. Each worker instance in a multi-worker deployment is a copy of this template with different placeholder values.

---

## Generic template

```yaml
services:
  <WORKER_NAME>:
    container_name: <WORKER_NAME>
    image: golfvert/wis2gc:<TAG>
    labels:
      - traefik.enable=true
      - traefik.http.routers.<WORKER_NAME>.entrypoints=websecure
      - traefik.http.routers.<WORKER_NAME>.service=<WORKER_NAME>-svc
      - traefik.http.routers.<WORKER_NAME>.middlewares=<WORKER_NAME>-strip,auth@file
      - traefik.http.routers.<WORKER_NAME>.rule=(Host(`<HOSTNAME_1>`) && PathPrefix(`/<WORKER_NAME>/`)
      - "traefik.http.middlewares.<WORKER_NAME>-strip.stripprefix.prefixes=/<WORKER_NAME>"
      - traefik.http.services.<WORKER_NAME>-svc.loadbalancer.server.port=1880
      - traefik.http.services.<WORKER_NAME>-svc.loadbalancer.server.scheme=http
      - traefik.http.routers.<WORKER_NAME>.tls=true
    user: <UID>:<GID>
    environment:
      - TZ=<TIMEZONE>
      - CONFIGURATION=/setup/<CONFIGURATION_FILE>.yml
      - REDIS_URL=[{"host":"<REDIS_HOST_1>","port":<REDIS_PORT_1>},{"host":"<REDIS_HOST_2>","port":<REDIS_PORT_2>},{"host":"<REDIS_HOST_3>","port":<REDIS_PORT_3>}]
    networks:
      - <NETWORK_NAME>
    volumes:
      - <SETUP_DIR>:/setup
      - <DOWNLOADS_DIR>:/downloads
      - <LOGS_DIR>:/logs
    restart: unless-stopped

networks:
  <NETWORK_NAME>:
    external: true
```

---

## Placeholder reference

| Placeholder | Example | Description |
|---|---|---|
| `<WORKER_NAME>` | `worker` | Unique name for this worker. Used everywhere in the file — service name, container name, Traefik router/middleware/service names, and URL prefix. Must be distinct across all workers in the stack. |
| `<TAG>` | `2026.6.2` | Docker image tag, following the `YYYY.M.v` versioning scheme. Check on hub.docker.com for the most recent tag. All workers in a deployment should run the same tag. |
| `<HOSTNAME_1>` | `cache.example.com` | Public hostname through which this worker is reachable via Traefik. |
| `<UID>:<GID>` | `1002:1002` | Unix user and group IDs the container process runs as. Must have read/write access to the host directories mounted as volumes. Using a non-root user is required for security. |
| `<TIMEZONE>` | `Europe/Paris` | POSIX timezone name. Sets the `TZ` environment variable inside the container, which affects log timestamps and any time-based logic in Node-RED. |
| `<CONFIGURATION_FILE>` | `configuration-worker` | Filename (without path) of the `configuration.yml` for this worker, located in `<SETUP_DIR>` on the host. Each worker has its own configuration file with its own `worker` name and roles. |
| `<REDIS_HOST_x>` | `redis-1`, `redis-2`, `redis-3` | Hostnames of the Redis Cluster nodes. Must be reachable from within the container on the Docker network. Three nodes is the minimum for a Redis Cluster. |
| `<REDIS_PORT_x>` | `6379` | Port for each Redis node. Typically 6379 for all nodes unless custom ports are configured. |
| `<NETWORK_NAME>` | `mynet` | Name of the external Docker network shared by all services (workers, Redis, aria2, Traefik). Must be created separately (`docker network create <NETWORK_NAME>`) before starting the stack. |
| `<SETUP_DIR>` | `/home/global-cache/setup` | Host directory containing all `configuration-*.yml` files. Mounted read-only into the container at `/setup`. Shared across all workers — each worker reads its own file via `CONFIGURATION`. |
| `<DOWNLOADS_DIR>` | `/home/global-cache/aria2` | Host directory where aria2 writes downloaded files for this worker. Each worker must have its own dedicated downloads directory to avoid filename collisions. Mounted at `/downloads`. |
| `<LOGS_DIR>` | `/home/global-cache/files` | Host directory for Node-RED logs (logIO output). Each worker should have its own log directory. Mounted at `/logs`. |

---

## Entry-by-entry explanation

### `container_name`

```yaml
container_name: <WORKER_NAME>
```

Sets a fixed name for the Docker container instead of the auto-generated one. Makes it easy to identify and manage with `docker logs <WORKER_NAME>`, `docker restart <WORKER_NAME>`, etc. Should match the service name.

---

### `image`

```yaml
image: golfvert/wis2gc:<TAG>
```

The Docker image to run. `golfvert/wis2gc` is the published image for this application. The tag pins the exact version. Changing the tag and recreating the container is how you upgrade.

---

### `labels` — Traefik integration

All `traefik.*` labels are instructions to the Traefik reverse proxy, which reads container labels from the Docker socket to configure itself dynamically. No Traefik config files need to be edited when adding a new worker.

```yaml
- traefik.enable=true
```
Tells Traefik to include this container in its routing. Without this, Traefik ignores the container entirely.

```yaml
- traefik.http.routers.<WORKER_NAME>.entrypoints=websecure
```
Binds this router to the `websecure` entrypoint (HTTPS, typically port 443). Traefik must have a `websecure` entrypoint defined in its static configuration.

```yaml
- traefik.http.routers.<WORKER_NAME>.service=<WORKER_NAME>-svc
```
Links this router to its backend service definition (see the `loadbalancer` labels below).

```yaml
- traefik.http.routers.<WORKER_NAME>.middlewares=<WORKER_NAME>-strip,auth@file
```
Applies two middlewares in sequence:
- `<WORKER_NAME>-strip` — strips the path prefix before forwarding to the container (see below).
- `auth@file` — authentication middleware defined in a Traefik file provider (e.g. basic auth). Protects the Node-RED UI and API endpoints.

```yaml
- traefik.http.routers.<WORKER_NAME>.rule=(Host(`<HOSTNAME_1>`) || Host(`<HOSTNAME_2>`)) && PathPrefix(`/<WORKER_NAME>/`)
```
The routing rule. A request must match one of the two hostnames AND have a path starting with `/<WORKER_NAME>/`. This allows multiple workers to share the same hostnames, each isolated by their path prefix (e.g. `/worker-one/`, `/worker/`).

```yaml
- "traefik.http.middlewares.<WORKER_NAME>-strip.stripprefix.prefixes=/<WORKER_NAME>"
```
Defines the strip-prefix middleware. Before forwarding the request to Node-RED, Traefik removes the `/<WORKER_NAME>` prefix. Node-RED receives the request at `/` rather than `/<WORKER_NAME>/`, so it does not need to know about the prefix. The label is quoted because of the dot in the middleware name.

```yaml
- traefik.http.services.<WORKER_NAME>-svc.loadbalancer.server.port=1880
- traefik.http.services.<WORKER_NAME>-svc.loadbalancer.server.scheme=http
```
Defines the backend: traffic is forwarded to port `1880` on the container (the Node-RED HTTP port) over plain HTTP (TLS is terminated at Traefik).

```yaml
- traefik.http.routers.<WORKER_NAME>.tls=true
```
Enables TLS on this router. Traefik handles certificate management (e.g. via Let's Encrypt) and terminates TLS before forwarding to the container.

---

### `user`

```yaml
user: <UID>:<GID>
```

Runs the container process as the specified Unix user and group instead of root. The host directories mounted as volumes must be owned by (or writable by) this user. Using a dedicated non-root user limits the blast radius if the container is compromised.

---

### `environment`

```yaml
- TZ=<TIMEZONE>
```
Sets the container timezone. Affects all timestamp formatting inside Node-RED — logs, scheduled tasks, and any date-based file naming (`rename-to: date`).

```yaml
- CONFIGURATION=/setup/<CONFIGURATION_FILE>.yml
```
Tells the application which configuration file to load at startup. The path is inside the container (`/setup/` maps to `<SETUP_DIR>` on the host). Each worker points to its own file.

```yaml
- REDIS_URL=[{"host":"<REDIS_HOST_1>","port":<REDIS_PORT_1>},...]
```
Connection details for the Redis Cluster, as a JSON array of node descriptors. The application uses this to bootstrap the cluster client (ioredis Cluster mode). All nodes in the cluster should be listed — the client uses this list to discover the full topology. 

---

### `networks`

```yaml
networks:
  - <NETWORK_NAME>
```

Attaches the container to the shared external Docker network. All services that need to communicate (workers, Redis nodes, aria2, Traefik) must be on this network. The network is declared as `external`, meaning Docker Compose does not create or manage it — it must already exist.

---

### `volumes`

```yaml
- <SETUP_DIR>:/setup
```
Mounts the host directory containing configuration files into the container at `/setup`. All workers can share the same host directory; each reads only its own file via the `CONFIGURATION` environment variable.

```yaml
- <DOWNLOADS_DIR>:/downloads
```
Mounts the download directory. aria2 writes files here; the Node-RED flow reads them for hash verification, renaming, and S3 upload. Each worker must have a **separate** host path to avoid one worker overwriting another's in-progress downloads.

```yaml
- <LOGS_DIR>:/logs
```
Mounts the log output directory. Node-RED's logIO framework writes structured logs here. Each worker should have its own log directory to keep output separate.

---

### `restart`

```yaml
restart: unless-stopped
```
Docker automatically restarts the container if it exits (crash, OOM kill, etc.), unless it was explicitly stopped with `docker stop`. Suitable for production — ensures the worker recovers from transient failures without manual intervention.

---

### `networks` (top-level)

```yaml
networks:
  <NETWORK_NAME>:
    external: true
```

Declares that `<NETWORK_NAME>` is an externally managed network. Docker Compose will not create or delete it. Create it once with:

```bash
docker network create <NETWORK_NAME>
```

Using an external network allows containers ( aria2 instances, Traefik... ) to communicate the container names on this docker bridge network. 