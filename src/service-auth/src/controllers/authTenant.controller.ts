// @ts-nocheck
// controllers/authTenant.controller.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const UserTenant = require('../models/user.tenant.model'); // discriminator 'tenant'
const UserAdmin = require('../models/user.admin.model');
const { signTenant, cfg, verifyAdmin, verifyTenant } = require('../lib/jwt');
const { mintPat, verifyPatToken, listPatsForUser, revokePat } = require('../lib/pat');

// Here "kind" refers to the actor type (admin vs tenant) tied to the DB discriminator,
// not to be confused with auth scopes.
function norm(s) { return (s ?? '').toString().trim().toLowerCase(); }
function publicUser(u) {
    return {
        id: String(u._id),
        email: u.email,
        username: u.username ?? null,
        tenantId: u.tenantId,
        roles: Array.isArray(u.roles) ? u.roles : [],
        scopes: Array.isArray(u.scopes) ? u.scopes : [],
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
    };
}

function bearerToken(req) {
    const h = req.get('authorization') || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function expFromPat(pat) {
    if (pat?.expiresAt instanceof Date) return Math.floor(pat.expiresAt.getTime() / 1000);
    return Math.floor(Date.now() / 1000) + 300; // short-lived cache for non-expiring PATs
}

async function resolveTenantAuth(token) {
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, cfg.tenant.secret, {
            issuer: cfg.tenant.iss,
            audience: cfg.tenant.aud,
        });
        const user = await UserTenant.findById(decoded.sub)
            .select('email username roles scopes tenantId isActive')
            .lean();
        if (!user || user.isActive === false) return null;
        return { source: 'jwt', user, decoded };
    } catch {
        /* fall through to PAT */
    }

    const pat = await verifyPatToken({ token, kind: 'tenant' });
    if (pat) return { source: 'pat', user: pat.user, pat: pat.pat };
    return null;
}

async function resolveRegisterActor(req) {
    const token = bearerToken(req);
    if (!token) return null;

    try {
        const decodedAdmin = verifyAdmin(token);
        const admin = await UserAdmin.findById(decodedAdmin.sub).select('roles isActive').lean();
        if (admin && admin.isActive !== false) {
            return { kind: 'admin', roles: admin.roles || [], tenantId: null };
        }
    } catch {
        /* ignore admin verification errors */
    }

    const patAdmin = await verifyPatToken({ token, kind: 'admin' }).catch(() => null);
    if (patAdmin?.user) {
        return { kind: 'admin', roles: patAdmin.user.roles || [], tenantId: null };
    }

    try {
        const decodedTenant = verifyTenant(token);
        const tenantUser = await UserTenant.findById(decodedTenant.sub)
            .select('roles isActive tenantId')
            .lean();
        if (tenantUser && tenantUser.isActive !== false) {
            return { kind: 'tenant', roles: tenantUser.roles || [], tenantId: tenantUser.tenantId || null };
        }
    } catch {
        /* ignore tenant verification errors */
    }

    const patTenant = await verifyPatToken({ token, kind: 'tenant' }).catch(() => null);
    if (patTenant?.user) {
        return { kind: 'tenant', roles: patTenant.user.roles || [], tenantId: patTenant.user.tenantId || null };
    }

    return null;
}

/**
 * POST /auth/tenant/register
 * - Optional: protect with X-API-Key when enabled
 *   ENV: TENANT_REGISTER_APIKEY (required when defined)
 */
exports.register = async (req, res) => {
    try {
        let { email, password, tenantId, roles = [], scopes = [], username = null } = req.body || {};
        email = norm(email);
        username = username ? norm(username) : null;
        tenantId = norm(tenantId);

        if (!email || !password || !tenantId) {
            return res.status(400).json({ error: 'email, password, tenantId are required' });
        }

        // Authorization: allow via matching x-api-key OR via admin/tenant-admin bearer token
        const expectedKey = process.env.TENANT_REGISTER_APIKEY;
        const providedKey = req.get('x-api-key');
        const hasApiKeyAccess = !!expectedKey && providedKey === expectedKey;

        if (!hasApiKeyAccess) {
            const actor = await resolveRegisterActor(req);
            if (!actor) {
                return res.status(expectedKey ? 401 : 403).json({ error: 'unauthorized' });
            }

            if (actor.kind === 'admin') {
                // admin can create users for any tenant
            } else if (actor.kind === 'tenant') {
                const rolesArr = Array.isArray(actor.roles) ? actor.roles : [];
                if (!rolesArr.includes('tenant-admin')) {
                    return res.status(403).json({ error: 'forbidden: tenant-admin role required' });
                }
                const actorTenant = norm(actor.tenantId);
                if (actorTenant && actorTenant !== tenantId) {
                    return res.status(403).json({ error: 'forbidden: tenant mismatch' });
                }
            } else {
                return res.status(403).json({ error: 'forbidden' });
            }
        }

        // Block any attempt to escalate tenant tokens to admin
        if (Array.isArray(roles) && roles.includes('global-admin')) {
            return res.status(400).json({ error: 'global-admin not allowed for tenant users' });
        }
        if (Array.isArray(scopes) && scopes.includes('platform.admin')) {
            return res.status(400).json({ error: 'platform.admin not allowed for tenant users' });
        }

        const passwordHash = await bcrypt.hash(password, 12); // cost 12 (tune if needed)
        const user = await UserTenant.create({
            kind: 'tenant',
            email,
            username,
            passwordHash,
            tenantId,
            roles: Array.isArray(roles) ? roles : [],
            scopes: Array.isArray(scopes) ? scopes : [],
            isActive: true,
        });

        return res.status(201).json({ user: publicUser(user) });
    } catch (e) {
        if (e?.code === 11000) return res.status(409).json({ error: 'user already exists (email or username)' });
        return res.status(500).json({ error: e.message });
    }
};

/**
 * POST /auth/tenant/login
 * body: { email, password }
 */
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: 'email/password required' });

        const user = await UserTenant.findOne({ email: norm(email), isActive: true })
            .select('+passwordHash tenantId roles scopes email username createdAt updatedAt');

        if (!user) return res.status(401).json({ error: 'invalid credentials' });

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return res.status(401).json({ error: 'invalid credentials' });

        const token = signTenant(user);
        return res.json({
            access_token: token,
            token_type: 'Bearer',
            expires_in: cfg.tenant.expiresIn,
            user: publicUser(user),
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};

/**
 * POST /auth/tenant/introspect
 * body: { token }  (ou Authorization: Bearer ...)
 */
exports.introspect = async (req, res) => {
    try {
        const token = req.body?.token || bearerToken(req);
        if (!token) return res.status(400).json({ active: false, error: 'missing token' });

        const resolved = await resolveTenantAuth(token);
        if (!resolved) return res.json({ active: false });

        const tenantId = resolved.user.tenantId || resolved?.pat?.tenantId || null;
        const exp = resolved.source === 'jwt' ? resolved.decoded?.exp : expFromPat(resolved.pat);

        return res.json({
            active: true,
            sub: String(resolved.user._id),
            roles: resolved.user.roles || [],
            scopes: resolved.user.scopes || [],
            tenantId,
            tenants: tenantId ? [String(tenantId)] : [],
            defaultTenant: tenantId,
            exp,
            iss: cfg.tenant.iss,
            aud: cfg.tenant.aud,
            token_type: resolved.source,
        });
    } catch (e) {
        return res.status(500).json({ active: false, error: e.message });
    }
};

/**
 * GET /auth/tenant/me
 * header: Authorization: Bearer <token-tenant>
 */
exports.me = async (req, res) => {
    try {
        const resolved = await resolveTenantAuth(bearerToken(req));
        if (!resolved) return res.status(401).json({ error: 'invalid or missing token' });

        return res.json(publicUser(resolved.user));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};

/**
 * GET /auth/tenant/userinfo
 * header: Authorization: Bearer <token-tenant>
 */
exports.userinfo = async (req, res) => {
    try {
        const resolved = await resolveTenantAuth(bearerToken(req));
        if (!resolved) return res.status(401).json({ error: 'invalid or missing token' });

        const tenantId = resolved.user.tenantId || resolved?.pat?.tenantId || null;
        const exp = resolved.source === 'jwt' ? resolved.decoded?.exp : expFromPat(resolved.pat);

        return res.json({
            sub: String(resolved.user._id),
            roles: resolved.user.roles || [],
            scopes: resolved.user.scopes || [],
            tenantId,
            tenants: tenantId ? [String(tenantId)] : [],
            defaultTenant: tenantId,
            exp,
            iss: cfg.tenant.iss,
            aud: cfg.tenant.aud,
            token_type: resolved.source,
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};

/**
 * POST /auth/tenant/pats
 * header: Authorization: Bearer <tenant>
 * body: { label?: string, expiresInDays?: number }
 */
exports.createPat = async (req, res) => {
    try {
        const resolved = await resolveTenantAuth(bearerToken(req));
        if (!resolved) return res.status(401).json({ error: 'invalid or missing token' });

        const { label = null, expiresInDays = null } = req.body || {};
        const expiresNum = Number.isFinite(Number(expiresInDays)) ? Number(expiresInDays) : null;

        const { token, pat } = await mintPat({
            user: resolved.user,
            kind: 'tenant',
            label,
            expiresInDays: expiresNum,
        });

        return res.status(201).json({
            token,
            pat: {
                id: String(pat._id),
                label: pat.label,
                createdAt: pat.createdAt,
                expiresAt: pat.expiresAt,
                lastUsedAt: pat.lastUsedAt,
            },
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};

/**
 * GET /auth/tenant/pats
 * header: Authorization: Bearer <tenant>
 */
exports.listPats = async (req, res) => {
    try {
        const resolved = await resolveTenantAuth(bearerToken(req));
        if (!resolved) return res.status(401).json({ error: 'invalid or missing token' });

        const rows = await listPatsForUser({ userId: resolved.user._id, kind: 'tenant' });
        return res.json({
            pats: rows.map((p) => ({
                id: String(p._id),
                label: p.label,
                createdAt: p.createdAt,
                expiresAt: p.expiresAt,
                lastUsedAt: p.lastUsedAt,
            })),
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};

/**
 * DELETE /auth/tenant/pats/:patId
 * header: Authorization: Bearer <tenant>
 */
exports.revokePat = async (req, res) => {
    try {
        const resolved = await resolveTenantAuth(bearerToken(req));
        if (!resolved) return res.status(401).json({ error: 'invalid or missing token' });

        const patId = req.params?.patId;
        if (!patId) return res.status(400).json({ error: 'patId required' });

        const ok = await revokePat({ userId: resolved.user._id, kind: 'tenant', patId });
        if (!ok) return res.status(404).json({ error: 'pat not found' });

        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};
