// @ts-nocheck
const User = require('./user.base.model');
const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
});

// Hard guardrails: tenant users must never carry admin scope/role
TenantSchema.pre('validate', function (next) {
    const hasAdmin = (this.roles || []).includes('global-admin') || (this.scopes || []).includes('platform.admin');
    if (hasAdmin) return next(new Error('tenant user cannot have admin privileges'));
    if (!this.tenantId) return next(new Error('tenantId is required for tenant user'));
    next();
});

module.exports = User.discriminator('tenant', TenantSchema);
