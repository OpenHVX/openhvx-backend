import {
    arrayOf,
    isInteger,
    isString,
    objectStrict,
    optional,
    validate,
} from "../validate";
import type { ValidationResult } from "../validate";
import type { QuotaDeltas, QuotaItem, QuotaKey, QuotaLimits } from "../../types/domain";

type FlatQuota = Partial<Record<QuotaKey, number>>;

const intGE0 = (value: unknown, path = "") => {
    const n = isInteger(value, path);
    if (n < 0) throw new Error(`${path || "value"}: must be >= 0`);
    return n;
};

const limitInt = (value: unknown, path = "") => {
    const n = isInteger(value, path);
    if (n < -1) throw new Error(`${path || "value"}: must be -1 or >= 0`);
    return n;
};

const idStr = (value: unknown, path = "") => {
    const s = isString(value, path);
    if (!s.length) throw new Error(`${path || "value"}: must not be empty`);
    return s;
};

export const QuotaLimitsSchema = objectStrict<QuotaLimits>({
    cpu: optional(limitInt),
    memoryMB: optional(limitInt),
    storageMB: optional(limitInt),
    vmCount: optional(limitInt),
    networkCount: optional(limitInt),
});

const QuotaDeltasSchema = objectStrict<QuotaDeltas>({
    cpu: optional(intGE0),
    memoryMB: optional(intGE0),
    storageMB: optional(intGE0),
    vmCount: optional(intGE0),
    networkCount: optional(intGE0),
});

export interface ReserveBody extends Record<string, unknown> {
    deltas: QuotaDeltas;
}

const reserveBody = objectStrict<ReserveBody>({
    deltas: QuotaDeltasSchema,
});

interface DiskItem extends Record<string, unknown> {
    sizeMB?: number;
    sizeMiB?: number;
    sizeGB?: number;
}

const diskItem = objectStrict<DiskItem>({
    sizeMB: optional(intGE0),
    sizeMiB: optional(intGE0),
    sizeGB: optional(intGE0),
});

export interface VmSpec extends Record<string, unknown> {
    cpu?: number;
    vCPU?: number;
    memoryMB?: number;
    memoryMiB?: number;
    disks?: DiskItem[];
}

const vmSpec = objectStrict<VmSpec>({
    cpu: optional(intGE0),
    vCPU: optional(intGE0),
    memoryMB: optional(intGE0),
    memoryMiB: optional(intGE0),
    disks: optional(arrayOf(diskItem)),
});

type VmItemLoose = Record<string, unknown> & {
    id?: string;
    uuid?: string;
    _id?: string;
    name?: string;
    cpu?: number;
    vCPU?: number;
    memoryMB?: number;
    memoryMiB?: number;
    disks?: DiskItem[];
};

const vmItemLoose = (value: unknown): value is VmItemLoose => {
    if (typeof value !== "object" || value == null) return false;
    const v = value as VmItemLoose;
    const hasId = ["id", "uuid", "_id", "name"].some((k) => v[k as keyof VmItemLoose] == null || typeof v[k as keyof VmItemLoose] === "string");
    const cpuOk = (v.cpu == null || (typeof v.cpu === "number" && v.cpu >= 0)) &&
        (v.vCPU == null || (typeof v.vCPU === "number" && v.vCPU >= 0));
    const memOk = (v.memoryMB == null || (typeof v.memoryMB === "number" && v.memoryMB >= 0)) &&
        (v.memoryMiB == null || (typeof v.memoryMiB === "number" && v.memoryMiB >= 0));
    const disksOk =
        v.disks == null ||
        (Array.isArray(v.disks) && v.disks.every((d) => validate(diskItem, d).ok));
    return hasId && cpuOk && memOk && disksOk;
};

type NetworkItemLoose = Record<string, unknown> & {
    tenantId?: string;
    tenants?: string[];
};

const netItemLoose = (value: unknown): value is NetworkItemLoose => {
    if (typeof value !== "object" || value == null) return false;
    const v = value as NetworkItemLoose;
    const tenantOk = v.tenantId == null || typeof v.tenantId === "string";
    const tenantsOk =
        v.tenants == null ||
        (Array.isArray(v.tenants) && v.tenants.every((t) => typeof t === "string"));
    return tenantOk && tenantsOk;
};

export interface RecalcBody extends Record<string, unknown> {
    tenantId?: string;
}

const recalcBody = objectStrict<RecalcBody>({
    tenantId: optional(idStr),
});

export function validatePatchLimits(body: unknown): ValidationResult<{ limits: QuotaLimits }> {
    return validate(
        objectStrict({
            limits: QuotaLimitsSchema,
        }),
        body
    );
}

export function validateReserveBody(body: unknown): ValidationResult<ReserveBody> {
    return validate(reserveBody, body);
}

export function validateRecalcBody(body: unknown): ValidationResult<RecalcBody> {
    return validate(recalcBody, body);
}

export function validateVmSpec(body: unknown): ValidationResult<VmSpec> {
    return validate(vmSpec, body);
}

export function normalizeQuota(
    quotas: FlatQuota | undefined | null
): Partial<Record<QuotaKey, QuotaItem>> | undefined {
    if (!quotas || typeof quotas !== "object") return undefined;
    const out: Record<string, QuotaItem> = {};
    (Object.keys(quotas) as QuotaKey[]).forEach((key) => {
        const value = quotas[key];
        if (value == null) return;
        const limit = Number(value) | 0;
        out[key] = { limit, used: 0 };
    });
    return Object.keys(out).length ? (out as Partial<Record<QuotaKey, QuotaItem>>) : undefined;
}
