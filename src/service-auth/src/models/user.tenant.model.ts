// @ts-nocheck
const User = require('./user.base.model');
const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
});

const FORBIDDEN_ROLES = ['global-admin'];
const FORBIDDEN_SCOPES = ['platform.admin'];

function hasForbidden(values, forbidden) {
    return (values || []).some((v) => forbidden.includes(v));
}

// Hard guardrails: tenant users must never carry admin scope/role
TenantSchema.pre('validate', function (next) {
    const hasAdmin = hasForbidden(this.roles, FORBIDDEN_ROLES) || hasForbidden(this.scopes, FORBIDDEN_SCOPES);
    if (hasAdmin) return next(new Error('tenant user cannot have admin privileges'));
    if (!this.tenantId) return next(new Error('tenantId is required for tenant user'));
    next();
});

// Also protect update operations that bypass document validation by default.
function assertNoAdminInUpdate(update) {
    const ops = ['$set', '$push', '$addToSet', '$setOnInsert'];
    const pickVals = (val) => {
        if (val == null) return [];
        if (Array.isArray(val)) return val;
        if (val.$each) return val.$each;
        return [val];
    };

    const rolesCandidates = [];
    const scopesCandidates = [];

    if (update.roles) rolesCandidates.push(...pickVals(update.roles));
    if (update.scopes) scopesCandidates.push(...pickVals(update.scopes));

    for (const op of ops) {
        if (update[op]?.roles) rolesCandidates.push(...pickVals(update[op].roles));
        if (update[op]?.scopes) scopesCandidates.push(...pickVals(update[op].scopes));
    }

    if (hasForbidden(rolesCandidates, FORBIDDEN_ROLES) || hasForbidden(scopesCandidates, FORBIDDEN_SCOPES)) {
        throw new Error('tenant user cannot have admin privileges');
    }
}

['updateOne', 'findOneAndUpdate', 'updateMany'].forEach((hook) => {
    TenantSchema.pre(hook, function (next) {
        try {
            assertNoAdminInUpdate(this.getUpdate() || {});
            next();
        } catch (e) {
            next(e);
        }
    });
});

module.exports = User.discriminator('tenant', TenantSchema);
