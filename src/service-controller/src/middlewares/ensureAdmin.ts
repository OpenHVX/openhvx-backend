// Middleware to ensure the user has admin privileges

import type { NextFunction, Response } from "express";
import type { ControllerRequest } from "../types/express";

const forbidden = (res: Response) => res.status(403).json({ error: "Forbidden: admin only" });

export default function ensureAdmin(req: ControllerRequest, res: Response, next: NextFunction) {
    try {
        const payload = (req.user || req.auth || {}) as Record<string, unknown>;
        const roles = Array.isArray(payload.roles)
            ? payload.roles
            : Array.isArray(payload.scope)
            ? payload.scope
            : typeof payload.role === "string"
            ? [payload.role]
            : [];
        const normalized = roles.map((r) => (typeof r === "string" ? r : String(r ?? ""))).map((r) => r.toLowerCase());
        if (normalized.includes("global-admin")) return next();
        return forbidden(res);
    } catch {
        return forbidden(res);
    }
}
