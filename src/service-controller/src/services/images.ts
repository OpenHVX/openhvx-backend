// src/service-controller/src/services/images.ts
// Service for listing and resolving images from storage inventory (ceph telemetry)

import type { PipelineStage } from "mongoose";
import InventoryStorage from "../models/Inventory.storage";
import type { StorageInventoryPayload, StorageInventoryV1 } from "../types/inventory/storage";
import logger from "../lib/logger";

export interface ImageEntry {
    id: string; // refId from catalog
    refId: string;
    storageId: string;
    pool: string;
    name: string;
    sizeBytes: number;
    source?: { image: string; snap: string };
    collectedAt?: string;
}

export interface ResolveResult {
    id: string;
    storageId: string;
    pool: string;
    refId: string;
    name: string;
    sizeBytes: number;
    source?: { image: string; snap: string };
}

export interface CacheInfo {
    ttlMs: number;
    lastLoadTs: number;
    count: number;
}

interface ImageListFilters {
    q?: string;
}

const TTL_MS = parseInt(process.env.IMAGES_TTL_MS || "5000", 10);
const log = logger.child(["service", "images"]);

interface CacheState {
    ts: number;
    images: ImageEntry[];
}

let cache: CacheState = {
    ts: 0,
    images: [],
};

const normalize = (value?: string | string[] | number | null): string | undefined => {
    if (value == null) return undefined;
    if (Array.isArray(value)) return value[0];
    return String(value);
};

const flattenCatalog = (doc: { storageId: string; inventory?: StorageInventoryPayload }): ImageEntry[] => {
    const inv = doc.inventory as StorageInventoryV1 | undefined;
    if (!inv || !Array.isArray(inv.catalog)) return [];
    const collectedAt = inv.collectedAt;
    return inv.catalog.map((item) => ({
        id: item.refId,
        refId: item.refId,
        storageId: doc.storageId,
        pool: item.pool,
        name: item.name,
        sizeBytes: item.sizeBytes,
        source: item.source,
        collectedAt,
    }));
};

async function readFresh(): Promise<ImageEntry[]> {
    // Keep latest inventory per storageId.
    const pipeline: PipelineStage[] = [
        { $sort: { ts: -1 } },
        { $group: { _id: "$storageId", ts: { $first: "$ts" }, inventory: { $first: "$inventory" } } },
        { $project: { _id: 0, storageId: "$_id", inventory: 1 } },
    ];

    const docs = await InventoryStorage.aggregate<{
        storageId: string;
        inventory?: StorageInventoryPayload;
    }>(pipeline).exec();

    const images = docs.flatMap((doc) => flattenCatalog(doc));
    cache = {
        ts: Date.now(),
        images,
    };
    log.info("images cache refreshed from storage inventory", { count: images.length, storages: docs.length });
    return images;
}

async function readCache(): Promise<ImageEntry[]> {
    const now = Date.now();
    if (cache.images.length && now - cache.ts < TTL_MS) {
        return cache.images;
    }
    return readFresh();
}

export async function list(filters: ImageListFilters): Promise<ImageEntry[]> {
    let images = await readCache();
    const q = normalize(filters.q)?.toLowerCase();
    if (q) {
        images = images.filter((img) => {
            return (
                img.id.toLowerCase().includes(q) ||
                img.name.toLowerCase().includes(q) ||
                img.pool.toLowerCase().includes(q) ||
                img.storageId.toLowerCase().includes(q)
            );
        });
    }
    return images;
}

export async function getById(id?: string | null): Promise<ImageEntry | null> {
    if (!id) return null;
    const images = await readCache();
    const lower = id.toLowerCase();
    return images.find((x) => x.id.toLowerCase() === lower || x.name.toLowerCase() === lower) || null;
}

export async function resolveImageRef(id?: string | null): Promise<ResolveResult | null> {
    const img = await getById(id || undefined);
    if (!img) return null;
    return {
        id: img.id,
        storageId: img.storageId,
        pool: img.pool,
        refId: img.refId,
        name: img.name,
        sizeBytes: img.sizeBytes,
        source: img.source,
    };
}

export async function reloadNow() {
    return readFresh();
}

export function cacheInfo(): CacheInfo {
    return {
        ttlMs: TTL_MS,
        lastLoadTs: cache.ts,
        count: cache.images.length,
    };
}
