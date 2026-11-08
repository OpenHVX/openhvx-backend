# Development

Use Node.js 22 and npm. The [configuration guide](configuration.md) describes
runtime variables; the service `.env.*.example` files are their detailed contracts.
K3s lab and production deployment automation belongs to `deployment`.

## Install and build

From the repository root:

```bash
for service in src/service-auth src/service-api-gateway src/service-controller src/service-ws-broker; do
  npm ci --prefix "$service"
  npm run build --prefix "$service"
done
```

Create missing local `.env` profiles from the examples, retaining existing local
secrets. Set matching keys in the services that share them. A random secret can be
generated with `openssl rand -hex 32`. Keep real profiles and keys out of Git.

## Optional local stack

| File | Purpose | Invocation |
| --- | --- | --- |
| [`compose.yaml`](../compose.yaml) | Complete local Docker stack | `docker compose -f compose.yaml up --build -d` |
| [`compose.podman.yaml`](../compose.podman.yaml) | Podman socket override for the same stack | `podman compose -f compose.yaml -f compose.podman.yaml up --build -d` |

The base contains Traefik, a single-member MongoDB replica set, RabbitMQ, and the four backend services.
It provides transactions for development, not infrastructure HA.

Before starting:

- Populate the root `.env` and the four service profiles.
- Provide `.traefik/certs/app.pem` and `app-key.pem`, covering
  `api.openhvx.local`, `admin-api.openhvx.local`, `console.openhvx.local`, and
  `ws.openhvx.local`. Configure DNS/hosts resolution from the browser and agents.
- Have the container runtime API socket available to Traefik. The Podman override
  defaults to the rootful `/run/podman/podman.sock`; set `PODMAN_SOCKET_PATH` for
  another socket. Rootless low-port and networking setup is host-specific.

The RabbitMQ management UI binds to `127.0.0.1:15672`. MongoDB and AMQP are not
published to the host. External agents need explicitly configured, restricted broker
connectivity; native services need separately reachable dependencies.

Validate the rendered configuration before starting:

```bash
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml -f compose.podman.yaml config --quiet
```

Stop the stack with the same file arguments and `down`. Named database volumes
remain unless explicitly removed. Podman users need a Compose provider for
`podman compose`; use the same ordered file arguments with that provider.

## Native processes

After building, load the chosen profile before imports. From the root, in separate
terminals, run:

```bash
node --env-file=.env.auth src/service-auth/dist/app.js
node --env-file=.env.gateway src/service-api-gateway/dist/app.js
node --env-file=.env.controller src/service-controller/dist/app.js
node --env-file=.env.ws src/service-ws-broker/dist/app.js
```

Adjust URIs to dependencies reachable from the host. Exported shell variables take
precedence over `--env-file`; Compose-only root values are not injected here.

## Checks

Run `npm run lint`, `npm run build`, and `npm audit --omit=dev` in each service.
Then run the controller suites:

```bash
npm test --prefix src/service-controller
npm run test:integration --prefix src/service-controller
```

Integration tests download MongoDB 7.0.24 on first use and start disposable replica
sets and service processes. `AMQP_INTEGRATION_URL` enables real RabbitMQ tests;
otherwise that test is explicitly skipped. The cross-language test uses Go and a
neighboring `openhvx-agent/src` checkout, or `AGENT_SOURCE_DIR`; it is skipped locally when
the agent source is absent and no explicit path is configured. In CI, or with an
explicit `AGENT_SOURCE_DIR`, missing sources fail the test. Host effects in these tests are simulated.

The backend CI checks out the compatible agent commit pinned in
[the workflow](../.github/workflows/backend.yml), installs Go, and runs compilation,
audits, and tests with RabbitMQ. Update that pin with coordinated protocol changes;
the referenced agent commit must be available on GitHub before running CI. A successful local
run does not imply that the remote workflow or real Hyper-V tests have run.

## Migrations and replay

Back up MongoDB and drain admissions/old consumers before schema or protocol changes.
Do not overlap old and v2 agents/controllers. Use a replica set. From a built root
checkout with a profile pointing at the intended database, inspect first:

```bash
node --env-file=.env.controller src/service-controller/dist/scripts/dedupeInventories.js
node --env-file=.env.controller src/service-controller/dist/scripts/migrateDistributed.js
```

After reviewing the report and backup, repeat each command with `--apply`.
Deduplication retains the newest inventories/heartbeats before creating unique
indexes. Distributed migration removes legacy lock TTLs, creates operation indexes,
and records the v2 migration. Ambiguous holds, orphan operations, and active legacy
protocol tasks must be reconciled before applying it or starting v2 workers.

Drain and retire the old RabbitMQ bindings/queues without discarding their backlog.
Current queues are `results.controller.v2`, `agent.heartbeats.v2`,
`agent.inventories.v2`, and `storage.inventories.v2`. Invalid results and telemetry
go to `results.controller.v2.invalid` and `telemetry.invalid.v2`.

After investigating a quarantined publication, set `EVENT_ID` to its identity and
inspect a replay with:

```bash
node --env-file=.env.controller src/service-controller/dist/scripts/replayOutbox.js --event-id="$EVENT_ID"
```

Add `--apply` to rearm the same event. Terminal tasks and console tickets cannot be
replayed through this command. Quarantine or expiry never releases an ambiguous
operation's holds or locks. Changing queue types or rolling back from v2 requires
coordinated maintenance and reconciliation, not just replacing a binary.
