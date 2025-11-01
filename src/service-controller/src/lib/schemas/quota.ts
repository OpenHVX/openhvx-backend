// @ts-nocheck
// lib/schemas/quota.js
"use strict";

/**
 * Quota validation schemas
 * ------------------------
 * Central place for all quota-related shapes:
 *  - limits schema (flat limits)  -> reused by tenant create/update
 *  - reserve body (deltas)
 *  - recalc body (full inventory)
 *  - vm spec (for delta previews)
 */

const {
    validate,
    objectStrict,
    optional,
    recordOf,
    isString,
    isInteger,
    isEnum,
} = require("../validate");

// ---- primitives -------------------------------------------------------------

const intGE0 = (v) => isInteger(v) && v >= 0;
const limitInt = (v) => isInteger(v) && (v === -1 || v >= 0);
const idStr = (v) => isString(v) && v.length > 0;

// ---- Public: flat limits schema (to reuse in tenant.js) --------------------
const QuotaLimitsSchema = objectStrict({
    cpu: optional(limitInt),
    memoryMB: optional(limitInt),
    storageMB: optional(limitInt),
    vmCount: optional(limitInt),
    networkCount: optional(limitInt),
});

// ---- Reserve (deltas) ------------------------------------------------------

const QuotaDeltasSchema = objectStrict({
    cpu: optional(intGE0),
    memoryMB: optional(intGE0),
    storageMB: optional(intGE0),
    vmCount: optional(intGE0),
    networkCount: optional(intGE0),
});

const reserveBody = objectStrict({
    deltas: QuotaDeltasSchema,
});

// ---- Recalculate (inventory) -----------------------------------------------

const diskItem = objectStrict({
    sizeMB: optional(intGE0),
    sizeMiB: optional(intGE0),
    sizeGB: optional(intGE0),
});

const vmSpec = objectStrict({
    cpu: optional(intGE0),
    vCPU: optional(intGE0),
    memoryMB: optional(intGE0),
    memoryMiB: optional(intGE0),
    disks: optional((v) => Array.isArray(v) && v.every((d) => validate(diskItem, d).ok)),
});

const vmItemLoose = (v) => {
    if (typeof v !== "object" || v == null) return false;
    const idish = ["id", "uuid", "_id", "name"].some((k) => v[k] == null || typeof v[k] === "string");
    const cpuOk = (v.cpu == null || intGE0(v.cpu)) && (v.vCPU == null || intGE0(v.vCPU));
    const memOk = (v.memoryMB == null || intGE0(v.memoryMB)) && (v.memoryMiB == null || intGE0(v.memoryMiB));
    const disksOk = v.disks == null || (Array.isArray(v.disks) && v.disks.every((d) => validate(diskItem, d).ok));
    return idish && cpuOk && memOk && disksOk;
};

const netItemLoose = (v) => {
    if (typeof v !== "object" || v == null) return false;
    const tIdOk = v.tenantId == null || idStr(v.tenantId);
    const tsOk = v.tenants == null || (Array.isArray(v.tenants) && v.tenants.every(idStr));
    return tIdOk && tsOk;
};

const recalcBody = objectStrict({
    tenantId: idStr,
    fullInventory: objectStrict({
        vms: optional((v) => Array.isArray(v) && v.every(vmItemLoose)),
        networks: optional((v) => Array.isArray(v) && v.every(netItemLoose)),
    }),
    tenantResourceLinks: optional((v) => typeof v === "object"),
});

// ---- API -------------------------------------------------------------------

function validatePatchLimits(body) { // expects { limits: QuotaLimitsSchema }
    return validate(objectStrict({ limits: QuotaLimitsSchema }), body);
}
function validateReserveBody(body) { return validate(reserveBody, body); }
function validateRecalcBody(body) { return validate(recalcBody, body); }
function validateVmSpec(spec) { return validate(vmSpec, spec); }

/** Helper: normalize flat limits -> model shape { key: { limit, used: 0 } } */
function normalizeQuota(quotas) {
    if (!quotas || typeof quotas !== "object") return undefined;
    const out = {};
    const keys = ["cpu", "memoryMB", "storageMB", "vmCount", "networkCount"];
    for (const k of keys) {
        if (quotas[k] == null) continue;
        const limit = quotas[k] | 0;
        out[k] = { limit, used: 0 };
    }
    return Object.keys(out).length ? out : undefined;
}

module.exports = {
    // Schemas / validators
    QuotaLimitsSchema,
    validatePatchLimits,
    validateReserveBody,
    validateRecalcBody,
    validateVmSpec,
    normalizeQuota,
};
