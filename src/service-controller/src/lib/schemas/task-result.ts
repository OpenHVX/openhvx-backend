export interface TaskResultPayload {
  taskId: string;
  operationId?: string;
  commandFingerprint?: string;
  outcome?: "applied" | "not_applied" | "unknown";
  sequence?: number;
  eventId?: string;
  contractVersion?: number;
  tenantId?: string;
  action?: string;
  agentId?: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  finishedAt?: string;
}

export const parseTaskResult = (value: unknown): TaskResultPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.taskId !== "string" || !input.taskId.trim()) return null;
  if (typeof input.ok !== "boolean") return null;
  if (
    input.contractVersion !== undefined &&
    ![1, 2].includes(input.contractVersion as number)
  )
    return null;
  for (const key of [
    "eventId",
    "tenantId",
    "action",
    "operationId",
    "commandFingerprint",
  ]) {
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || !(input[key] as string).trim())
    )
      return null;
  }
  if (input.contractVersion === 1 && (!input.eventId || !input.agentId))
    return null;
  if (input.operationId !== undefined && input.operationId !== input.taskId)
    return null;
  if (
    input.outcome !== undefined &&
    !["applied", "not_applied", "unknown"].includes(input.outcome as string)
  )
    return null;
  if (input.outcome && input.ok !== (input.outcome === "applied")) return null;
  if (
    input.sequence !== undefined &&
    (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1)
  )
    return null;
  if (
    input.contractVersion === 2 &&
    (!input.eventId ||
      !input.agentId ||
      !input.tenantId ||
      !input.action ||
      !input.operationId ||
      !input.outcome ||
      !input.sequence ||
      !/^[a-f0-9]{64}$/.test(String(input.commandFingerprint)))
  )
    return null;

  if (
    input.agentId !== undefined &&
    (typeof input.agentId !== "string" || !input.agentId.trim())
  )
    return null;
  if (
    input.error !== undefined &&
    input.error !== null &&
    typeof input.error !== "string"
  )
    return null;
  if (
    input.result !== undefined &&
    input.result !== null &&
    (typeof input.result !== "object" || Array.isArray(input.result))
  ) {
    return null;
  }
  if (
    input.finishedAt !== undefined &&
    (typeof input.finishedAt !== "string" ||
      !Number.isFinite(new Date(input.finishedAt).getTime()))
  ) {
    return null;
  }
  return {
    taskId: input.taskId.trim(),
    ...(input.operationId ? { operationId: input.operationId as string } : {}),
    ...(input.commandFingerprint
      ? { commandFingerprint: input.commandFingerprint as string }
      : {}),
    ...(input.outcome
      ? { outcome: input.outcome as TaskResultPayload["outcome"] }
      : {}),
    ...(input.sequence ? { sequence: input.sequence as number } : {}),
    ...(input.eventId ? { eventId: input.eventId as string } : {}),
    ...(input.tenantId ? { tenantId: input.tenantId as string } : {}),
    ...(input.action ? { action: input.action as string } : {}),
    ...(input.contractVersion
      ? { contractVersion: input.contractVersion as number }
      : {}),
    ok: input.ok,
    ...(input.agentId !== undefined
      ? { agentId: input.agentId as string }
      : {}),
    ...(input.result != null
      ? { result: input.result as Record<string, unknown> }
      : {}),
    ...(input.error != null ? { error: input.error as string } : {}),
    ...(input.finishedAt !== undefined
      ? { finishedAt: input.finishedAt as string }
      : {}),
  };
};
