# API Gateway Auth Routes (Context Snapshot)

Targets are proxied to auth-service; paths are already prefixed with `/api/v1/...` on the gateway. Hosts: `admin` host for admin routes, `tenant` host for tenant routes.

## Admin Auth
- POST `/api/v1/admin/auth/login` — Body `{ email, password }` → 200 `{ access_token, token_type:"Bearer", expires_in, user }`; 400/401 on missing/invalid.
- GET `/api/v1/admin/auth/me` — Bearer admin → 200 `user`; 401 missing/invalid.
- GET `/api/v1/admin/auth/userinfo` — Bearer admin → 200 `{ sub, roles, scopes, exp, iss, aud, token_type }`; 401 missing/invalid.
- POST `/api/v1/admin/auth/introspect` — Body `{ token }` or Authorization → 200 `{ active:true, sub, roles, scopes, exp, iss, aud, token_type }` or `{ active:false }`; 400 missing token.
- POST `/api/v1/admin/auth/register` — Header `x-api-key` (if enabled). Query `mode=once|reset|upsert` (default once). Body `{ email, password (min 12), username? }` → 201 `{ ok:true, created:true, user }` on create; 200 `{ ok:true, promoted:true, user }` on reset/upsert; 400 weak/missing; 409 already exists (mode once).
- POST `/api/v1/admin/auth/tenant/register` — Bearer admin. Query `mode=once|reset|upsert`. Body `{ email, password (min 12), tenantId, roles?, scopes?, username? }` → 201 `{ ok:true, created:true, user }`; 200 `{ ok:true, updated:true, mode, user }` on reset/upsert; 409 tenant mismatch or existing (mode once); 400/401/403 on auth/weak password.
- POST `/api/v1/admin/auth/pats` — Bearer admin. Body `{ label?, expiresInDays? }` → 201 `{ token, pat:{ id,label,createdAt,expiresAt?,lastUsedAt? } }`; 401 missing.
- GET `/api/v1/admin/auth/pats` — Bearer admin → 200 `{ pats:[{ id,label,createdAt,expiresAt?,lastUsedAt? }] }`; 401 missing.
- DELETE `/api/v1/admin/auth/pats/{patId}` — Bearer admin → 200 `{ ok:true }`; 404 not found; 401 missing.

## Tenant Auth
- POST `/api/v1/tenant/auth/register` — Auth: `x-api-key` if configured **or** Bearer admin/tenant-admin. Query `mode=once|reset|upsert` (default once). Body `{ email, password (min 12), tenantId, roles?, scopes?, username? }` → 201 `{ ok:true, created:true, user }`; 200 `{ ok:true, updated:true, mode, user }` on reset/upsert; 409 tenant mismatch or existing (mode once); 400/401/403 on auth/weak password.
- POST `/api/v1/tenant/auth/login` — Body `{ email, password }` → 200 `{ access_token, token_type:"Bearer", expires_in, user }`; 400/401 bad creds.
- GET `/api/v1/tenant/auth/me` — Bearer tenant → 200 `user`; 401 missing/invalid.
- GET `/api/v1/tenant/auth/userinfo` — Bearer tenant → 200 `{ sub, roles, scopes, tenantId, tenants, defaultTenant, exp, iss, aud, token_type }`; 401 missing/invalid.
- POST `/api/v1/tenant/auth/introspect` — Body `{ token }` or Authorization → 200 `{ active:true, sub, roles, scopes, tenantId, tenants, defaultTenant, exp, iss, aud, token_type }` or `{ active:false }`; 400 missing token.
- POST `/api/v1/tenant/auth/pats` — Bearer tenant. Body `{ label?, expiresInDays? }` → 201 `{ token, pat:{ id,label,createdAt,expiresAt?,lastUsedAt? } }`; 401 missing.
- GET `/api/v1/tenant/auth/pats` — Bearer tenant → 200 `{ pats:[{ id,label,createdAt,expiresAt?,lastUsedAt? }] }`; 401 missing.
- DELETE `/api/v1/tenant/auth/pats/{patId}` — Bearer tenant → 200 `{ ok:true }`; 404 not found; 401 missing.

## Admin (controller proxy)
- POST `/api/v1/admin/tasks` — Enqueue task `{ action, target:{kind,refId,agentId}, data, tenantId }` → 200.
- GET `/api/v1/admin/tasks/{taskId}` — Task status → 200.
- GET `/api/v1/admin/agents` — List agents → 200.
- GET `/api/v1/admin/agents/{agentId}/status` — Agent status → 200.
- GET `/api/v1/admin/agents/{agentId}/inventory` — Agent inventory → 200.
- GET `/api/v1/admin/resources/unassigned` — Query `kind?`, `agentId?`, `limit?` → 200.
- GET `/api/v1/admin/tenants` — List tenants → 200.
- POST `/api/v1/admin/tenants` — Body `{ tenantId, name, status }` → 201.
- GET `/api/v1/admin/tenants/{tenantId}` — Tenant details → 200.
- PATCH `/api/v1/admin/tenants/{tenantId}` — Update tenant → 200.
- DELETE `/api/v1/admin/tenants/{tenantId}` — Delete (requires no resources) → 200.
- GET `/api/v1/admin/tenants/{tenantId}/resources` — List resources; query `kind?`, `agentId?`, `includeOrphans?` → 200.
- POST `/api/v1/admin/tenants/{tenantId}/resources/claim` — Body `{ kind, agentId, refIds[], ha? }` → 200.
- DELETE `/api/v1/admin/tenants/{tenantId}/resources/{resourceId}` — Query `kind`, `agentId` → 200.
- GET `/api/v1/admin/tenants/{tenantId}/quotas` — Current quotas → 200.
- PATCH `/api/v1/admin/tenants/{tenantId}/quotas` — Body `{ limits:{ cpu?, memoryMB?, storageMB?, vmCount?, networkCount? } }` → 200.
- POST `/api/v1/admin/tenants/{tenantId}/quotas/reserve` — Reserve quotas for task → 200.
- POST `/api/v1/admin/tenants/{tenantId}/quotas/release` — Release reservation → 200.
- POST `/api/v1/admin/tenants/{tenantId}/quotas/recalculate` — Recompute from inventory → 200.
- GET `/api/v1/admin/metrics/overview` — Global overview → 200.
- GET `/api/v1/admin/metrics/compute` — Compute capacity/details → 200.
- GET `/api/v1/admin/metrics/datastores` — Storage capacities → 200.
- GET `/api/v1/admin/metrics/vms` — VMs per agent → 200.
- GET `/api/v1/admin/metrics/tenant/overview` — Query `tenantId?` → 200.
- GET `/api/v1/admin/images` — Catalog; query `q?` → 200.
- GET `/api/v1/admin/images/{imageId}` — Image details → 200.
- GET `/api/v1/admin/images/{imageId}/resolve` — Resolve alias → 200.

## Tenant (controller proxy, requires bearer tenant)
- POST `/api/v1/tenant/tasks` — Enqueue task for current tenant `{ action, target, data }` (policy-enforced) → 200.
- GET `/api/v1/tenant/tasks/{taskId}` — Task status → 200.
- GET `/api/v1/tenant/resources` — Tenant resources → 200.
- GET `/api/v1/tenant/images` — Catalog; query `q?` → 200.
- GET `/api/v1/tenant/images/{imageId}` — Image details → 200.
- GET `/api/v1/tenant/images/{imageId}/resolve` — Resolve alias → 200.
- GET `/api/v1/tenant/metrics/overview` — Overview for tenant → 200.

## Global
- GET `/healthz` — Proxied to controller `/api/v1/healthz` → 200 `{ ok: true, ... }`.
