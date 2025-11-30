import type { Request } from "express";
import type { TenantRecord } from "../models/Tenant";

declare module "express-serve-static-core" {
    interface Request {
        id?: string;
        tenantId?: string;
        user?: Record<string, unknown>;
        auth?: Record<string, unknown>;
        enforceTenant?: boolean;
        isAdmin?: boolean;
        tenant?: TenantRecord;
    }
}

export type ControllerRequest = Request;
