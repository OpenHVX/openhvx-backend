// src/service-api-gateway/routes/tenant.auth.routes.js
const express = require('express');
const { ensureHost, stripSpoofable, ensureBearer, ensureApiKey, mkProxy } = require('../lib/_utils');

module.exports = ({ AUTH_URL }) => {
    const router = express.Router();

    // On montera ceci sous: app.use('/api/v1/tenant/auth', tenantAuthRoutes({ AUTH_URL }))
    // Host enforcement: api.openhvx.local uniquement
    const onlyTenantHost = ensureHost('tenant');

    // POST /api/v1/tenant/auth/register
    router.post(
        '/register',
        onlyTenantHost,
        stripSpoofable,
        ensureApiKey,                                 // retire si tu ne veux pas d’API key côté gateway
        (req, _res, next) => { delete req.headers.authorization; next(); },
        mkProxy(AUTH_URL, () => '/auth/tenant/register')
    );

    // POST /api/v1/tenant/auth/login
    router.post(
        '/login',
        onlyTenantHost,
        stripSpoofable,
        (req, _res, next) => { delete req.headers.authorization; next(); },
        mkProxy(AUTH_URL, () => '/auth/tenant/login')
    );

    // GET /api/v1/tenant/auth/me
    router.get(
        '/me',
        onlyTenantHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => '/auth/tenant/me')
    );

    // GET /api/v1/tenant/auth/userinfo
    router.get(
        '/userinfo',
        onlyTenantHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => '/auth/tenant/userinfo')
    );

    // POST /api/v1/tenant/auth/introspect
    router.post(
        '/introspect',
        onlyTenantHost,
        stripSpoofable,
        mkProxy(AUTH_URL, () => '/auth/tenant/introspect')
    );

    return router;
};
