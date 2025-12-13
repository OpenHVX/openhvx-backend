import { Router, type NextFunction, type Request, type Response } from "express";
import { ensureHost, ensureBearer, mkProxy, stripSpoofable } from "../lib/_utils";

interface RouterOptions {
    AUTH_URL: string;
}

export default ({ AUTH_URL }: RouterOptions) => {
    const router = Router();
    const onlyAdminHost = ensureHost("admin");

    const stripAuthorization = (req: Request, _res: Response, next: NextFunction): void => {
        delete (req.headers as Record<string, unknown>).authorization;
        next();
    };

    router.post(
        "/login",
        onlyAdminHost,
        stripSpoofable,
        stripAuthorization,
        mkProxy(AUTH_URL, () => "/auth/admin/login"),
    );

    router.get("/me", onlyAdminHost, stripSpoofable, ensureBearer, mkProxy(AUTH_URL, () => "/auth/admin/me"));

    router.get(
        "/userinfo",
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => "/auth/admin/userinfo"),
    );

    router.post("/introspect", onlyAdminHost, stripSpoofable, mkProxy(AUTH_URL, () => "/auth/admin/introspect"));

    router.post("/register", onlyAdminHost, stripSpoofable, mkProxy(AUTH_URL, () => "/auth/admin/register"));

    router.post(
        "/tenant/register",
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => "/auth/tenant/register"),
    );

    router.post(
        "/pats",
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, (origPath) => `/auth/admin${origPath}`),
    );
    router.get(
        "/pats",
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, (origPath) => `/auth/admin${origPath}`),
    );
    router.delete(
        "/pats/:patId",
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, (origPath) => `/auth/admin${origPath}`),
    );

    return router;
};

