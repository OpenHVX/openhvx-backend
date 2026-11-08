# Task protocol

Protocol v2 joins HTTP admission, durable backend state, RabbitMQ delivery, and the
Hyper-V agent's local journal. Backend and agent must be updated together after
draining older operations. All new commands require `task.protocol.v2` capability.

## Consistency boundaries

| Boundary | Invariant |
| --- | --- |
| Client → HTTP | A stable `Idempotency-Key`, scoped to tenant/actor/mode/action, returns the same operation; changed content returns 409 |
| Admission → MongoDB | One transaction acquires request identity and persists task, response, hold/counter, ownership guards, locks, and outbox |
| Outbox → RabbitMQ | Confirms, mandatory routing, renewable claims, and retry backoff; retries retain the same operation and event identity |
| Delivery → agent | Verify immutable command and destination, then commit journal intent before invoking PowerShell |
| Host → result | Persist a stable result/event before publishing; confirm delivery before acknowledging the command |
| Result → backend | Inbox, task transition, quota/allocation, associations, and lock release commit together before acknowledgment |

ACID applies within MongoDB transactions and within the agent's bbolt journal.
Hyper-V effects are outside both transactions. Deduplication and read-only
reconciliation close retry windows; an uncertain effect is not executed again.
The client must retain its key across network retries of the same user intention.

## Immutable command and result

A command carries `contractVersion: 2`, `taskId == operationId`, `eventId`, and:

- `commandBody`: canonical JSON for `{operationId, tenantId, agentId, action, data}`;
- `commandFingerprint`: SHA-256 of that string's UTF-8 bytes.

The agent executes only the validated inner command. Reusing an operation ID with
a different fingerprint is rejected. Shared TypeScript/Go fixtures verify byte
compatibility. The hash identifies content; producer authentication and broker
permissions remain transport responsibilities.

Results bind to the same operation, agent, tenant, action, and command fingerprint.
Each observation has a persisted `eventId` and increasing `sequence`.

| Host outcome | Task state | Reservation |
| --- | --- | --- |
| `applied` (`ok: true`) | `done` | Consumed; effects and locks resolved atomically |
| `not_applied` (`ok: false`) | `error` | Released after definitive no-effect rejection |
| `unknown` (`ok: false`) | `reconciling` | Hold and locks retained |

A script exception or crash does not prove absence of effects. Older observations
cannot regress state; inconsistent identities, sequences, or terminal results go
to quarantine. A missing/inconsistent hold aborts the whole result transaction.
A lost channel after commit causes safe redelivery rather than another business effect.

## Host journal and recovery

The agent journal uses fsync and an exclusive file lock. Configure an absolute,
persistent `journalPath`, or an absolute `basePath` for the default
`<basePath>/agent-state/operations.db`. Bind it to one host identity, protect its
Windows ACLs, and retain it through backups/restores. Clearing it or reusing an
agentId with an empty journal removes the evidence needed to prevent duplicate effects.

Known commands replay their stored result. An interrupted command is observed,
never sent through the effectful handler again. Recovery currently proves:

- VM creation from a final operation/fingerprint marker after required setup;
- VM deletion from GUID absence after a successful host query;
- power start/stop from the desired state of that GUID.

A partial creation, ambiguous restart, lost console, or other unproved action can
remain `reconciling`. Additional observation/compensation adapters or operator
investigation are needed; there is no automatic "clear locks and retry" path.
Running alone cannot prove that a restart occurred.

The journal stores recovery identifiers and results rather than full commands
containing tickets or cloud-init. Results still require protected storage. Reconciled
results have a durable local outbox, so losing their publisher does not lose them.
No operation identity expires automatically.

PowerShell scripts are invoked once, not retried based on stderr. VM mutations use
selected VM/component objects instead of rediscovering by display name. Failed reads
are not treated as absence. Delete/power use canonical Hyper-V GUIDs; conflicting
`data` aliases are rejected. Host path components and directory boundaries are validated.

## Quotas and ownership

A resource retains its reserved allocation. Deletion reverses it once, after a
conclusive result; attaching an already charged disk does not charge it again.
Dynamic memory reserves its declared maximum, retained during recalculation.
Older resources without allocation metadata require fresh-inventory reconciliation.

`vm.create` requires RAM, defaults CPU to 1, and requires `max_ram >= ram` and
`min_ram <= ram` for dynamic memory. Invalid requests fail before durable acceptance.
Pending operations prevent tenant deletion and resource unclaim, even after lock
expiry. Claims retain their explicit per-resource partial-success contract.

## Compatibility and validation

The controller refuses active legacy operations at startup; migration preflight
also reports them. The new agent quarantines non-v2 commands with confirmation
before acknowledging them. Backend and agent queue types must match. See
[development](development.md#migrations-and-replay) for migration and replay commands.
Other execution agents, including storage, must implement v2 before receiving tasks.

Backend tests use MongoDB replica sets and a real Go test process to exercise a crash
after a simulated host effect, replay, uncertainty, and final application. Agent tests
use `go test -race`, process exits, and PowerShell with simulated Hyper-V cmdlets.
Real RabbitMQ tests require `AMQP_INTEGRATION_URL`; real Windows/Hyper-V and cluster
failure validation remains necessary. See the separate agent repository's journal
and recovery guide for its setup and test commands.
