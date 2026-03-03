FROM alpine:3.23.3 AS base

RUN apk add --no-cache \
        nodejs \
        ca-certificates \
        npm && \
    mkdir -p /usr/src/node-red /data && \
    adduser -h /usr/src/node-red -D -H node-red -u 1000 && \
    chmod -R 0777 /usr/src/node-red /data

FROM nodered/node-red:4.1.4-minimal AS build
COPY package.json .
RUN npm install \
        --unsafe-perm --no-update-notifier \
        --no-audit --only=production

FROM base AS prod

# ❗ DO NOT COPY /data from build stage — it pollutes ownership
WORKDIR /usr/src/node-red

COPY settings.js /data/settings.js
COPY flows.json  /data/flows.json

# Copy Node-RED runtime only
COPY --from=build /usr/src/node-red/ /usr/src/node-red/

# Ensure /data is writable by ANY runtime UID
RUN chmod -R 0777 /data

USER node-red

CMD ["npm", "start", "--cache", "/data/.npm", "--", "--userDir", "/data"]

