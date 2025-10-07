// lib/schemas/tenant.js (CommonJS)
// Contract validation for Tenants, using your lib/validate.js

const {
    validate,
    objectStrict,
    optional,
    recordOf,
    isString,
    isInteger,
    isEnum,
} = require('../validate');

// If you don’t have fixed statuses, keep it a string:
// const isStatus = isString;
const isStatus = isEnum(['active', 'disabled']); // adjust if needed

// Basic shape for quotas commonly used in your project
const QuotasSchema = objectStrict({
    vcpu: optional(isInteger),
    ramMB: optional(isInteger),
    storageGB: optional(isInteger),
});

// Free-form metadata as a string record (adjust validator if you need numbers/booleans)
const MetadataSchema = recordOf(isString);

// Params: /tenants/:tenantId
const TenantIdParams = objectStrict({
    tenantId: isString,
});

// Body: POST /tenants
const TenantCreateBody = objectStrict({
    tenantId: isString,
    name: isString,
    quotas: optional(QuotasSchema),
    metadata: optional(MetadataSchema),
});

// Body: PATCH /tenants/:tenantId
const TenantUpdateBody = objectStrict({
    name: optional(isString),
    status: optional(isStatus),   // or optional(isString)
    quotas: optional(QuotasSchema),
    metadata: optional(MetadataSchema),
});

// Helpers for controllers
function validateCreate(body) { return validate(TenantCreateBody, body || {}); }
function validateUpdate(body) { return validate(TenantUpdateBody, body || {}); }
function validateParams(p) { return validate(TenantIdParams, p || {}); }

module.exports = {
    validateCreate,
    validateUpdate,
    validateParams,
};
