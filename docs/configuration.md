# Configuration

K3s injects environment variables into each process. ConfigMaps, Secrets, and
lab/production values are owned by the separate `deployment` repository; pods do
not need mounted `.env` files.

## Service contracts

| Service | Versioned example | Ignored local profile |
| --- | --- | --- |
| Auth | [`.env.auth.example`](../.env.auth.example) | `.env.auth` |
| Gateway | [`.env.gateway.example`](../.env.gateway.example) | `.env.gateway` |
| Controller | [`.env.controller.example`](../.env.controller.example) | `.env.controller` |
| Broker | [`.env.ws.example`](../.env.ws.example) | `.env.ws` |

The examples list variables consumed by the code, with comments for required and
optional settings. Secrets are blank and must be supplied. Their production mode
is intentional; copying them unchanged does not create a runnable environment.
Do not duplicate the variable catalog in other guides.

## Shared values

| Variable | Consumers | Requirement |
| --- | --- | --- |
| `INTERNAL_API_SECRET` | Gateway, all controllers | Same random secret, at least 32 characters |
| `JWT_AGENT_SECRET` | Controller, all brokers | Matching ticket signing/verification key |
| `JWT_BROWSER_SECRET` | Controller, all brokers | Matching browser ticket key, distinct from the agent key |
| `OUTBOX_ENCRYPTION_KEY` | All controllers | Stable key, at least 32 characters; retain for restores |
| `MONGO_URL` | Controller, brokers | Same application database and replica set; auth uses a separate database |
| `BROKER_PEERS` | All brokers | Same allowlist of broker IDs and internal URLs |
| `BROKER_ID` | Each broker | Distinct identity per replica |

When `OUTBOX_ENCRYPTION_KEY` is omitted, encryption derives from
`INTERNAL_API_SECRET`. Changing the effective encryption key makes existing outbox
and idempotency records unreadable. Preserve it through rotation and restoration.
Auth signing keys belong only to auth; gateway/controller identities and console
tickets use their own keys.

`PUBLIC_WS_BASE` is the browser-facing console URL. `BROKER_WS_BASE` is the
agent-facing WebSocket URL. `BROKER_PEERS` contains internal broker URLs, such as
stable StatefulSet DNS names. Browser `WS_ORIGINS` contains page origins, not
WebSocket URLs.

Use an authenticated replica-set MongoDB URI and authenticated RabbitMQ URI for
production. Percent-encode credentials in URI components. `AMQP_QUEUE_TYPE` must
match agent declarations and existing queues; changing classic/quorum type requires
a broker migration. New tasks require the `task.protocol.v2` agent capability.

## Local profiles and Compose

[`.env.example`](../.env.example) contains only local Compose interpolation inputs.
The root `.env` is not an implicit shared runtime configuration for K3s or native
processes.

Compose loads each service profile with `env_file`, then applies `environment`
overrides. The local base sets controller/broker MongoDB URIs, derives controller
`RMQ_URL` from the RabbitMQ account, injects the root internal secret, and sets the
single broker's ID/peer map. The controller defaults to development mode locally.
The Podman override only changes Traefik's socket access.

Obsolete controller variables are not supported: `MONGO_DB`, `HEARTBEATS_QUEUE`,
`HEARTBEATS_TTL_MS`, `HEARTBEATS_MAX_LENGTH`, `INVENTORIES_QUEUE`, `RESULTS_QUEUE`,
`RESULTS_BINDING`, and `IMAGES_INDEX_PATH`. Queue names and telemetry retention are
currently defined in code. `MONGO_DB` is an optional auth-only override;
`AUTH_ADMIN_API_KEY` belongs to an auth middleware that is not mounted.
