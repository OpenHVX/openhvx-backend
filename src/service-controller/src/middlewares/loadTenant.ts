import type { NextFunction, Response } from "express";
import Tenant from "../models/Tenant";
import type { ControllerRequest } from "../types/express";

export default function loadTenant() {
    return async (req: ControllerRequest, res: Response, next: NextFunction) => {
        const tenantIdHeader = req.tenantId || req.headers["x-tenant-id"];
        if (!tenantIdHeader) return res.status(400).json({ error: "Missing tenant context" });

        const tenant = await Tenant.findOne({ tenantId: String(tenantIdHeader) }).lean();
        if (!tenant) return res.status(404).json({ error: "Unknown tenant", tenantId: tenantIdHeader });
        if (tenant.status === "disabled") return res.status(403).json({ error: "Tenant disabled", tenantId: tenantIdHeader });

        req.tenant = tenant;
        req.tenantId = String(tenant.tenantId);
        next();
    };
}
