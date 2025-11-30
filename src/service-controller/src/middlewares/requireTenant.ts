import type { NextFunction, Response } from "express";
import type { ControllerRequest } from "../types/express";

export default function requireTenant() {
    return (req: ControllerRequest, res: Response, next: NextFunction) => {
        const tenantId =
            req.tenantId ||
            req.headers["x-tenant-id"] ||
            req.user?.tenantId ||
            req.auth?.tenantId ||
            req.tenant?.tenantId ||
            null;

        if (!tenantId) {
            return res.status(400).json({ error: "Missing tenant context" });
        }
        req.tenantId = String(tenantId);
        next();
    };
}
