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

    /**
     * @openapi
     * tags:
     *   - name: Tenant Auth
     *     description: Authentication and token endpoints for tenant users
     */

    /**
     * @openapi
     * /api/v1/tenant/auth/register:
     *   post:
     *     summary: Register a tenant user (API key or Bearer)
     *     tags: [Tenant Auth]
     *     parameters:
     *       - in: header
     *         name: x-api-key
     *         schema: { type: string }
     *         required: false
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200: { description: OK }
     */
    router.post(
        "/register",
        onlyTenantHost,
        stripSpoofable,
        ensureApiKeyOrBearer,
        mkProxy(AUTH_URL, () => "/auth/tenant/register"),
    );

    /**
     * @openapi
     * /api/v1/tenant/auth/login:
     *   post:
     *     summary: Authenticate a tenant user
     *     tags: [Tenant Auth]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               username: { type: string }
     *               password: { type: string }
     *     responses:
     *       200: { description: Token response from auth service }
     */
    router.post(
        "/login",
        onlyTenantHost,
        stripSpoofable,
        stripAuthorization,
        mkProxy(AUTH_URL, () => "/auth/tenant/login"),
    );

    /**
     * @openapi
     * /api/v1/tenant/auth/me:
     *   get:
     *     summary: Get the current tenant profile
     *     tags: [Tenant Auth]
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200: { description: User info }
     */
    router.get("/me", onlyTenantHost, stripSpoofable, ensureBearer, mkProxy(AUTH_URL, () => "/auth/tenant/me"));

    /**
     * @openapi
     * /api/v1/tenant/auth/userinfo:
     *   get:
     *     summary: Get tenant OIDC userinfo
     *     tags: [Tenant Auth]
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200: { description: OIDC claims }
     */
    router.get(
        "/userinfo",
        onlyTenantHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => "/auth/tenant/userinfo"),
    );

    /**
     * @openapi
     * /api/v1/tenant/auth/pats:
     *   post:
     *     summary: Create a tenant PAT
     *     tags: [Tenant Auth]
     *     security:
     *       - bearerAuth: []
     *   get:
     *     summary: List tenant PATs
     *     tags: [Tenant Auth]
     *     security:
     *       - bearerAuth: []
     */
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

    /**
     * @openapi
     * /api/v1/tenant/auth/pats/{patId}:
     *   delete:
     *     summary: Delete a tenant PAT
     *     tags: [Tenant Auth]
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: path
     *         name: patId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200: { description: OK }
     */
    router.delete(
        "/pats/:patId",
        onlyTenantHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, (origPath) => `/auth/tenant${origPath}`),
    );

    /**
     * @openapi
     * /api/v1/tenant/auth/introspect:
     *   post:
     *     summary: Introspect a tenant token
     *     tags: [Tenant Auth]
     *     responses:
     *       200: { description: Introspection result }
     */
    router.post(
        "/introspect",
        onlyTenantHost,
        stripSpoofable,
        mkProxy(AUTH_URL, () => "/auth/tenant/introspect"),
    );

    return router;
};
