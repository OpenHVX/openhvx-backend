import { canonical, fingerprint } from "./idempotency";
export const TASK_PROTOCOL_CAPABILITY = "task.protocol.v2";
export interface CommandContent {
  operationId: string;
  tenantId: string;
  agentId: string;
  action: string;
  data: Record<string, unknown>;
}
export function commandEnvelope(command: CommandContent) {
  const commandBody = canonical(command);
  return {
    contractVersion: 2,
    commandBody,
    commandFingerprint: fingerprint(command),
  };
}
