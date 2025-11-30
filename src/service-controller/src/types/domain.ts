export type ResourceKind = "vm" | "switch" | "disk" | "nic" | "other";

export type QuotaKey = "cpu" | "memoryMB" | "storageMB" | "vmCount" | "networkCount";

export type QuotaLimits = Partial<Record<QuotaKey, number>>;

export type QuotaDeltas = Partial<Record<QuotaKey, number>>;

export interface QuotaItem {
    limit: number;
    used: number;
}

export type Quotas = Record<QuotaKey, QuotaItem>;

export type TaskStatus = "queued" | "sent" | "done" | "error";

export interface ElectionRequirements {
    freshness: number;
    capabilities: string[];
}

export interface VmIdentifier {
    guid?: string | null;
    id?: string | null;
    name?: string | null;
}
