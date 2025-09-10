// /lib/enrich.js
const imagesService = require("../services/images");
const consoleSvc = require("../services/console");

const registry = {
    // =========================
    //       VM LIFECYCLE
    // =========================
    "vm.create": {
        async auto({ object }) {
            let out = { ...object };
            if (!out.imagePath && out.imageId) {
                const r = await imagesService.resolvePath(out.imageId);
                if (!r || !r.path) throw new Error(`imageId not found: ${out.imageId}`);
                out = { ...out, imagePath: r.path };
            }
            return out;
        },
        async determineImage({ object }) {
            if (object.imagePath) return { ...object };
            if (!object.imageId) throw new Error("imageId is required for determineImage");
            const r = await imagesService.resolvePath(object.imageId);
            if (!r || !r.path) throw new Error(`imageId not found: ${object.imageId}`);
            return { ...object, imagePath: r.path };
        },
    },

    "vm.clone": {
        async auto(args) { return registry["vm.create"].auto(args); },
        async determineImage(args) { return registry["vm.create"].determineImage(args); },
    },

    "vm.edit": {
        async auto({ object }) { return { ...object }; },
    },

    // =========================
    //   CONSOLE / TUNNELS
    // =========================

    /**
     * console.serial.open
     * - Appelle services/console.planSerialOpen()
     * - Renvoie les données agent (pour la task) + _console pour l’UI
     *
     * Attendu:
     *  object: { refId?|vmId?, ttlSeconds? }
     *  ctx:    { tenantId, agentId } (fourni par tasksController)
     */
    "console.serial.open": {
        async auto({ object, ctx }) {
            const refId =
                object.refId || object.vmId || ctx?.refId || ctx?.vm?._id;
            if (!refId) throw new Error("refId/vmId is required");

            const { agentData, ui } = await consoleSvc.planSerialOpen({
                refId,
                tenantId: ctx?.tenantId,
                agentId: ctx?.agentId,
                // sub optionnel si un jour on passe l'utilisateur dans ctx
                sub: ctx?.user?.id,
                ttlSeconds: object.ttlSeconds,
            });

            // Merge non destructif: on garde le payload d’origine et on ajoute ce qu’il faut pour l’agent
            return { ...object, ...agentData, _console: ui };
        },
    },

    /**
     * net.tunnel.open
     * - Tunnel TCP générique (SSH/RDP/VNC…)
     * object attendu: { target:{ip,port}, mode?, ttlSeconds? }
     * ctx attendu   : { tenantId, agentId }
     */
    "net.tunnel.open": {
        async auto({ object, ctx }) {
            const refId =
                object.refId || object.vmId || ctx?.refId || ctx?.vm?._id;
            if (!refId) throw new Error("refId/vmId is required");
            if (!object?.target?.ip || !object?.target?.port) {
                throw new Error("target.ip and target.port are required");
            }

            const { agentData, ui } = await consoleSvc.planNetTunnelOpen({
                refId,
                tenantId: ctx?.tenantId,
                agentId: ctx?.agentId,
                sub: ctx?.user?.id,
                target: object.target,
                mode: object.mode,
                ttlSeconds: object.ttlSeconds,
            });

            return { ...object, ...agentData, _console: ui };
        },
    },
};

/** Dispatcher générique */
async function enrich(action, opts = {}) {
    const act = String(action || "");
    if (!act) return { ok: false, error: "action is required" };
    if (!opts || typeof opts !== "object") return { ok: false, error: "opts must be an object" };

    const operation = String(opts.operation || "");
    const { object, ctx } = opts;
    if (!operation) return { ok: false, error: "opts.operation is required" };
    if (!object) return { ok: false, error: "opts.object is required" };

    const ops = registry[act];
    if (!ops) return { ok: false, error: `unsupported action: ${act}` };

    const handler = ops[operation];
    if (typeof handler !== "function") {
        return { ok: false, error: `unsupported operation for ${act}: ${operation}` };
    }

    try {
        const data = await handler({ object, ctx });
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

function register(action, operation, handler) {
    if (!registry[action]) registry[action] = {};
    registry[action][operation] = handler;
}

module.exports = { enrich, register };
