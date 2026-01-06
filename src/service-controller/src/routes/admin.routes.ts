// src/service-controller/src/routes/admin.routes.ts
// Routes for admin operations

import { Router } from "express";
import { asAdminMode } from "../middlewares/accessMode";
import {
    createTenant,
    listTenants,
    getTenant,
    updateTenant,
    removeTenant,
    getQuotas,
    patchQuotaLimits,
    reserveQuotas,
    releaseQuotas,
    recalculateQuotas,
} from "../controllers/tenantsController";
import { getAgents, getStatus, getInventory } from "../controllers/agentsController";
import {
    listResources,
    claimResources,
    unclaimResource,
    listUnassignedResources,
} from "../controllers/resourcesController";
import { enqueueTask, getTask } from "../controllers/tasksController";
import {
    adminOverview,
    adminCompute,
    adminDatastores,
    adminVMs,
    adminTenantOverview,
} from "../controllers/metricsController";
import { listImages, getImage, resolveImage } from "../controllers/imagesController";

const router = Router();

router.use(asAdminMode());

router.get("/resources/unassigned", listUnassignedResources);

router.post("/tenants", createTenant);
router.get("/tenants", listTenants);
router.get("/tenants/:tenantId", getTenant);
router.patch("/tenants/:tenantId", updateTenant);
router.delete("/tenants/:tenantId", removeTenant);

router.get("/tenants/:tenantId/quotas", getQuotas);
router.patch("/tenants/:tenantId/quotas", patchQuotaLimits);
router.post("/tenants/:tenantId/quotas/reserve", reserveQuotas);
router.post("/tenants/:tenantId/quotas/release", releaseQuotas);
router.post("/tenants/:tenantId/quotas/recalculate", recalculateQuotas);

router.post("/tasks", enqueueTask);
router.get("/tasks/:taskId", getTask);

router.get("/tenants/:tenantId/resources", listResources);
router.post("/tenants/:tenantId/resources", claimResources);
router.delete("/tenants/:tenantId/resources/:resourceId", unclaimResource);

router.get("/agents", getAgents);
router.get("/agents/:agentId/status", getStatus);
router.get("/agents/:agentId/inventory", getInventory);

router.get("/metrics/overview", adminOverview);
router.get("/metrics/compute", adminCompute);
router.get("/metrics/datastores", adminDatastores);
router.get("/metrics/vms", adminVMs);
router.get("/metrics/tenant/overview", adminTenantOverview);
router.get("/images", listImages);
router.get("/images/:imageId", getImage);
router.get("/images/:imageId/resolve", resolveImage);

export default router;
