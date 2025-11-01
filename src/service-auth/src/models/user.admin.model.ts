// @ts-nocheck

// models/user.admin.model.js

const User = require('./user.base.model');
const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema({/* no tenantId here */ });

AdminSchema.pre('validate', function (next) {
    // Always enforce admin role/scope
    if (!Array.isArray(this.roles)) this.roles = [];
    if (!this.roles.includes('global-admin')) this.roles.push('global-admin');

    if (!Array.isArray(this.scopes)) this.scopes = [];
    if (!this.scopes.includes('platform.admin')) this.scopes.push('platform.admin');
    next();
});

module.exports = User.discriminator('admin', AdminSchema);
