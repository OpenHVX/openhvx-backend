import type { Request, Response, NextFunction, RequestHandler } from "express";

const sanitizeHeaders = (req: Request): void => {
    if (!req.headers) return;
    const headers = req.headers as Record<string, unknown>;
    delete headers["x-tenant-id"];
    delete headers["x-tenant"];
    delete headers["x-roles"];
    delete headers["x-user-id"];
};

const antiSpoof = (): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction) => {
        sanitizeHeaders(req);
        next();
    };
};

export default antiSpoof;
