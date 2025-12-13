import type { NextFunction, Request, Response, RequestHandler } from "express";
import type { AuthenticatedUser } from "./verifyViaAuth";

interface ResolveOptions {
    required?: boolean;
}

const resolveTenantFromToken = ({ required = true }: ResolveOptions = {}): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction) => {
        const user = req.user as (AuthenticatedUser & Record<string, unknown>) | undefined;

        const normLower = (value?: string): string | undefined => {
            if (!value) return undefined;
            const s = value.trim();
            return s ? s.toLowerCase() : undefined;
        };

        const pickString = (key: string): string | undefined => {
            const value = user?.[key];
            return typeof value === "string" && value.trim() ? normLower(value) : undefined;
        };

        const pickFirstFromArray = (key: string): string | undefined => {
            const value = user?.[key];
            if (Array.isArray(value) && value.length > 0) {
                const first = value[0];
                if (typeof first === "string" && first.trim()) {
                    return normLower(first);
                }
            }
            return undefined;
        };

        const tenantId =
            normLower(typeof req.tenantId === "string" ? req.tenantId : undefined) ??
            pickString("tenantId") ??
            pickString("tid") ??
            pickString("defaultTenant") ??
            pickFirstFromArray("tenants");

        if (required && !tenantId) {
            res.status(400).json({ error: "Missing tenant in token" });
            return;
        }

        if (tenantId) {
            req.tenantId = String(tenantId);
        }

        next();
    };
};

export default resolveTenantFromToken;
