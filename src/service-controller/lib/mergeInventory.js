// lib/mergeInventory.js

function isPlainObject(o) {
    return o && typeof o === "object" && !Array.isArray(o);
}

// Déclare ici les tableaux qui doivent faire un upsert (par clé primaire)
const ARRAY_KEYS = new Map([
    ["inventory.vms", "id"],                       // VMs par id
    ["inventory.vms.storage", "path"],
    ["inventory.vms[].networkAdapters", "name"],   // NICs par name
    ["inventory.vms[].storage", "path"],           // Disques par path
    ["inventory.networks.switches", "name"],       // vSwitch par name
    ["inventory.networks.hostAdapters", "name"],   // NICs host par name
]);

// Chemins scalaires à toujours mettre à jour si présents dans le patch
const ALWAYS_UPDATE = new Set([
    "inventory.collectedAt",
]);


function stripBrackets(s) { return s.replace(/\[\]/g, ""); }

// 1) ajoute ce pattern pour matcher aussi sans [] (sécurité)
const IGNORE_EMPTY_OBJECT_AT = new Set([
    "inventory.vms[].storage[].vhd",
    "inventory.vms.storage.vhd",       // ⬅️ new
]);

function normalizeKeyValue(basePath, keyName, val) {
    if (val == null) return val;
    if (typeof val !== "string") return val;

    // Pour les chemins de disques / adapters: insensible à la casse, slash normalisé
    const isPathKey =
        keyName === "path" ||
        basePath.endsWith(".storage") ||
        basePath.endsWith(".storage[]") ||
        basePath.includes(".storage.");

    if (isPathKey) {
        return val.replace(/\//g, "\\").toLowerCase();
    }
    return val.toLowerCase(); // name des NICs: safe en insensible à la casse
}


// --- change la signature d'upsertByKey pour recevoir le chemin de base ---
function upsertByKey(dstArr, srcArr, key, basePath) {
    if (!Array.isArray(dstArr)) dstArr = [];

    // index des items existants (clé normalisée)
    const pos = new Map();
    dstArr.forEach((it, i) => {
        if (isPlainObject(it) && it[key] !== undefined) {
            const k = normalizeKeyValue(basePath, key, it[key]);
            if (k !== undefined) pos.set(k, i);
        }
    });

    // merge/upsert des éléments de src
    for (const it of srcArr) {
        if (!isPlainObject(it)) { dstArr.push(it); continue; }
        const rawId = it[key];
        if (rawId === undefined) { dstArr.push(it); continue; }
        const id = normalizeKeyValue(basePath, key, rawId);

        if (pos.has(id)) {
            const i = pos.get(id);
            // ⚠️ propager le chemin pour garder les règles (vhd, fileSizeMB, etc.)
            dstArr[i] = mergeNullSafe(dstArr[i], it, basePath);
        } else {
            pos.set(id, dstArr.length);
            dstArr.push(it);
        }
    }

    // Déduplication finale par la même clé normalisée (évite l’empilement)
    const dedup = new Map();
    for (const it of dstArr) {
        if (isPlainObject(it) && it[key] !== undefined) {
            const k = normalizeKeyValue(basePath, key, it[key]);
            dedup.set(k, it); // garde le dernier merge
        } else {
            // éléments non indexables -> on les garde tels quels via une clé unique
            dedup.set(Symbol("x"), it);
        }
    }
    return Array.from(dedup.values());
}

const MAX_SCALAR_AT = new Set([
    "inventory.vms[].storage[].vhd.fileSizeMB",
    "inventory.vms.storage.vhd.fileSizeMB",
]);

function mergeNullSafe(dst, src, path = "") {
    if (!isPlainObject(dst)) dst = {};
    if (!isPlainObject(src)) return dst;

    for (const [k, v] of Object.entries(src)) {
        const childPath = path ? `${path}.${k}` : k;

        if (ALWAYS_UPDATE.has(childPath)) {
            dst[k] = v;
            continue;
        }
        if (v === null || v === undefined) continue;

        const dv = dst[k];

        if (Array.isArray(v)) {
            if (v.length === 0) continue;

            let key = ARRAY_KEYS.get(childPath);
            if (!key && childPath.endsWith("]")) {
                const parent = path;
                key = ARRAY_KEYS.get(`${parent}.${k}`);
            }

            if (key) {
                // ⬇️ passer childPath pour conserver le contexte lors du merge des items
                dst[k] = upsertByKey(Array.isArray(dv) ? dv : [], v, key, childPath);
            } else {
                dst[k] = v;
            }
            continue;
        }

        if (isPlainObject(v)) {
            // ignorer objet vide pour les chemins sensibles (ex: …vhd)
            if (Object.keys(v).length === 0) {
                const normalized = stripBrackets(childPath);
                const shouldIgnore = [...IGNORE_EMPTY_OBJECT_AT].map(stripBrackets).includes(normalized);
                if (shouldIgnore) continue;
            }
            dst[k] = mergeNullSafe(isPlainObject(dv) ? dv : {}, v, childPath);
            continue;
        }

        // ---- Scalaire non-null ----
        if (typeof v === "number") {
            const normalized = stripBrackets(childPath);
            if ([...MAX_SCALAR_AT].map(stripBrackets).includes(normalized)) {
                const cur = (typeof dv === "number") ? dv : -Infinity;
                dst[k] = Math.max(cur, v);  // garde le max (évite que le full réduise utilisé)
                continue;
            }
        }

        dst[k] = v;
    }
    return dst;
}

/**
 * Fusionne un patch d'inventaire dans l'état courant.
 * - mode "patch-nondestructive" (par défaut): null/[] ignorés, upsert sur tableaux indexés.
 * - mode "replace": remplace entièrement.
 */
function mergeInventory(current, patch, opts = {}) {
    const mode = opts.mode || "patch-nondestructive";
    if (mode === "replace") return patch || {};
    return mergeNullSafe(current || {}, patch || {});
}

module.exports = {
    mergeInventory,
    _internals: { isPlainObject, mergeNullSafe, upsertByKey, ARRAY_KEYS, ALWAYS_UPDATE },
};
