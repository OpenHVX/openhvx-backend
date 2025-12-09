// @ts-nocheck
const crypto = require('node:crypto');
const PersonalAccessToken = require('../models/personalAccessToken.model');
const UserAdmin = require('../models/user.admin.model');
const UserTenant = require('../models/user.tenant.model');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(token || '').digest('hex');
const generateRawToken = (kind) => `pat-${kind}-${crypto.randomBytes(24).toString('hex')}`;

const expiryFromDays = (days) => {
    if (!Number.isFinite(days) || days <= 0) return null;
    return new Date(Date.now() + days * ONE_DAY_MS);
};

async function mintPat({ user, kind, label, expiresInDays }) {
    const tenantId = kind === 'tenant' ? String(user.tenantId || '') : null;
    const expiresAt = expiryFromDays(expiresInDays);

    for (let attempt = 0; attempt < 3; attempt++) {
        const token = generateRawToken(kind);
        const tokenHash = hashToken(token);
        try {
            const pat = await PersonalAccessToken.create({
                userId: user._id,
                kind,
                tenantId,
                label: label || null,
                tokenHash,
                expiresAt,
            });
            return { token, pat };
        } catch (e) {
            if (e?.code === 11000) continue; // collision on tokenHash, retry
            throw e;
        }
    }
    throw new Error('Unable to issue PAT (hash collision)');
}

async function verifyPatToken({ token, kind }) {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const now = new Date();

    const pat = await PersonalAccessToken.findOne({ tokenHash, kind, revokedAt: null }).lean();
    if (!pat) return null;
    if (pat.expiresAt && pat.expiresAt.getTime() < now.getTime()) return null;

    const Model = kind === 'tenant' ? UserTenant : UserAdmin;
    const user = await Model.findById(pat.userId).select('email username roles scopes tenantId isActive').lean();

    if (!user || user.isActive === false) return null;
    if (kind === 'tenant' && String(user.tenantId || '') !== String(pat.tenantId || user.tenantId || '')) return null;

    // Best-effort: track last usage
    PersonalAccessToken.updateOne({ _id: pat._id }, { $set: { lastUsedAt: now } }).catch(() => undefined);

    return { pat, user };
}

async function listPatsForUser({ userId, kind }) {
    return PersonalAccessToken.find({ userId, kind, revokedAt: null })
        .sort({ createdAt: -1 })
        .select('_id label createdAt lastUsedAt expiresAt tenantId');
}

async function revokePat({ userId, kind, patId }) {
    const res = await PersonalAccessToken.updateOne(
        { _id: patId, userId, kind, revokedAt: null },
        { $set: { revokedAt: new Date() } },
    );
    return res.modifiedCount > 0;
}

module.exports = { mintPat, verifyPatToken, listPatsForUser, revokePat };
