// Internal view of the canonical inventory used by resourcesController to expose VM/switch/disk data.
// Kept narrow to the fields the API surfaces so the controller stays easy to reason about.
export type ResourceData = Record<string, any>;

export interface PickedResource {
    kind: string;
    agentId: string;
    refId: string;
    data: ResourceData;
    assignedAt?: Date;
    name?: string;
}

export interface InventoryNetworkAdapter {
    id?: string;
    networkId?: string;
    macAddress?: string;
    primary?: boolean;
    ipAddresses?: string[];
    switch?: string;
    [key: string]: unknown;
}

export interface InventoryDisk {
    id?: string;
    path?: string | null;
    sizeBytes?: number | null;
    boot?: boolean;
    datastoreId?: string;
    vhd?: {
        path?: string | null;
        format?: string | null;
        type?: string | null;
        sizeMB?: number | null;
        fileSizeMB?: number | null;
        parentPath?: string | null;
        blockSize?: number | null;
        logicalSectorSize?: number | null;
        physicalSectorSize?: number | null;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface InventoryVm {
    id?: string;
    name?: string;
    powerState?: string;
    state?: string;
    cpu?: { vcpus?: number | null };
    memoryMb?: number;
    memoryAssignedMB?: number;
    disks?: InventoryDisk[];
    nics?: InventoryNetworkAdapter[];
    networkAdapters?: InventoryNetworkAdapter[];
    tags?: string[];
    [key: string]: unknown;
}

export interface InventorySwitch {
    id?: string;
    name?: string;
    type?: string;
    role?: ("tenant" | "public" | "management" | "storage")[];
    switchType?: string;
    isExternal?: boolean;
    [key: string]: unknown;
}

export interface InventoryDatastore {
    id?: string;
    kind?: string;
    name?: string;
    path?: string;
    sizeBytes?: number | null;
    freeBytes?: number | null;
    [key: string]: unknown;
}

export interface InventoryDoc {
    agentId: string;
    ts?: Date | string;
    inventory?: InventoryRoot;
    raw?: Record<string, unknown>;
    [key: string]: unknown;
}

export type InventoryRoot = {
    schemaVersion?: string;
    agentId?: string;
    collectedAt?: string | Date;
    host?: Record<string, unknown>;
    networks?: InventorySwitch[];
    datastores?: InventoryDatastore[];
    vms?: InventoryVm[];
    [key: string]: unknown;
};
