import { arrayOf, isInteger, isString, objectStrict, validate } from "../validate";
import type { ValidationResult } from "../validate";
import type { ElectionRequirements } from "../../types/domain";

export interface ElectionPayload extends Record<string, unknown> {
    requirements: ElectionRequirements;
}

export const AgentsSchema = objectStrict<ElectionPayload>({
    requirements: objectStrict({
        freshness: isInteger,
        capabilities: arrayOf(isString),
    }),
});

export function validateElectionPayload(body: unknown): ValidationResult<ElectionPayload> {
    return validate(AgentsSchema, body);
}
