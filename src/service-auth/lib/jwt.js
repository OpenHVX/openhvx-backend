const jwt = require('jsonwebtoken');

const cfg = {
    tenant: {
        iss: process.env.JWT_TENANT_ISS || 'auth-service/tenant',
        aud: process.env.JWT_TENANT_AUD || 'api://tenant',
        secret: process.env.JWT_TENANT_SECRET || 'dev_tenant_secret',
        expiresIn: process.env.JWT_TENANT_EXPIRES || '8h',
    },
    admin: {
        iss: process.env.JWT_ADMIN_ISS || 'auth-service/admin',
        aud: process.env.JWT_ADMIN_AUD || 'api://admin',
        secret: process.env.JWT_ADMIN_SECRET || 'dev_admin_secret',
        expiresIn: process.env.JWT_ADMIN_EXPIRES || '30m',
    }
};

function signTenant(u) {
    const payload = {
        sub: String(u._id),
        roles: u.roles || [],
        scopes: u.scopes || [],
        tenantId: String(u.tenantId),
        aud: cfg.tenant.aud,
    };
    return jwt.sign(payload, cfg.tenant.secret, { issuer: cfg.tenant.iss, expiresIn: cfg.tenant.expiresIn });
}

function signAdmin(u) {
    const payload = {
        sub: String(u._id),
        roles: u.roles || [],
        scopes: u.scopes || [],
        aud: cfg.admin.aud,
    };
    return jwt.sign(payload, cfg.admin.secret, { issuer: cfg.admin.iss, expiresIn: cfg.admin.expiresIn });
}

function verifyTenant(token) {
    return jwt.verify(token, cfg.tenant.secret, { issuer: cfg.tenant.iss, audience: cfg.tenant.aud });
}
function verifyAdmin(token) {
    return jwt.verify(token, cfg.admin.secret, { issuer: cfg.admin.iss, audience: cfg.admin.aud });
}

module.exports = { cfg, signTenant, signAdmin, verifyTenant, verifyAdmin };
