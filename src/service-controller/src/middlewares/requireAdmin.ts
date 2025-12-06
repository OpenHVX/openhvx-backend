import type { NextFunction, Response } from "express";
import type { ControllerRequest } from "../types/express";

export default function requireAdmin() {
    return (req: ControllerRequest, res: Response, next: NextFunction) => {
        const headerRoles = (req.headers["x-roles"] || req.headers["x-role"]) as string | undefined;
        const roles = headerRoles
            ? headerRoles.split(",").map((role) => role.trim().toLowerCase())
            : [];

        if (Array.isArray(req.user?.roles)) {
            roles.push(...req.user.roles.map((role) => String(role).toLowerCase()));
        }

        if (!roles.includes("admin")) {
            return res.status(403).json({ error: "Admin role required" });
        }

        next();
    };
}
