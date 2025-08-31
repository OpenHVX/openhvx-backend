// controller - tenant.routes.js
const express = require("express");
const router = express.Router();
const { asTenantMode } = require('../middlewares/accessMode');
const requireTenant = require('../middlewares/requireTenant');
const loadTenant = require('../middlewares/loadTenant');
const tasks = require("../controllers/tasksController");
const resources = require("../controllers/resourcesController");
const metrics = require("../controllers/metricsController");

router.use(asTenantMode());            // enforceTenant = true
router.use(requireTenant(), loadTenant());
// Tasks (scopées tenantId)
router.post("/tasks", tasks.enqueueTask);
router.get("/tasks/:taskId", tasks.getTask);

// Ressources attachées à un tenant
router.get("/resources", resources.listResources);

//Metrics
router.get("/metrics/overview", metrics.tenantOverview);

module.exports = router;
