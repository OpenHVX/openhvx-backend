// @ts-nocheck
// controllers/authAdmin.controller.js
'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

const User = require('../models/user.base.model');       // base model (discriminatorKey: 'kind')
const UserAdmin = require('../models/user.admin.model'); // discriminator 'admin'
const { signAdmin, cfg } = require('../lib/jwt');

const REGISTER_ENABLED = process.env.REGISTER_ENABLED === 'true';
const REGISTER_API_KEY = process.env.REGISTER_API_KEY || '';
const DEBUG = process.env.AUTH_DEBUG === 'true';

/* Utils */
function timingSafeEq(a, b) {
    const A = Buffer.from(a || '');
    const B = Buffer.from(b || '');
    const ah = crypto.createHash('sha256').update(A).digest();
    const bh = crypto.createHash('sha256').update(B).digest();
    try { return crypto.timingSafeEqual(ah, bh); } catch { return false; }
}

function assertRegisterAuth(req) {
    if (!REGISTER_ENABLED) return { ok: false, status: 404, error: 'NotFound' };
    if (!REGISTER_API_KEY) return { ok: false, status: 503, error: 'RegisterNotConfigured' };
    const provided = req.header('x-api-key') || '';
    if (!timingSafeEq(provided, REGISTER_API_KEY)) return { ok: false, status: 401, error: 'Unauthorized' };
    return { ok: true };
}

function norm(s) { return (s ?? '').toString().trim().toLowerCase(); }

function ridOf(req) { return req._rid || crypto.randomUUID(); }

function publicUser(u) {
    return {
        id: String(u._id),
        email: u.email ?? null,
        username: u.username ?? null,
        roles: Array.isArray(u.roles) ? u.roles : [],
        scopes: Array.isArray(u.scopes) ? u.scopes : [],
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
    };
}

function resolveRegisterMode(req) {
    const m = String(req.query?.mode || '').toLowerCase();
    return ['once', 'reset', 'upsert'].includes(m) ? m : 'once'; // default: once
}

/**
 * POST /auth/admin/login
 * body: { email, password }
 */
exports.login = async (req, res) => {
    const rid = ridOf(req);
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            if (DEBUG) console.warn(`[auth][${rid}] login: missing email/password`);
            return res.status(400).json({ error: 'email/password required' });
        }

        const em = norm(email);
        if (DEBUG) console.info(`[auth][${rid}] login: trying ${em}`);

        const user = await UserAdmin.findOne({ email: em, isActive: true })
            .select('+passwordHash roles scopes email username createdAt updatedAt kind __t isActive');

        if (!user) {
            if (DEBUG) console.warn(`[auth][${rid}] login: user_not_found_or_inactive (email=${em})`);
            return res.status(401).json({ error: 'invalid credentials' });
        }

        if (DEBUG) {
            console.info(`[auth][${rid}] login: user_found id=${user._id} email=${user.email} `
                + `isActive=${user.isActive} kind=${user.kind} __t=${user.__t} `
                + `roles=[${(user.roles || []).join(',')}] scopes=[${(user.scopes || []).join(',')}]`);
        }

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) {
            if (DEBUG) console.warn(`[auth][${rid}] login: bad_password (email=${em})`);
            return res.status(401).json({ error: 'invalid credentials' });
        }

        const token = signAdmin(user);
        if (DEBUG) console.info(`[auth][${rid}] login: success -> exp=${cfg.admin.expiresIn}`);

        return res.json({
            access_token: token,
            token_type: 'Bearer',
            expires_in: cfg.admin.expiresIn,
            user: publicUser(user),
        });
    } catch (e) {
        console.error(`[auth][${rid}] login: error`, e);
        return res.status(500).json({ error: e.message });
    }
};

/**
 * POST /auth/admin/introspect
 * body: { token } (ou Authorization: Bearer ...)
 */
exports.introspect = async (req, res) => {
    const rid = ridOf(req);
    try {
        let token = req.body?.token;
        if (!token) {
            const h = req.get('authorization') || '';
            token = h.startsWith('Bearer ') ? h.slice(7) : null;
        }
        if (!token) return res.status(400).json({ active: false, error: 'missing token' });

        try {
            const decoded = jwt.verify(token, cfg.admin.secret, {
                issuer: cfg.admin.iss,
                audience: cfg.admin.aud,
            });
            return res.json({
                active: true,
                sub: decoded.sub,
                roles: decoded.roles || [],
                scopes: decoded.scopes || [],
                exp: decoded.exp,
                iss: decoded.iss,
                aud: decoded.aud,
            });
        } catch {
            return res.json({ active: false });
        }
    } catch (e) {
        console.error(`[auth][${rid}] introspect: error`, e);
        return res.status(500).json({ active: false, error: e.message });
    }
};

/**
 * GET /auth/admin/me
 * header: Authorization: Bearer <token-admin>
 */
exports.me = async (req, res) => {
    const rid = ridOf(req);
    try {
        const h = req.get('authorization') || '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'missing bearer token' });

        let decoded;
        try {
            decoded = jwt.verify(token, cfg.admin.secret, {
                issuer: cfg.admin.iss,
                audience: cfg.admin.aud,
            });
        } catch {
            return res.status(401).json({ error: 'invalid token' });
        }

        const user = await UserAdmin.findById(decoded.sub).lean();
        if (!user) return res.status(404).json({ error: 'user not found' });

        return res.json(publicUser(user));
    } catch (e) {
        console.error(`[auth][${rid}] me: error`, e);
        return res.status(500).json({ error: e.message });
    }
};

/**
 * GET /auth/admin/userinfo
 * header: Authorization: Bearer <token-admin>
 */
exports.userinfo = async (req, res) => {
    const rid = ridOf(req);
    try {
        const h = req.get('authorization') || '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'missing bearer token' });

        let decoded;
        try {
            decoded = jwt.verify(token, cfg.admin.secret, {
                issuer: cfg.admin.iss,
                audience: cfg.admin.aud,
            });
        } catch {
            return res.status(401).json({ error: 'invalid token' });
        }

        return res.json({
            sub: decoded.sub,
            roles: decoded.roles || [],
            scopes: decoded.scopes || [],
            exp: decoded.exp,
            iss: decoded.iss,
            aud: decoded.aud,
        });
    } catch (e) {
        console.error(`[auth][${rid}] userinfo: error`, e);
        return res.status(500).json({ error: e.message });
    }
};
/**
 * POST /auth/admin/register?mode=once|reset|upsert
 * headers: x-api-key: <REGISTER_API_KEY>
 * body: { email, password, username? }
 *
 * - once  (default): returns 409 if the email already exists
 * - reset : updates the passwordHash when the user already exists (and forces kind=admin/roles/scopes)
 * - upsert: creates when missing, otherwise updates (reset + create)
 */
exports.register = async (req, res) => {
    const rid = ridOf(req);
    try {
        const gate = assertRegisterAuth(req);
        if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

        const { email, password, username } = req.body || {};
        const em = norm(email);
        if (!em || !password) return res.status(400).json({ error: 'email/password required' });
        if (password.length < 12) return res.status(400).json({ error: 'WeakPassword', minLength: 12 });

        const mode = resolveRegisterMode(req);
        if (DEBUG) console.info(`[auth][${rid}] register: mode=${mode} email=${em}`);

        // Check for an existing user across every discriminator
        const existing = await User.findOne({ email: em }).select('_id kind').lean();

        if (existing) {
            if (mode === 'once') {
                if (DEBUG) console.warn(`[auth][${rid}] register: AlreadyExists id=${existing._id} kind=${existing.kind}`);
                return res.status(409).json({ error: 'AlreadyExists', id: String(existing._id) });
            }
            // reset/upsert → make sure kind=admin and refresh the password hash
            const passwordHash = await bcrypt.hash(password, 12);
            const updated = await UserAdmin.findOneAndUpdate(
                { email: em },
                {
                    $set: {
                        kind: 'admin',
                        email: em,
                        username: username ?? null,
                        passwordHash,
                        isActive: true,
                        roles: ['global-admin'],
                        scopes: ['platform.admin'],
                    },
                },
                { new: true, upsert: mode === 'upsert' }
            ).select('email username roles scopes createdAt updatedAt');
            if (DEBUG) console.info(`[auth][${rid}] register: promoted/reset id=${updated?._id}`);
            return res.status(200).json({ ok: true, promoted: true, user: publicUser(updated) });
        }

        // No match found → create
        const passwordHash = await bcrypt.hash(password, 12);
        const user = await UserAdmin.create({
            kind: 'admin',
            email: em,
            username: username ?? null,
            passwordHash,
            isActive: true,
            roles: ['global-admin'],
            scopes: ['platform.admin'],
        });
        if (DEBUG) console.info(`[auth][${rid}] register: created id=${user._id}`);
        return res.status(201).json({ ok: true, created: true, user: publicUser(user) });

    } catch (e) {
        if (e?.code === 11000) {
            // Collision d'index unique (email)
            return res.status(409).json({ error: 'DuplicateKey', details: e.keyValue });
        }
        console.error(`[auth][${rid}] register: error`, e);
        return res.status(500).json({ error: e.message });
    }
};
