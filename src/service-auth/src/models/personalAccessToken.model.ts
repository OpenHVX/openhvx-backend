// @ts-nocheck
const mongoose = require('mongoose');

const PersonalAccessTokenSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
        kind: { type: String, enum: ['tenant', 'admin'], required: true, index: true },
        tenantId: { type: String, default: null, index: true },
        label: { type: String, default: null },
        tokenHash: { type: String, required: true, unique: true },
        lastUsedAt: { type: Date, default: null },
        expiresAt: { type: Date, default: null },
        revokedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

PersonalAccessTokenSchema.index({ userId: 1, kind: 1, revokedAt: 1 });
PersonalAccessTokenSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: 'date' } } },
);

module.exports = mongoose.model('PersonalAccessToken', PersonalAccessTokenSchema);
