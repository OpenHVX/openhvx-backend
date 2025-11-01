/**
 * Tiny logger with levels, namespaces and JSON/pretty output.
 *
 * Env:
 *  - LOG_ENABLED=0            -> disable logs (default: enabled)
 *  - LOG_LEVEL=debug|info|... -> min level (default: info)
 *  - LOG_JSON=1               -> JSON lines (default: pretty text)
 *  - LOG_SERVICE_NAME=ohvx    -> service tag (optional)
 */

// @ts-nocheck

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const NAMES = Object.keys(LEVELS);

const ENABLED = process.env.LOG_ENABLED !== "0";
const MIN_LEVEL =
    LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;
const AS_JSON = process.env.LOG_JSON === "1";
const SERVICE = process.env.LOG_SERVICE_NAME || "";

function levelName(n) {
    for (const k of NAMES) if (LEVELS[k] === n) return k;
    return "info";
}

function serializeError(err) {
    if (!err) return undefined;
    if (err instanceof Error) {
        return { message: err.message, stack: err.stack, name: err.name, ...err };
    }
    return err;
}

function safeStringify(obj) {
    try { return JSON.stringify(obj); } catch { return '{"_":"[unserializable]"}'; }
}

function joinNs(ns) {
    if (!ns) return "";
    if (Array.isArray(ns)) return ns.join(":");
    return String(ns);
}

function baseLog({ ns }) {
    const namespace = joinNs(ns);

    function write(levelNum, msg, meta) {
        if (!ENABLED) return;
        if (levelNum < MIN_LEVEL) return;

        const now = new Date();
        const lvl = levelName(levelNum);
        const payload = {
            ts: now.toISOString(),
            level: lvl,
            ns: namespace || undefined,
            service: SERVICE || undefined,
            pid: process.pid,
            msg: String(msg || ""),
            ...(meta && { meta }),
        };

        // JSON mode
        if (AS_JSON) {
            if (payload.meta?.error) payload.meta.error = serializeError(payload.meta.error);
            if (payload.meta?.err) payload.meta.err = serializeError(payload.meta.err);
            const line = safeStringify(payload);
            if (levelNum >= LEVELS.error) return console.error(line);
            if (levelNum >= LEVELS.warn) return console.warn(line);
            return console.log(line);
        }

        // Pretty mode
        const tags = [
            `[${payload.ts}]`,
            SERVICE && `[${SERVICE}]`,
            `[${lvl.toUpperCase()}]`,
            namespace && `[${namespace}]`,
        ]
            .filter(Boolean)
            .join(" ");

        const tail = payload.meta ? " " + safeStringify(payload.meta) : "";
        const line = `${tags} ${payload.msg}${tail}`;

        if (levelNum >= LEVELS.error) return console.error(line);
        if (levelNum >= LEVELS.warn) return console.warn(line);
        return console.log(line);
    }

    const api = {
        trace: (m, meta) => write(LEVELS.trace, m, meta),
        debug: (m, meta) => write(LEVELS.debug, m, meta),
        info: (m, meta) => write(LEVELS.info, m, meta),
        warn: (m, meta) => write(LEVELS.warn, m, meta),
        error: (m, meta) => write(LEVELS.error, m, meta),
        child(subNs) {
            // If array → merge, else append
            let ns2;
            if (Array.isArray(subNs)) {
                ns2 = namespace ? [namespace, ...subNs] : subNs;
            } else {
                ns2 = namespace ? `${namespace}:${subNs}` : String(subNs);
            }
            return baseLog({ ns: ns2 });
        },
    };

    return api;
}

// default/root logger
const logger = baseLog({ ns: "" });

module.exports = logger;
