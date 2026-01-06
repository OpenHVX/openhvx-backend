// Schema and validation for resource-related payloads

import {
    arrayOf,
    isEnum,
    isString,
    objectStrict,
    optional,
    validate,
} from "../validate";
import type { ValidationResult } from "../validate";
import type { ResourceKind } from "../../types/domain";

type ClaimKind = Extract<ResourceKind, "vm" | "switch" | "storage">;

const isBoolean = isEnum([true, false] as const);

export interface ListResourcesQueryShape extends Record<string, unknown> {
    kind?: ClaimKind;
    agentId?: string;
    includeOrphans?: string;
}

export interface ClaimResourceBody extends Record<string, unknown> {
    kind: ClaimKind;
    agentId: string;
    refIds: string[];
    ha?: boolean;
}

export interface UnclaimParamsShape extends Record<string, unknown> {
    resourceId: string;
}

export interface UnclaimQueryShape extends Record<string, unknown> {
    kind: ClaimKind;
    agentId: string;
}

export interface UnassignedQueryShape extends Record<string, unknown> {
    kind?: ClaimKind;
    agentId?: string;
    limit?: string;
}

const RESOURCE_KIND_VALUES = ["vm", "switch", "storage"] as const;

const ListResourcesQuery = objectStrict<ListResourcesQueryShape>({
    kind: optional(isEnum(RESOURCE_KIND_VALUES)),
    agentId: optional(isString),
    includeOrphans: optional(isString),
});

const ClaimBody = objectStrict<ClaimResourceBody>({
    kind: isEnum(RESOURCE_KIND_VALUES),
    agentId: isString,
    refIds: arrayOf(isString),
    ha: optional(isBoolean),
});

const UnclaimParams = objectStrict<UnclaimParamsShape>({
    resourceId: isString,
});

const UnclaimQuery = objectStrict<UnclaimQueryShape>({
    kind: isEnum(RESOURCE_KIND_VALUES),
    agentId: isString,
});

const UnassignedQuery = objectStrict<UnassignedQueryShape>({
    kind: optional(isEnum(RESOURCE_KIND_VALUES)),
    agentId: optional(isString),
    limit: optional(isString),
});

export function validateListQuery(q: unknown): ValidationResult<ListResourcesQueryShape> {
    return validate(ListResourcesQuery, q || {});
}

export function validateClaimBody(b: unknown): ValidationResult<ClaimResourceBody> {
    return validate(ClaimBody, b || {});
}

export function validateUnclaimParams(p: unknown): ValidationResult<UnclaimParamsShape> {
    return validate(UnclaimParams, p || {});
}

export function validateUnclaimQuery(q: unknown): ValidationResult<UnclaimQueryShape> {
    return validate(UnclaimQuery, q || {});
}

export function validateUnassignedQuery(q: unknown): ValidationResult<UnassignedQueryShape> {
    return validate(UnassignedQuery, q || {});
}
