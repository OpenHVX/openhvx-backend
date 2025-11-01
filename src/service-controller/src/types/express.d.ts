import type { Request } from "express";

declare module "express-serve-static-core" {
    interface Request {
        id?: string;
        tenantId?: string;
        user?: Record<string, unknown>;
        auth?: Record<string, unknown>;
        enforceTenant?: boolean;
        isAdmin?: boolean;
    }
}

export type ControllerRequest = Request;
