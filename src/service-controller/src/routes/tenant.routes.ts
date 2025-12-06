import { Router } from "express";
import { asTenantMode } from "../middlewares/accessMode";
import requireTenant from "../middlewares/requireTenant";
import loadTenant from "../middlewares/loadTenant";
import { enqueueTask, getTask } from "../controllers/tasksController";
import { listResources } from "../controllers/resourcesController";
import { tenantOverview } from "../controllers/metricsController";
import { listImages, getImage, resolveImage } from "../controllers/imagesController";

const router = Router();

router.use(asTenantMode());
router.use(requireTenant(), loadTenant());

router.post("/tasks", enqueueTask);
router.get("/tasks/:taskId", getTask);

router.get("/resources", listResources);

router.get("/metrics/overview", tenantOverview);

router.get("/images", listImages);
router.get("/images/:imageId", getImage);
router.get("/images/:imageId/resolve", resolveImage);

export default router;
