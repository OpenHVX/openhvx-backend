import type { AuthenticatedUser } from "../middlewares/verifyViaAuth";

declare global {
    namespace Express {
        interface Request {
            id?: string;
            tenantId?: string;
            user?: AuthenticatedUser;
            isAdmin?: boolean;
        }
    }
}

export {};
