import fs from "fs/promises";

export interface ImageEntry {
    id?: string;
    name?: string;
    path?: string;
    gen?: string | number;
    os?: string;
    arch?: string;
    [key: string]: unknown;
}

export interface ResolveResult {
    id?: string;
    path?: string;
}

export interface CacheInfo {
    ttlMs: number;
    lastLoadTs: number;
    sourceMtimeMs: number;
    count: number;
    indexPath?: string;
}

interface ImageListFilters {
    q?: string;
    gen?: string | number;
    os?: string;
    arch?: string;
}

const INDEX_PATH = process.env.IMAGES_INDEX_PATH;
const TTL_MS = parseInt(process.env.IMAGES_TTL_MS || "5000", 10);

interface CacheState {
    ts: number;
    mtimeMs: number;
    images: ImageEntry[];
}

let cache: CacheState = {
    ts: 0,
    mtimeMs: 0,
    images: [],
};

async function statSafe(filePath: string) {
    try {
        return await fs.stat(filePath);
    } catch {
        return null;
    }
}

async function readIndexFresh(): Promise<ImageEntry[]> {
    if (!INDEX_PATH) {
        throw new Error("IMAGES_INDEX_PATH is not set");
    }
    const raw = await fs.readFile(INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const imgs: ImageEntry[] = Array.isArray(parsed?.images) ? parsed.images : [];
    const st = await statSafe(INDEX_PATH);
    cache = {
        ts: Date.now(),
        mtimeMs: st?.mtimeMs || 0,
        images: imgs,
    };
    return cache.images;
}

async function readIndex(): Promise<ImageEntry[]> {
    const now = Date.now();
    if (cache.images.length && now - cache.ts < TTL_MS) {
        return cache.images;
    }
    return readIndexFresh();
}

const normalize = (value?: string | string[] | number | null): string | undefined => {
    if (value == null) return undefined;
    if (Array.isArray(value)) return value[0];
    return String(value);
};

export async function list(filters: ImageListFilters): Promise<ImageEntry[]> {
    let images = await readIndex();
    const gen = normalize(filters.gen);
    const os = normalize(filters.os)?.toLowerCase();
    const arch = normalize(filters.arch)?.toLowerCase();
    const q = normalize(filters.q)?.toLowerCase();

    if (gen) images = images.filter((x) => String(x.gen) === gen);
    if (os) images = images.filter((x) => (x.os || "").toLowerCase().includes(os));
    if (arch) images = images.filter((x) => (x.arch || "").toLowerCase() === arch);
    if (q) {
        images = images.filter((x) => {
            const id = (x.id || "").toLowerCase();
            const name = (x.name || "").toLowerCase();
            const p = (x.path || "").toLowerCase();
            return id.includes(q) || name.includes(q) || p.includes(q);
        });
    }
    return images;
}

export async function getById(id?: string | null): Promise<ImageEntry | null> {
    if (!id) return null;
    const images = await readIndex();
    return images.find((x) => x.id === id) || null;
}

export async function resolvePath(id?: string | null): Promise<ResolveResult | null> {
    const img = await getById(id || undefined);
    return img ? { id: img.id, path: img.path } : null;
}

export async function reloadNow() {
    return readIndexFresh();
}

export function cacheInfo(): CacheInfo {
    return {
        ttlMs: TTL_MS,
        lastLoadTs: cache.ts,
        sourceMtimeMs: cache.mtimeMs,
        count: cache.images.length,
        indexPath: INDEX_PATH,
    };
}
