import type { QuotaKey } from "../../types/domain";

type QuotaDefaults = Record<QuotaKey, number>;

const defaults: QuotaDefaults = {
    cpu: 16, // vCPUs
    memoryMB: 32_768, // 32 GB
    storageMB: 512_000, // 500 GB
    vmCount: 10, // max number of VMs
    networkCount: 5, // max number of networks
};

export default defaults;
