const express = require("express");
const router = express.Router();
const { asAdminMode } = require('../middlewares/accessMode');
const tenants = require("../controllers/tenantsController");
const agents = require("../controllers/agentsController");
const resources = require("../controllers/resourcesController");
const tasks = require("../controllers/tasksController");
const metrics = require("../controllers/metricsController");
const images = require("../controllers/imagesController");

router.use(asAdminMode());

// Ressources non-assignées (global)
router.get("/resources/unassigned", resources.listUnassignedResources);

// CRUD Tenants (admin)
router.post("/tenants", tenants.create);
router.get("/tenants", tenants.list);
router.get("/tenants/:tenantId", tenants.get);
router.patch("/tenants/:tenantId", tenants.update);
router.delete("/tenants/:tenantId", tenants.remove);


// Tasks (scopées tenantId)
router.post("/tasks", tasks.enqueueTask);
router.get("/tasks/:taskId", tasks.getTask);

// Ressources attachées à un tenant
router.get("/tenants/:tenantId/resources", resources.listResources);

//  CLAIM/UNCLAIM réservés aux admins
router.post("/tenants/:tenantId/resources", resources.claimResources);
router.delete("/tenants/:tenantId/resources/:resourceId", resources.unclaimResource);


// Agents (globaux)
router.get("/agents", agents.getAgents);
router.get("/agents/:agentId/status", agents.getStatus);
router.get("/agents/:agentId/inventory", agents.getInventory);


//Metrics
router.get('/metrics/overview', metrics.adminOverview);
router.get('/metrics/compute', metrics.adminCompute);
router.get('/metrics/datastores', metrics.adminDatastores);
router.get('/metrics/vms', metrics.adminVMs);
router.get('/metrics/tenant/overview', metrics.adminTenantOverview);


router.get("/images", images.list);
router.get("/images/:imageId", images.getOne);
router.get("/images/:imageId/resolve", images.resolve);

module.exports = router;
