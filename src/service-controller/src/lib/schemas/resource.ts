// @ts-nocheck
// lib/schemas/resource.js (CommonJS)
// Contracts for resources endpoints, using lib/validate.js

const {
    validate,
    objectStrict,
    optional,
    arrayOf,
    isString,
    isEnum,
} = require('../validate');

// GET /.../resources (query)
const ListResourcesQuery = objectStrict({
    kind: optional(isEnum(['vm', 'switch', 'disk'])),
    agentId: optional(isString),
    includeOrphans: optional(isString), // 'true' | 'false' (parsed later)
});

// POST /.../resources/claim (body)
const ClaimBody = objectStrict({
    kind: isString,
    agentId: isString,
    refIds: arrayOf(isString), // non-empty check is done in controller (see note)
});

// DELETE /.../resources/:resourceId (params + query)
const UnclaimParams = objectStrict({
    resourceId: isString,
});
const UnclaimQuery = objectStrict({
    kind: isString,
    agentId: isString,
});

// GET /admin/resources/unassigned (query)
const UnassignedQuery = objectStrict({
    kind: optional(isEnum(['vm', 'switch', 'disk'])),
    agentId: optional(isString),
    limit: optional(isString), // parsed to int later
});

// Thin wrappers returning { ok, value, errors }
function validateListQuery(q) { return validate(ListResourcesQuery, q || {}); }
function validateClaimBody(b) { return validate(ClaimBody, b || {}); }
function validateUnclaimParams(p) { return validate(UnclaimParams, p || {}); }
function validateUnclaimQuery(q) { return validate(UnclaimQuery, q || {}); }
function validateUnassignedQuery(q) { return validate(UnassignedQuery, q || {}); }

module.exports = {
    validateListQuery,
    validateClaimBody,
    validateUnclaimParams,
    validateUnclaimQuery,
    validateUnassignedQuery,
};
