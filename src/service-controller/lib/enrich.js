// /lib/enrich.js
const imagesService = require("../services/images");

const registry = {
    "vm.create": {
        // AUTO: enchaîne les enrichissements pertinents pour vm.create
        async auto({ object }) {
            let out = { ...object };

            // determineImage seulement si nécessaire
            if (!out.imagePath && out.imageId) {
                const r = await imagesService.resolvePath(out.imageId);
                if (!r || !r.path) throw new Error(`imageId not found: ${out.imageId}`);
                out = { ...out, imagePath: r.path };
            }

            // … d’autres enrichissements vm.create ici si besoin …

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

    // actions non gérées: soit tu ajoutes un auto no-op ici,
    // soit le dispatcher traitera "unsupported" comme no-op côté controller.
    "vm.edit": {
        async auto({ object }) { return { ...object }; },
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
