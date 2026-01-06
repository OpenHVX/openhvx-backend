// Schema and validation for tenant-related payloads

import {
    isEnum,
    isString,
    objectStrict,
    optional,
    recordOf,
    validate,
} from "../validate";
import type { ValidationResult } from "../validate";
import type { QuotaItem, QuotaKey, QuotaLimits } from "../../types/domain";
import { QuotaLimitsSchema, normalizeQuota } from "./quota";

export interface TenantIdParamsShape extends Record<string, unknown> {
    tenantId: string;
}

type NormalizedQuota = Partial<Record<QuotaKey, QuotaItem>>;

export interface TenantCreateBodyShape extends Record<string, unknown> {
    tenantId: string;
    name: string;
    description?: string;
    quotas?: QuotaLimits;
    metadata?: Record<string, string>;
    status?: "active" | "disabled";
}

export interface TenantUpdateBodyShape extends Record<string, unknown> {
    name?: string;
    status?: "active" | "disabled";
    description?: string;
    quotas?: QuotaLimits;
    metadata?: Record<string, string>;
}

const isStatus = isEnum(["active", "disabled"] as const);
const MetadataSchema = recordOf(isString);

const TenantIdParams = objectStrict<TenantIdParamsShape>({
    tenantId: isString,
});

const TenantCreateBody = objectStrict<TenantCreateBodyShape>({
    tenantId: isString,
    name: isString,
    description: optional(isString),
    quotas: optional(QuotaLimitsSchema),
    metadata: optional(MetadataSchema),
    status: optional(isStatus),
});

const TenantUpdateBody = objectStrict<TenantUpdateBodyShape>({
    name: optional(isString),
    status: optional(isStatus),
    description: optional(isString),
    quotas: optional(QuotaLimitsSchema),
    metadata: optional(MetadataSchema),
});

export function validateCreate(body: unknown): ValidationResult<TenantCreateBodyShape> {
    return validate(TenantCreateBody, body || {});
}

export function validateUpdate(body: unknown): ValidationResult<TenantUpdateBodyShape> {
    return validate(TenantUpdateBody, body || {});
}

export function validateParams(params: unknown): ValidationResult<TenantIdParamsShape> {
    return validate(TenantIdParams, params || {});
}

type Normalized<T> = Omit<T, "quotas"> & { quotas?: NormalizedQuota };

function normalizeValue<T extends { quotas?: QuotaLimits }>(value: T): Normalized<T> {
    const out = { ...value } as Normalized<T>;

    if ((out as Record<string, unknown>).tenantId && typeof (out as Record<string, unknown>).tenantId === "string") {
        (out as Record<string, string>).tenantId = (out as Record<string, string>).tenantId.trim().toLowerCase();
    }

    if (value.quotas) {
        const normalized = normalizeQuota(value.quotas);
        if (normalized) {
            out.quotas = normalized;
        } else {
            delete out.quotas;
        }
    }
    return out;
}

export function normalizeCreate(value: TenantCreateBodyShape): Normalized<TenantCreateBodyShape> {
    return normalizeValue(value);
}

export function normalizeUpdate(value: TenantUpdateBodyShape): Normalized<TenantUpdateBodyShape> {
    return normalizeValue(value);
}
