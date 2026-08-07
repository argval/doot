# Infrastructure

`docker compose up -d postgres` starts the local PostgreSQL dependency. The gateway itself runs from the workspace so TypeScript changes are hot-reloaded.

Production deployment is intentionally left open: the gateway is stateless per WebSocket connection, so it can run behind a WebSocket-aware load balancer once session persistence or a shared stream broker is added.
