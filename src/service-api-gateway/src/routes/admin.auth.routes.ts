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

    /**
     * @openapi
     * tags:
     *   - name: Admin Auth
     *     description: Authentication and token endpoints for admin users
     */

    /**
     * @openapi
     * /api/v1/admin/auth/login:
     *   post:
     *     summary: Authenticate an admin and return a token
     *     tags: [Admin Auth]
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
        onlyAdminHost,
        stripSpoofable,
        stripAuthorization,
        mkProxy(AUTH_URL, () => "/auth/admin/login"),
    );

    /**
     * @openapi
     * /api/v1/admin/auth/me:
     *   get:
     *     summary: Get the current admin profile
     *     tags: [Admin Auth]
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200: { description: User info }
     */
    router.get("/me", onlyAdminHost, stripSpoofable, ensureBearer, mkProxy(AUTH_URL, () => "/auth/admin/me"));

    /**
     * @openapi
     * /api/v1/admin/auth/userinfo:
     *   get:
     *     summary: Get OIDC userinfo for the admin
     *     tags: [Admin Auth]
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200: { description: OIDC claims }
     */
    router.get(
        "/userinfo",
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => "/auth/admin/userinfo"),
    );

    /**
     * @openapi
     * /api/v1/admin/auth/introspect:
     *   post:
     *     summary: Introspect a token
     *     tags: [Admin Auth]
     *     responses:
     *       200: { description: Introspection result }
     */
    router.post("/introspect", onlyAdminHost, stripSpoofable, mkProxy(AUTH_URL, () => "/auth/admin/introspect"));

    /**
     * @openapi
     * /api/v1/admin/auth/register:
     *   post:
     *     summary: Create an admin user
     *     tags: [Admin Auth]
     *     responses:
     *       200: { description: Created or error from auth service }
     */
    router.post("/register", onlyAdminHost, stripSpoofable, mkProxy(AUTH_URL, () => "/auth/admin/register"));

    /**
     * @openapi
     * /api/v1/admin/auth/tenant/register:
     *   post:
     *     summary: Create a tenant via admin auth
     *     tags: [Admin Auth]
     *     parameters:
     *       - in: query
     *         name: mode
     *         description: once (default) | reset | upsert
     *         schema: { type: string }
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200: { description: OK }
     */
    router.post(
        "/tenant/register",
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => "/auth/tenant/register"),
    );

    /**
     * @openapi
     * /api/v1/admin/auth/pats:
     *   post:
     *     summary: Create an admin personal access token (PAT)
     *     tags: [Admin Auth]
     *     security:
     *       - bearerAuth: []
     *   get:
     *     summary: List admin PATs
     *     tags: [Admin Auth]
     *     security:
     *       - bearerAuth: []
     */
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

    /**
     * @openapi
     * /api/v1/admin/auth/pats/{patId}:
     *   delete:
     *     summary: Delete an admin PAT
     *     tags: [Admin Auth]
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
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, (origPath) => `/auth/admin${origPath}`),
    );

    return router;
};
