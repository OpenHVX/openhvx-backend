const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
    {
        // Optionnel, conservé pour compat
        username: { type: String, trim: true, lowercase: true, index: true, default: null },

        // ⬇️ email = identifiant unique global
        email: { type: String, trim: true, lowercase: true, required: true },

        passwordHash: { type: String, required: true, select: false },

        // ⬇️ requis sauf pour global-admin
        tenantId: {
            type: String,
            required: function () {
                return !(Array.isArray(this.roles) && this.roles.includes('global-admin'));
            },
            default: null,
        },

        roles: { type: [String], default: [] },
        scopes: { type: [String], default: [] },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

// Indexes
UserSchema.index({ email: 1 }, { unique: true }); // email unique global
UserSchema.index(
    { tenantId: 1, username: 1 },
    { unique: true, sparse: true } // username optionnel, unique par tenant si utilisé
);

module.exports = mongoose.model('User', UserSchema);
