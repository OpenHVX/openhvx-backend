/**
 * Canonical Inventory Schema (v1.0.0)
 * -----------------------------------
 * Contrat unique pour l’inventaire envoyé par les agents OpenHVX.
 */

export const CURRENT_INVENTORY_SCHEMA_VERSION = "1.0.0";

/* =========================================================================
 *  ROOT
 * ========================================================================= */

export interface CanonicalInventory {
  schemaVersion: string;      // ex: "1.0.0"
  collectedAt: string;        // ISO8601

  host: CanonicalHost;
  networks: CanonicalNetwork[];
  datastores: CanonicalDatastore[];   // <-- ICI au lieu de "storage"
  vms: CanonicalVm[];
}

/* =========================================================================
 *  HOST
 * ========================================================================= */

export interface CanonicalHost {
  hostname: string;
  os: string;                       // "Windows Server 2022"
  hypervisor: string;               // "hyperv" | "kvm" | ...
  cpu: {
    sockets?: number | null;
    cores?: number | null;
    threads?: number | null;
    model?: string;
  };
  memoryMb: number;

  provider?: {
    hyperv?: Record<string, unknown>;
    [other: string]: unknown;
  };
}

/* =========================================================================
 *  NETWORKS
 * ========================================================================= */

export interface CanonicalNetwork {
  id: string;                       // refId — utilisable dans TenantResource
  name: string;
  type: string;                     // "vswitch" | "bridge" | "lan" | ...
  role?: ("tenant" | "public" | "management" | "storage")[];

  provider?: {
    hyperv?: {
      switchType?: "External" | "Internal" | "Private";
      uplinkNic?: string;
    };
    [other: string]: unknown;
  };
}

/* =========================================================================
 *  DATASTORES (OpenHVX)
 * ========================================================================= */

/**
 * Datastore logique géré par OpenHVX, basé sur les datadirs du fichier Go :
 *   - "root"
 *   - "vm"
 *   - "vhd"
 *   - "iso"
 *   - "checkpoint"
 *   - "logs"
 */
export interface CanonicalDatastore {
  id: string;                     // identifiant stable (ex: "vm", "vhd", ou un GUID)
  name: string;                   // "OpenHVX VMS", "OpenHVX VHD", etc.
  kind: string;                   // "root" | "vm" | "vhd" | "iso" | "checkpoint" | "logs" | ...
  path: string;                   // chemin sur le host (d.Root, d.VMS, etc.)

  // Optionnel: capacité réelle du FS si tu la remontes dans le script PS
  sizeBytes?: number;
  freeBytes?: number;

  provider?: {
    hyperv?: Record<string, unknown>;
    [other: string]: unknown;
  };
}

/* =========================================================================
 *  VMS
 * ========================================================================= */

export interface CanonicalVm {
  id: string;                       // refId (GUID Hyper-V ou identifiant stable local)
  name: string;
  powerState: "Running" | "Off" | "Paused" | "Unknown";

  cpu: {
    vcpus: number;
  };

  memoryMb: number;
  ipAddresses?: string[];
  disks: CanonicalVmDisk[];
  nics: CanonicalVmNic[];

  tags?: string[];
  provider?: {
    hyperv?: {
      vmId?: string;                // GUID brut Hyper-V
      generation?: 1 | 2;
    };
    [other: string]: unknown;
  };
}

/* =========================================================================
 *  VM DISKS
 * ========================================================================= */

export interface CanonicalVmDisk {
  id: string;                       // identifiant du disque (path, GUID, etc.)
  path: string;                     // "D:\\HVX\\CLIENT1\\vm01\\disk0.vhdx"
  sizeBytes: number;
  diskNumber?: number;
  boot?: boolean;
  iqn?: string;                     // iSCSI IQN — utilisé comme refId pour le lien storage/disk
  /**
   * Identifier of the backing storage object (ex: Ceph image refId).
   * Use this to detect whether a storage disk is already attached to a VM.
   */
  storageRefId?: string;
  storageId?: string;              // optional alias
  /**
   * Référence à CanonicalDatastore.id.
   * Exemple :
   *  - datastoreId: "vhd" pour un VHD dans OpenHVX VHD
   *  - datastoreId: "vm" pour le dossier VM
   */
  datastoreId?: string;
}

/* =========================================================================
 *  VM NICS
 * ========================================================================= */

export interface CanonicalVmNic {
  id: string;
  networkId: string;               // Référence à CanonicalNetwork.id
  macAddress?: string;
  primary?: boolean;
  ipAddresses?: string[];
}
