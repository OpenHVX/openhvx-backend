// services/imagesService.js
const fs = require("fs/promises");
const path = require("path");

const INDEX_PATH = process.env.IMAGES_INDEX_PATH; // ex: \\\\fileserver\\openhvx-images\\_index\\images.json
const TTL_MS = parseInt(process.env.IMAGES_TTL_MS || "5000", 10);

let cache = {
    ts: 0,
    mtimeMs: 0,
    images: [],
};

async function statSafe(p) {
    try { return await fs.stat(p); } catch { return null; }
}

async function readIndexFresh() {
    if (!INDEX_PATH) {
        throw new Error("IMAGES_INDEX_PATH is not set");
    }
    const raw = await fs.readFile(INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const imgs = Array.isArray(parsed?.images) ? parsed.images : [];
    const st = await statSafe(INDEX_PATH);
    cache = {
        ts: Date.now(),
        mtimeMs: st?.mtimeMs || 0,
        images: imgs,
    };
    return cache.images;
}

async function readIndex() {
    // petit cache mémoire + invalidation par TTL
    const now = Date.now();
    if (cache.images.length && now - cache.ts < TTL_MS) {
        return cache.images;
    }
    // sinon recharge
    return readIndexFresh();
}

exports.list = async ({ q, gen, os, arch }) => {
    let images = await readIndex();

    if (gen) images = images.filter(x => String(x.gen) === String(gen));
    if (os) images = images.filter(x => (x.os || "").toLowerCase().includes(String(os).toLowerCase()));
    if (arch) images = images.filter(x => (x.arch || "").toLowerCase() === String(arch).toLowerCase());
    if (q) {
        const s = String(q).toLowerCase();
        images = images.filter(x =>
            (x.id || "").toLowerCase().includes(s) ||
            (x.name || "").toLowerCase().includes(s) ||
            (x.path || "").toLowerCase().includes(s)
        );
    }
    return images;
};

exports.getById = async (id) => {
    if (!id) return null;
    const images = await readIndex();
    return images.find(x => x.id === id) || null;
};

exports.resolvePath = async (id) => {
    const img = await exports.getById(id);
    return img ? { id: img.id, path: img.path } : null;
};

// Utilitaire debug (optionnel)
exports._reloadNow = async () => readIndexFresh();

// Expose pour diag (ETag-like simple)
exports._cacheInfo = () => ({
    ttlMs: TTL_MS,
    lastLoadTs: cache.ts,
    sourceMtimeMs: cache.mtimeMs,
    count: cache.images.length,
    indexPath: INDEX_PATH,
});
