import type { NextFunction, Response } from "express";
import Tenant from "../models/Tenant";
import type { ControllerRequest } from "../types/express";

export default function loadTenant() {
    return async (req: ControllerRequest, res: Response, next: NextFunction) => {
        const normLower = (value?: unknown): string | undefined => {
            if (value === null || value === undefined) return undefined;
            const s = String(value).trim();
            return s ? s.toLowerCase() : undefined;
        };

        const tenantIdHeader =
            normLower(req.tenantId) || normLower(req.headers["x-tenant-id"] as string | undefined);
        console.log('tenantIdHeader', tenantIdHeader);
        if (!tenantIdHeader) return res.status(400).json({ error: "Missing tenant context" });

        const tenant = await Tenant.findOne({ tenantId: tenantIdHeader }).lean();
        if (!tenant) return res.status(404).json({ error: "Unknown tenant", tenantId: tenantIdHeader });
        if (tenant.status === "disabled") return res.status(403).json({ error: "Tenant disabled", tenantId: tenantIdHeader });

        req.tenant = tenant;
        req.tenantId = normLower(tenant.tenantId);
        next();
    };
}
