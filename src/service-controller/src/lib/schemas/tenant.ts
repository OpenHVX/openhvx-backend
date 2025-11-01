// @ts-nocheck
// lib/schemas/tenant.js
"use strict";

/**
 * Tenant contract validation
 * - Reuses QuotaLimitsSchema from lib/schemas/quota.js
 * - Provides normalizeCreate/normalizeUpdate using normalizeQuota
 */

const {
    validate,
    objectStrict,
    optional,
    recordOf,
    isString,
    isEnum,
} = require("../validate");

const {
    QuotaLimitsSchema,
    normalizeQuota,
} = require("./quota");

// Status enum
const isStatus = isEnum(["active", "disabled"]);

// Free-form metadata
const MetadataSchema = recordOf(isString);

// Params: /tenants/:tenantId
const TenantIdParams = objectStrict({
    tenantId: isString,
});

// Body: POST /tenants
const TenantCreateBody = objectStrict({
    tenantId: isString,
    name: isString,
    description: optional(isString),
    quotas: optional(QuotaLimitsSchema), // flat limits
    metadata: optional(MetadataSchema),
});

// Body: PATCH /tenants/:tenantId
const TenantUpdateBody = objectStrict({
    name: optional(isString),
    status: optional(isStatus),
    description: optional(isString),
    quotas: optional(QuotaLimitsSchema), // flat limits
    metadata: optional(MetadataSchema),
});

// Helpers for controllers
function validateCreate(body) { return validate(TenantCreateBody, body || {}); }
function validateUpdate(body) { return validate(TenantUpdateBody, body || {}); }
function validateParams(p) { return validate(TenantIdParams, p || {}); }

/** Normalize flat limits -> model shape */
function normalizeCreate(value) {
    const v = { ...value };
    if (v.quotas) {
        const q = normalizeQuota(v.quotas);
        if (q) v.quotas = q; else delete v.quotas;
    }
    return v;
}
function normalizeUpdate(value) {
    const v = { ...value };
    if (v.quotas) {
        const q = normalizeQuota(v.quotas);
        if (q) v.quotas = q; else delete v.quotas;
    }
    return v;
}

module.exports = {
    validateCreate,
    validateUpdate,
    validateParams,
    normalizeCreate,
    normalizeUpdate,
};
