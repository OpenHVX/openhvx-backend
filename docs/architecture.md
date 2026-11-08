# Architecture

OpenHVX separates authentication, API access, orchestration, and console transport.
Deployment automation lives in the separate `deployment` repository. Backend
processes consume environment variables directly in K3s.

## Services

| Service | Responsibility | Dependencies |
| --- | --- | --- |
| `service-auth` | Admin/tenant login, JWT introspection, PATs, account bootstrap | MongoDB auth database |
| `service-api-gateway` | Authentication, policies, HTTP proxying, browser WebSocket entry point | Auth, controller, broker |
| `service-controller` | Tenants, quotas, resources, tasks, inventory, image catalog | MongoDB replica set, RabbitMQ |
| `service-ws-broker` | Agent/browser socket pairing and exclusive console ownership | Shared application MongoDB database, peer brokers |

Clients use the gateway; the controller and auth service remain internal. The
gateway signs short-lived controller identities bound to actor, tenant, mode,
method, path, and body. Injected tenant/admin headers alone are not trusted.

Controllers share persistent operation state. Agents consume host-specific queues
and publish results and telemetry. Submission and result application are separate
use cases under `services/operations/`; their MongoDB writes share a transaction.
See the [task protocol](task-protocol.md) for the consistency boundaries.

The image catalog is read from storage inventory in MongoDB. The controller does
not read a local `/share` image index.

## Console routing

A MongoDB lease coordinates one active console per tenant/VM across brokers.
Each broker has a distinct `BROKER_ID`, a process incarnation, and the same
`BROKER_PEERS` allowlist. The first accepted connection acquires ownership; another
broker validates the other side's ticket and proxies to the owner. No cookie/IP
affinity is required, and clients cannot choose arbitrary proxy destinations.

Each ticket side is consumed once. Leases use MongoDB time; a conservative local
monotonic deadline fences data forwarding after a pause or ownership loss. A broker
that cannot verify ownership closes the tunnel. Slow peers have bounded buffering.
SIGTERM stops admission and closes local tunnels.

A broker failure may interrupt a console. Recovery opens a new tunnel with fresh
tickets after lease expiry; active sockets are not migrated. Peer discovery is a
configured allowlist, not a dynamic registry.

## Health and shutdown

All services expose `/healthz` for process liveness and `/readyz` for dependency
readiness. Auth checks MongoDB; controller checks MongoDB/AMQP; broker checks its
ownership store; gateway checks auth/controller. Services handle SIGTERM.

## Known limitations

- Real Windows/Hyper-V crash scenarios, MongoDB/RabbitMQ elections, network
  partitions, and K3s ingress/volume behavior still need lab validation.
- Some host outcomes cannot be proved automatically, notably partial creation or
  an ambiguous restart. They remain `reconciling` rather than repeating the effect.
- Other agents, including storage, must implement protocol v2 before accepting new tasks.
- JWTs have no individual-token blacklist or overlapping-key rotation. PAT revocation
  and active-user checks are persistent; the gateway does not cache introspection.
- Gateway rate limits are per instance. Several auth files still use `@ts-nocheck`.
- Environment validation is not yet centralized for every optional value.
- Tenant networking and multi-step VM/storage/network sagas remain future work;
  no network provider or routing topology is selected here.

Local tests exercise real MongoDB replica sets, HTTP processes, Go journal crashes,
and simulated Hyper-V cmdlets. These checks do not establish full production HA.
