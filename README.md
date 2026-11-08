# OpenHVX Backend

OpenHVX is an open-source Hyper-V control plane. This repository contains the
API gateway, authentication service, controller, and WebSocket broker.

**Status:** active development. Distributed task and console behavior is tested
locally; production readiness still requires real Hyper-V and cluster failure tests.

K3s is the deployment target. The separate `deployment` repository owns lab and
production infrastructure, manifests, ingress, storage, and secret distribution.
Compose is retained only as an optional local development stack.

## Documentation

| Guide | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) | Service boundaries, console routing, and current limitations |
| [Configuration](docs/configuration.md) | Environment contracts and shared secrets |
| [Development](docs/development.md) | Local setup, Compose, checks, and migrations |
| [Task protocol](docs/task-protocol.md) | Idempotency, transactions, agent journaling, and recovery |
| [API](docs/api.md) | Public routes and task requests |

## Local development

Use Node.js 22. Each service has a `.env.<service>.example` documenting its runtime
variables. Keep real `.env` files out of Git.

Follow the [local setup prerequisites](docs/development.md#optional-local-stack),
then use the single stack definition:

```bash
# Docker
docker compose -f compose.yaml up --build -d

# Podman: use the same base with the socket override
podman compose -f compose.yaml -f compose.podman.yaml up --build -d
```

`compose.podman.yaml` is an override, not a standalone stack.

## License

[Apache-2.0](LICENCE.md).
