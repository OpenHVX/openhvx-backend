// @ts-nocheck
// routes/admin.js (legacy reference)
"use strict";

const express = require("express");
const router = express.Router();

const { asAdminMode } = require("../middlewares/accessMode");

const tenants = require("../controllers/tenantsController");
const agents = require("../controllers/agentsController");
const resources = require("../controllers/resourcesController");
const tasks = require("../controllers/tasksController");
const metrics = require("../controllers/metricsController");
const images = require("../controllers/imagesController");

// Everything below runs in admin mode
router.use(asAdminMode());

// -----------------------------------------------------------------------------
// Global (unassigned)
// -----------------------------------------------------------------------------
router.get("/resources/unassigned", resources.listUnassignedResources);

// -----------------------------------------------------------------------------
// Tenants (CRUD)
// -----------------------------------------------------------------------------
router.post("/tenants", tenants.create);
router.get("/tenants", tenants.list);
router.get("/tenants/:tenantId", tenants.get);
router.patch("/tenants/:tenantId", tenants.update);
router.delete("/tenants/:tenantId", tenants.remove);

// -----------------------------------------------------------------------------
// Tenants > Quotas
// -----------------------------------------------------------------------------
router.get("/tenants/:tenantId/quotas", tenants.getQuotas);
router.patch("/tenants/:tenantId/quotas", tenants.patchQuotaLimits);
router.post("/tenants/:tenantId/quotas/reserve", tenants.reserveQuotas);
router.post("/tenants/:tenantId/quotas/release", tenants.releaseQuotas);
router.post("/tenants/:tenantId/quotas/recalculate", tenants.recalculateQuotas);

// -----------------------------------------------------------------------------
// Tasks (scoped by tenantId via body/JWT)
// -----------------------------------------------------------------------------
router.post("/tasks", tasks.enqueueTask);
router.get("/tasks/:taskId", tasks.getTask);

// -----------------------------------------------------------------------------
// Tenant-owned resources
// -----------------------------------------------------------------------------
router.get("/tenants/:tenantId/resources", resources.listResources);
router.post("/tenants/:tenantId/resources", resources.claimResources);        // claim on behalf of the tenant
router.delete("/tenants/:tenantId/resources/:resourceId", resources.unclaimResource);      // unclaim on behalf of the tenant

// -----------------------------------------------------------------------------
// Agents (global)
// -----------------------------------------------------------------------------
router.get("/agents", agents.getAgents);
router.get("/agents/:agentId/status", agents.getStatus);
router.get("/agents/:agentId/inventory", agents.getInventory);

// -----------------------------------------------------------------------------
// Metrics
// -----------------------------------------------------------------------------
router.get("/metrics/overview", metrics.adminOverview);
router.get("/metrics/compute", metrics.adminCompute);
router.get("/metrics/datastores", metrics.adminDatastores);
router.get("/metrics/vms", metrics.adminVMs);
router.get("/metrics/tenant/overview", metrics.adminTenantOverview);

// -----------------------------------------------------------------------------
// Images
// -----------------------------------------------------------------------------
router.get("/images", images.list);
router.get("/images/:imageId", images.getOne);
router.get("/images/:imageId/resolve", images.resolve);

module.exports = router;
