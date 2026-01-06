// access Mode middlewares to set request context for tenant or admin operations

import type { NextFunction, Response } from "express";
import type { ControllerRequest } from "../types/express";

type Middleware = (req: ControllerRequest, res: Response, next: NextFunction) => void;

export const asTenantMode = (): Middleware => (req, _res, next) => {
    req.enforceTenant = true;
    req.isAdmin = false;
    next();
};

export const asAdminMode = (): Middleware => (req, _res, next) => {
    req.enforceTenant = false;
    req.isAdmin = true;
    next();
};
