// src/service-controller/src/services/resourceLocks.ts
// Service for acquiring and releasing resource locks

import ResourceLock, { type ResourceKind } from "../models/ResourceLock";
import { ERR, type HttpErrorPayload } from "../lib/errors/http-errors";
import logger from "../lib/logger";

const log = logger.child(["locks", "resource"]);

interface AcquireLockInput {
    resourceKind: ResourceKind;
    refId: string;
    taskId: string;
    tenantId?: string;
    agentId?: string;
    action?: string;
    ttlMs: number;
}

export async function acquireResourceLock(input: AcquireLockInput): Promise<void> {
    const { resourceKind, refId, taskId, tenantId, agentId, action } = input;
    const ttlMs = Math.max(1, input.ttlMs || 0);
    const expiresAt = new Date(Date.now() + ttlMs);

    // Fast path: bail early if already locked (avoids throwing duplicate key on create).
    const existing = await ResourceLock.findOne({ resourceKind, refId }).lean();
    if (existing) {
        if (existing.taskId === taskId) {
            // Idempotent retry from the same task.
            return;
        }
        const err = ERR.resourceLocked(resourceKind, refId);
        log.warn("lock denied (already held)", { resourceKind, refId, taskId, holder: existing.taskId });
        throw err;
    }

    try {
        await ResourceLock.create({
            resourceKind,
            refId,
            taskId,
            tenantId,
            agentId,
            action,
            expiresAt,
        });
        log.debug("lock acquired", { resourceKind, refId, taskId, expiresAt });
    } catch (error) {
        const code = (error as { code?: number } | undefined)?.code;
        if (code === 11000) {
            const err = ERR.resourceLocked(resourceKind, refId);
            log.warn("lock denied (duplicate key)", { resourceKind, refId, taskId });
            throw err;
        }
        throw error;
    }
}

export async function releaseLocksForTask(taskId: string): Promise<void> {
    // Best-effort cleanup: remove all locks held by a task once it is done/failed.
    const res = await ResourceLock.deleteMany({ taskId });
    if (res.deletedCount) {
        log.info("locks released", { taskId, count: res.deletedCount });
    }
}

export function isHttpErrorPayload(error: unknown): error is HttpErrorPayload {
    return (
        !!error &&
        typeof error === "object" &&
        "status" in error &&
        "code" in error &&
        typeof (error as HttpErrorPayload).status === "number" &&
        typeof (error as HttpErrorPayload).code === "string"
    );
}
