import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response, RequestHandler } from "express";

interface PolicyDefinition {
    actions?: Record<string, string[]>;
}

interface ApplyPolicyOptions {
    strip?: boolean;
}

const ensureJsonExt = (name: string): string => (name.endsWith(".json") ? name : `${name}.json`);

const loadPolicyByName = (name: string): PolicyDefinition => {
    const file = ensureJsonExt(name);
    const candidates = [
        path.resolve(process.cwd(), "policies", file),
        path.resolve(__dirname, "..", "policies", file),
    ];

    for (const candidate of candidates) {
        try {
            const content = fs.readFileSync(candidate, "utf8");
            // eslint-disable-next-line no-console
            console.log(`[policy] loaded: ${candidate}`);
            return JSON.parse(content) as PolicyDefinition;
        } catch {
            // try next candidate
        }
    }

    throw new Error(`Policy not found: ${file} (searched in: ${candidates.join(" | ")})`);
};

const applyPolicy = (policyName: string, { strip = false }: ApplyPolicyOptions = {}): RequestHandler => {
    let policy: PolicyDefinition;
    try {
        policy = loadPolicyByName(policyName);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[policy] load error:", (error as Error).message);
        policy = { actions: {} };
    }

    return (req: Request, res: Response, next: NextFunction) => {
        if (req.isAdmin) {
            next();
            return;
        }

        const action = String(req.body?.action ?? "").toLowerCase();
        const data = req.body?.data;
        if (!action || typeof data !== "object" || data === null) {
            next();
            return;
        }

        const denyList = policy.actions?.[action];
        if (!Array.isArray(denyList) || denyList.length === 0) {
            next();
            return;
        }

        const hits = denyList.filter((key) => Object.prototype.hasOwnProperty.call(data, key));
        if (hits.length === 0) {
            next();
            return;
        }

        if (strip) {
            hits.forEach((key) => delete (data as Record<string, unknown>)[key]);
            next();
            return;
        }

        res.status(403).json({ error: "Forbidden field(s) for tenants", fields: hits });
    };
};

export default applyPolicy;
