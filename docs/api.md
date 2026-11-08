# API overview

Clients use the gateway on tenant (`api.*`) or admin (`admin-api.*`) hosts. Tenant
and admin tokens are separate. Optional Swagger UI is served at `/docs` when
`ENABLE_APIDOCS=true`; gateway route definitions contain the full policy checks.

## Authentication

Both `/api/v1/tenant/auth` and `/api/v1/admin/auth` expose:

| Method | Suffix | Purpose |
| --- | --- | --- |
| POST | `/login` | Exchange email/password for an access token |
| GET | `/me`, `/userinfo` | Read the authenticated account/claims |
| POST | `/introspect` | Inspect a token's active state |
| POST / GET | `/pats` | Create/list personal access tokens |
| DELETE | `/pats/{patId}` | Revoke a personal access token |
| POST | `/register` | Provision accounts under the configured bootstrap/authorization rules |

Registration requires passwords of at least 12 characters. Admin bootstrap is
controlled by `REGISTER_ENABLED` and `REGISTER_API_KEY`. Tenant registration needs
the configured registration key or an authorized bearer. Admins can also provision
tenant accounts through `/api/v1/admin/auth/tenant/register`.

## Tasks

`POST /api/v1/tenant/tasks` submits a task for the token's tenant. Admin submissions
use `/api/v1/admin/tasks` and include `tenantId`. Both require `Idempotency-Key`:

```http
POST /api/v1/tenant/tasks
Host: api.openhvx.local
Authorization: Bearer <tenant-token>
Idempotency-Key: <stable-command-key>
Content-Type: application/json

{
  "action": "vm.power",
  "target": {
    "kind": "vm",
    "agentId": "host-1",
    "refId": "11111111-1111-4111-8111-111111111111"
  },
  "data": { "state": "start" }
}
```

Use an actual GUID returned by resource inventory. HTTP 202 follows durable
acceptance and includes `taskId` and `statusUrl`; it does not mean host success.
Retry with the same key and content. Reusing the key with different content returns
409. `GET /api/v1/{tenant|admin}/tasks/{taskId}` separates execution status from
outbox delivery. States are `queued`, `sent`, `reconciling`, `done`, and `error`.
See the [task protocol](task-protocol.md) for outcomes and recovery.

## Resources and administration

Tenant routes provide resource lists, image catalog/details/resolution, and metrics
under `/api/v1/tenant`. Admin routes under `/api/v1/admin` provide:

- Tenant creation, lookup, update, and deletion at `/tenants` and `/tenants/{tenantId}`.
- Agent lists, status, and inventory at `/agents` and `/agents/{agentId}/{status|inventory}`.
- Resource lists/claims at `/tenants/{tenantId}/resources` and `/resources/claim` beneath
  that tenant; unclaim at `/tenants/{tenantId}/resources/{resourceId}`.
- Unassigned inventory at `/resources/unassigned`.
- Quota limits and reconciliation at `/tenants/{tenantId}/quotas` and its subroutes.
- Image catalog and metrics endpoints.

Batch claims accept `{kind, agentId, refIds, ha?}`. HTTP 200 means no conflicts;
207 returns per-resource `claimed`, `already_claimed`, `conflict`, or `not_found`
outcomes. Unclaim and tenant deletion reject unresolved work. Quota reserve/release
routes operate on valid persisted tasks; they do not bypass task admission or resolve
an unknown host effect. Inventory recalculation requires sufficiently fresh snapshots.

## Consoles and health

Console task responses return a ticketed browser WebSocket URL. Agents use the paired
agent ticket. A ticket is consumed once per side; a failed console opens a new tunnel
with a new task/key. Broker routing is described in [architecture](architecture.md).

Each service exposes `/healthz` and `/readyz`. The gateway's root health endpoint
reports its own process; `/api/v1/healthz` is the controller proxy route.
