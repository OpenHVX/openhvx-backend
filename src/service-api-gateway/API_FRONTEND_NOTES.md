

# OpenHVX API Gateway – routes & payloads (frontend)

## Context / new workflow
- We switched to a disk-first model: you must create a disk before creating a VM.
- In `TenantResources.vue`, we now need a storage table listing disks with attachment status (attached/mismatch/unattached) and actions to create/delete disks.
- VM creation now requires a **diskId** (mandatory) instead of an optional imageId; pass it in the task payload.
- For VM creation UI, add a dropdown populated with available disks (storage kind) that are **unattached** for the current tenant.

External paths (after Traefik host rules). All responses use the envelope  
`{ schemaVersion: "1.0.0", scope: "admin"|"tenant", kind, success: true, ...payload }`.

## Admin API
### Tenants
- `GET /api/v1/admin/tenants` → data: `[{ tenantId, name, status }]`
- `POST /api/v1/admin/tenants` body `{ tenantId, name, status?, quotas? }` → data: tenant
- `GET /api/v1/admin/tenants/{tenantId}` → data: tenant
- `PATCH /api/v1/admin/tenants/{tenantId}` body `{ name?, status?, quotas? }` → data: tenant
- `DELETE /api/v1/admin/tenants/{tenantId}` → `{ success: true }` (409 if resources assigned)

### Quotas
- Keys: `cpu`, `memoryMB`, `storageMB`, `vmCount`, `networkCount` (limit `-1` = unlimited)
- `GET /api/v1/admin/tenants/{tenantId}/quotas` → data: `{ key: { limit, used }, ... }`
- `PATCH /api/v1/admin/tenants/{tenantId}/quotas` body `{ limits: { key?: int } }` → data: same shape
- Holds: `POST /quotas/reserve` body `{ taskId, deltas: { key?: int>=0 }, ttlMs? }` → data: hold
- Release: `POST /quotas/release` body `{ taskId }` → `{ success: true }`
- Recalc: `POST /quotas/recalculate` body `{ tenantId?: string }` → `{ success: true, data }`

### Resources
- `GET /api/v1/admin/tenants/{tenantId}/resources?kind=&agentId=&includeOrphans=true|false`
  - data: array of resources merged with inventories.
  - Common: `tenantId, agentId, kind ("vm"|"switch"|"storage"), refId, name?, ha?, _staleAgent`
  - VM: `state, cpu, ramMB, switches, attachedDisks, orphaned?`; stale → state `Unknown` unless `NotFound`
  - Storage: `sizeMB, state (attached|mismatch|unattached|NotFound), attachedTo?, orphaned?`
  - `includeOrphans=true` returns assigned links missing in inventory with `state:"NotFound", orphaned:true, assignedAt`
- `POST /api/v1/admin/tenants/{tenantId}/resources` body `{ kind, agentId, refIds: string[], ha?: boolean }` → `{ success: true }`
- `DELETE /api/v1/admin/tenants/{tenantId}/resources/{resourceId}?kind=&agentId=` → `{ success: true }`
- `GET /api/v1/admin/resources/unassigned?kind=&agentId=&limit=100` → data: `[{ kind, agentId, refId, name?, state?, cpu?, ramMB?, switches?, raw, _staleAgent }]`

### Tasks
- `POST /api/v1/admin/tasks`
  - body `{ action, target: { kind:"vm"|"storage"|"network", refId?, agentId? }, data:{...}, tenantId, taskId? }`
  - response data: task record (id/status/etc.)
- `GET /api/v1/admin/tasks/{taskId}` → task status

### Agents
- `GET /api/v1/admin/agents` → heartbeats list
- `GET /api/v1/admin/agents/{agentId}/status` → status
- `GET /api/v1/admin/agents/{agentId}/inventory` → inventory doc

### Metrics
- `GET /api/v1/admin/metrics/overview` → agents online/offline, tenants count, vms by state, compute totals, storage totals/byStorage, tasks last24h
- `GET /api/v1/admin/metrics/compute` → compute totals + per-agent
- `GET /api/v1/admin/metrics/datastores` → storage totals + per storage
- `GET /api/v1/admin/metrics/vms` → VMs per agent
- `GET /api/v1/admin/metrics/tenant/overview[?tenantId=]` → tenants with quotas + task stats

### Images (admin)
- `GET /api/v1/admin/images?q=` → data: list
- `GET /api/v1/admin/images/{imageId}` → data: image
- `GET /api/v1/admin/images/{imageId}/resolve` → resolved image

## Tenant API
- Tasks: `POST /api/v1/tenant/tasks`, `GET /api/v1/tenant/tasks/{taskId}` (tenant context from JWT)
- Resources: `GET /api/v1/tenant/resources` → resources for current tenant (same shape as admin list)
- Metrics: `GET /api/v1/tenant/metrics/overview` → data: `{ tasks:{queued,done,error,since}, resources: count }`
- Images: `GET /api/v1/tenant/images[?q=]`, `GET /api/v1/tenant/images/{imageId}`, `GET /api/v1/tenant/images/{imageId}/resolve`

## Auth endpoints (quick reference)
- Admin: `POST /api/v1/admin/auth/login`, `GET /me`, `GET /userinfo`, `POST /introspect`, `POST /register`, `POST /tenant/register`, PATs `POST/GET /pats`, `DELETE /pats/{patId}`
- Tenant: `POST /api/v1/tenant/auth/register` (x-api-key or Bearer), `POST /login`, `GET /me`, `GET /userinfo`, `POST /introspect`, PATs `POST/GET /pats`, `DELETE /pats/{patId}`
