// lib/validate.js (CommonJS)

// ----- Helpers -----
const isPlainObject = (x) =>
    typeof x === "object" && x !== null && Object.getPrototypeOf(x) === Object.prototype;

const joinPath = (base, key) => (base ? `${base}.${key}` : String(key));
const err = (path, msg) => new Error(`${path || "value"}: ${msg}`);

// ----- Primitives -----
function isString(v, path = "") {
    if (typeof v !== "string") throw err(path, "expected string");
    return v;
}

function isNumber(v, path = "") {
    if (typeof v !== "number" || !Number.isFinite(v)) throw err(path, "expected finite number");
    return v;
}

function isInteger(v, path = "") {
    if (!Number.isInteger(v)) throw err(path, "expected integer");
    return v;
}

function isDate(v, path = "") {
    if (!(v instanceof Date) || Number.isNaN(v.getTime())) throw err(path, "expected valid Date");
    return v;
}

function isEnum(values) {
    const set = new Set(values);
    return (v, path = "") => {
        if (!set.has(v)) throw err(path, `expected one of ${values.map(String).join(", ")}`);
        return v;
    };
}

// ----- Modificateurs / combinators -----
function optional(validator) {
    const fn = (v, path = "") => {
        if (v === undefined) return undefined;
        return validator(v, path);
    };
    fn.__optional = true;
    return fn;
}

function arrayOf(itemValidator) {
    return (v, path = "") => {
        if (!Array.isArray(v)) throw err(path, "expected array");
        return v.map((val, i) => itemValidator(val, `${path}[${i}]`));
    };
}

function recordOf(valueValidator) {
    return (v, path = "") => {
        if (!isPlainObject(v)) throw err(path, "expected plain object");
        const out = {};
        for (const k of Object.keys(v)) {
            out[k] = valueValidator(v[k], joinPath(path, k));
        }
        return out;
    };
}

// ----- Schéma objet strict ----
function objectStrict(shape) {
    const requiredKeys = [];
    for (const k of Object.keys(shape)) {
        const val = shape[k];
        if (typeof val !== "function") throw new Error(`shape.${k}: validator must be a function`);
        if (!val.__optional) requiredKeys.push(k);
    }
    const allKeys = new Set(Object.keys(shape));

    return (v, path = "") => {
        if (!isPlainObject(v)) throw err(path, "expected plain object");

        for (const k of Object.keys(v)) {
            if (!allKeys.has(k)) throw err(joinPath(path, k), "unexpected key");
        }

        for (const k of requiredKeys) {
            if (!(k in v)) throw err(joinPath(path, k), "missing required key");
        }

        const out = {};
        for (const k of Object.keys(shape)) {
            const validator = shape[k];
            if (k in v) {
                out[k] = validator(v[k], joinPath(path, k));
            }
        }
        return out;
    };
}

// ----- validate(schema, value) -----
function validate(schema, value) {
    try {
        const validated = schema(value, "");
        return { ok: true, value: validated, errors: [] };
    } catch (e) {
        return { ok: false, value: undefined, errors: [String(e.message || e)] };
    }
}

// ----- Exports -----
module.exports = {
    validate,
    objectStrict,
    arrayOf,
    recordOf,
    optional,
    isString,
    isNumber,
    isInteger,
    isDate,
    isEnum,
};
