import type { Response } from "express";
import type { ControllerRequest } from "../types/express";

export type ApiScope = "tenant" | "admin";

export const envelope = <T>(
    scope: ApiScope,
    kind: string,
    data: T
) => ({
    schemaVersion: "1.0.0",
    scope,
    kind,
    ...data,
});

export const scopeForReq = (req: ControllerRequest): ApiScope => (req.isAdmin ? "admin" : "tenant");

export const respondEnvelope = <T>(
    res: Response,
    req: ControllerRequest,
    kind: string,
    data: T
) => {
    (req as { envelopeKind?: string }).envelopeKind = kind;
    return res.json(envelope(scopeForReq(req), kind, data));
};