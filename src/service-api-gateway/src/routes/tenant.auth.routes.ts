import { Router, type NextFunction, type Request, type Response } from "express";
import { ensureHost, ensureBearer, mkProxy, stripSpoofable } from "../lib/_utils";

interface RouterOptions {
    AUTH_URL: string;
}

export default ({ AUTH_URL }: RouterOptions) => {
    const router = Router();
    const onlyTenantHost = ensureHost("tenant");

    const stripAuthorization = (req: Request, _res: Response, next: NextFunction): void => {
        delete (req.headers as Record<string, unknown>).authorization;
        next();
    };

    const ensureApiKeyOrBearer = (req: Request, res: Response, next: NextFunction): void => {
        const hasApiKey = !!req.headers["x-api-key"];
        const authorization = req.headers.authorization ?? "";
        const hasBearer = /^Bearer\s+\S+/.test(authorization);
        if (!hasApiKey && !hasBearer) {
            res.status(401).json({ error: "Missing x-api-key or Bearer token" });
            return;
        }
        next();
    };

    router.post(
        "/register",
        onlyTenantHost,
        stripSpoofable,
        ensureApiKeyOrBearer,
        mkProxy(AUTH_URL, () => "/auth/tenant/register"),
    );

    router.post(
        "/login",
        onlyTenantHost,
        stripSpoofable,
        stripAuthorization,
        mkProxy(AUTH_URL, () => "/auth/tenant/login"),
    );

    router.get("/me", onlyTenantHost, stripSpoofable, ensureBearer, mkProxy(AUTH_URL, () => "/auth/tenant/me"));

    router.get(
        "/userinfo",
        onlyTenantHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => "/auth/tenant/userinfo"),
    );

    router.post(
        "/pats",
        onlyTenantHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, (origPath) => `/auth/tenant${origPath}`),
    );
    router.get(
        "/pats",
        onlyTenantHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, (origPath) => `/auth/tenant${origPath}`),
    );
    router.delete(
        "/pats/:patId",
        onlyTenantHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, (origPath) => `/auth/tenant${origPath}`),
    );

    router.post(
        "/introspect",
        onlyTenantHost,
        stripSpoofable,
        mkProxy(AUTH_URL, () => "/auth/tenant/introspect"),
    );

    return router;
};
