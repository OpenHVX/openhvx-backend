import type { NextFunction, Response } from "express";
import type { ControllerRequest } from "../types/express";

export default function requireTenant() {
    return (req: ControllerRequest, res: Response, next: NextFunction) => {
        const normLower = (value?: unknown): string | undefined => {
            if (value === null || value === undefined) return undefined;
            const s = String(value).trim();
            return s ? s.toLowerCase() : undefined;
        };

        const tenantId =
            normLower(req.tenantId) ||
            normLower(req.headers["x-tenant-id"] as string | undefined) ||
            normLower(req.user?.tenantId) ||
            normLower(req.auth?.tenantId as string | undefined) ||
            normLower(req.tenant?.tenantId as string | undefined) ||
            undefined;

        if (!tenantId) {
            return res.status(400).json({ error: "Missing tenant context" });
        }
        req.tenantId = tenantId;
        next();
    };
}
