# Infrastructure

The gateway runs from the workspace so TypeScript changes are hot-reloaded. Persistence is a local Turso SQLite file via `@doot/db` (`npm run db:migrate`); it is not on the live caption path yet.

Production deployment is intentionally left open: the gateway is stateless per WebSocket connection, so it can run behind a WebSocket-aware load balancer once session persistence or a shared stream broker is added.
