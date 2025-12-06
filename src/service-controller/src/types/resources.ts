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
    switch?: string;
    [key: string]: unknown;
}

export interface InventoryVm {
    guid?: string;
    id?: string;
    name?: string;
    state?: string;
    configuration?: {
        processors?: { count?: number };
        memory?: { startupMB?: number };
    };
    cpu?: number;
    memoryAssignedMB?: number;
    networkAdapters?: InventoryNetworkAdapter[];
    storage?: VmStorage[];
    [key: string]: unknown;
}

export interface VmStorage {
    path?: string | null;
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

export interface InventorySwitch {
    name?: string;
    type?: string;
    switchType?: string;
    isExternal?: boolean;
    [key: string]: unknown;
}

export interface InventoryDatastore {
    kind?: string;
    agentId?: string;
    [key: string]: unknown;
}

export interface InventoryDoc {
    agentId: string;
    ts?: Date | string;
    inventory?: {
        inventory?: {
            vms?: InventoryVm[];
            networks?: { switches?: InventorySwitch[] };
            datastores?: InventoryDatastore[];
        };
        vms?: InventoryVm[];
        networks?: { switches?: InventorySwitch[] };
        datastores?: InventoryDatastore[];
        collectedAt?: Date | string;
    };
    [key: string]: unknown;
}

export type InventoryRoot = {
    vms?: InventoryVm[];
    networks?: { switches?: InventorySwitch[] };
    datastores?: InventoryDatastore[];
    collectedAt?: string | Date;
    [key: string]: unknown;
};
