// auth-service/routes/user.routes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/user.mongo.controller");
const authStatic = require("../middlewares/auth.static");

// Health proxy (optionnel)
router.get("/", (req, res) => res.json({ ok: true, service: "auth-service" }));

// Auth
router.post("/auth/register", authStatic({ env: "AUTH_ADMIN_API_KEY" }), ctrl.register);
router.post("/auth/login", ctrl.login);

// Introspection (si tu veux la verrouiller : define AUTH_INTROSPECT_API_KEY)
const maybeProtectIntrospect = process.env.AUTH_INTROSPECT_API_KEY
    ? authStatic({ env: "AUTH_INTROSPECT_API_KEY" })
    : (req, res, next) => next();

router.post("/auth/introspect", maybeProtectIntrospect, ctrl.introspect);

// Profile
router.get("/users/me", ctrl.me);

router.get("/auth/userinfo", ctrl.userinfo);


module.exports = router;
