# Repository context

This is the OpenHVX backend repository. Runtime services live under `src/`:
`service-auth`, `service-api-gateway`, `service-controller`, and `service-ws-broker`.
The Hyper-V agent and deployment automation belong to separate repositories.

Start with [README.md](README.md). Maintain current behavior in the focused guides
under `docs/`; keep environment variable details in `.env.<service>.example`.
Documentation is written in English with lowercase, topic-based filenames.

Core constraints:

- HTTP and AMQP adapters call shared operation use cases in the controller.
- MongoDB replica-set transactions protect task, quota, ownership, and delivery state.
- Accepted commands retain their identity across retries. Agents require protocol v2.
- Unknown host outcomes preserve holds and locks until conclusive reconciliation.
- Console sockets stay local to their broker; ownership is coordinated in MongoDB.
- K3s provisioning and environment-specific settings belong to `deployment`.
- `compose.yaml` is the optional local stack; `compose.podman.yaml` only adapts its socket.

See [development checks](docs/development.md#checks) for reproducible validation
and [known limitations](docs/architecture.md#known-limitations) for unfinished work.
