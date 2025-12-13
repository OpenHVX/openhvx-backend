// @ts-nocheck
// models/user.base.model.js
const mongoose = require('mongoose');

// `kind` is the Mongoose discriminator and stored value (`tenant`|`admin`);
// do not confuse with auth scopes/roles and avoid renaming without migrating data.
const Base = new mongoose.Schema({
    kind: { type: String, required: true, enum: ['tenant', 'admin'] },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
    username: { type: String, lowercase: true, trim: true, default: null },
    passwordHash: { type: String, required: true, select: false },
    roles: { type: [String], default: [] },
    // `scopes` are fine-grained permissions attached to JWTs/PATs (e.g. platform.admin),
    // distinct from roles and unrelated to the discriminator `kind`.
    scopes: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
}, { timestamps: true, discriminatorKey: 'kind' });

module.exports = mongoose.model('User', Base);
