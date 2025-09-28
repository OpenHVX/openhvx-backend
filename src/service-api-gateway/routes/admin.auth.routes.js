// src/service-api-gateway/routes/admin.auth.routes.js
const express = require('express');
const { ensureHost, stripSpoofable, ensureBearer, mkProxy } = require('../lib/_utils');

module.exports = ({ AUTH_URL }) => {
    const router = express.Router();

    const onlyAdminHost = ensureHost('admin');

    // POST /api/v1/admin/auth/login
    router.post(
        '/login',
        onlyAdminHost,
        stripSpoofable,
        (req, _res, next) => { delete req.headers.authorization; next(); },
        mkProxy(AUTH_URL, () => '/auth/admin/login')
    );

    // GET /api/v1/admin/auth/me
    router.get(
        '/me',
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => '/auth/admin/me')
    );

    // GET /api/v1/admin/auth/userinfo
    router.get(
        '/userinfo',
        onlyAdminHost,
        stripSpoofable,
        ensureBearer,
        mkProxy(AUTH_URL, () => '/auth/admin/userinfo')
    );

    // POST /api/v1/admin/auth/introspect
    router.post(
        '/introspect',
        onlyAdminHost,
        stripSpoofable,
        mkProxy(AUTH_URL, () => '/auth/admin/introspect')
    );

    // Ici on laisse passer l’x-api-key fourni par le client
    router.post(
        '/register',
        onlyAdminHost,
        stripSpoofable,
        mkProxy(AUTH_URL, () => '/auth/admin/register')
    );

    return router;
};
