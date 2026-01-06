export interface StorageInventoryV1 {
  schemaVersion: string;
  storageId: string;
  collectedAt: string;

  cluster: { fsid: string; health: string };
  capacity: { totalBytes: number; usedBytes: number; availBytes: number };

  // tenant volumes (RBD "disks")
  volumes: Array<{
    refId: string;      // ex: "tenant-disk-123" (== image name)
    iqn: string;        // ex: "iqn.2001-07.org.openhvx:tenant-disk-123"
    portal?: {          // iSCSI portal used to reach the target
      host?: string;    // ex: "ceph-gw-01"
      ip: string;       // ex: "192.168.1.150"
    };
    pool: string;       // ex: "rbd"
    sizeBytes: number;
    usedBytes?: number;
    isAttached: boolean;
  }>;

  // catalog of templates (golden images)
  catalog: Array<{
    refId: string;      // ex: "rocky9", "win2022"
    pool: string;       // ex: "images"
    name: string;       // ex: "img-rocky9"
    sizeBytes: number;

    // optional if you rely on snapshot clones
    source?: { image: string; snap: string }; // ex: { image:"img-rocky9", snap:"base" }
  }>;
}

export interface StorageTelemetryEnvelopeV1 {
  storageId: string;
  ts: string;
  inventory: StorageInventoryV1;
}

// Alias used by service-controller schemas; versioned union if more schemas land later.
export type StorageInventoryPayload = StorageInventoryV1;
