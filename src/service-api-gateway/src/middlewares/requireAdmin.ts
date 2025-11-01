import type { Request, Response, NextFunction } from "express";

const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const roles = (req.user?.roles ?? []).map((role) => String(role).toLowerCase());
    if (!roles.includes("admin")) {
        res.status(403).json({ error: "Admin role required" });
        return;
    }
    next();
};

export default requireAdmin;
