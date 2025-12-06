type ValidatorFn<T> = ((value: unknown, path?: string) => T) & { __optional?: boolean };

export type Validator<T> = ValidatorFn<T>;

export interface ValidationResult<T> {
    ok: boolean;
    value: T | undefined;
    errors: string[];
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && Object.getPrototypeOf(input) === Object.prototype;
}

const joinPath = (base: string, key: string) => (base ? `${base}.${key}` : String(key));

const err = (path: string, message: string) => new Error(`${path || "value"}: ${message}`);

export const isString: ValidatorFn<string> = (value, path = "") => {
    if (typeof value !== "string") throw err(path, "expected string");
    return value;
};

export const isNumber: ValidatorFn<number> = (value, path = "") => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw err(path, "expected finite number");
    return value;
};

export const isInteger: ValidatorFn<number> = (value, path = "") => {
    if (typeof value !== "number" || !Number.isInteger(value)) throw err(path, "expected integer");
    return value;
};

export const isDate: ValidatorFn<Date> = (value, path = "") => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw err(path, "expected valid Date");
    return value;
};

export function isEnum<T extends string | number | boolean>(values: readonly T[]): ValidatorFn<T> {
    const set = new Set(values);
    return ((value: unknown, path = "") => {
        if (!set.has(value as T)) {
            throw err(path, `expected one of ${values.map(String).join(", ")}`);
        }
        return value as T;
    }) as ValidatorFn<T>;
}

export function optional<T>(validator: ValidatorFn<T>): ValidatorFn<T | undefined> {
    const fn = ((value: unknown, path = "") => {
        if (value === undefined) return undefined;
        return validator(value, path);
    }) as ValidatorFn<T | undefined>;
    fn.__optional = true;
    return fn;
}

export function arrayOf<T>(itemValidator: ValidatorFn<T>): ValidatorFn<T[]> {
    return ((value: unknown, path = "") => {
        if (!Array.isArray(value)) throw err(path, "expected array");
        return value.map((val, index) => itemValidator(val, `${path}[${index}]`));
    }) as ValidatorFn<T[]>;
}

export function recordOf<T>(valueValidator: ValidatorFn<T>): ValidatorFn<Record<string, T>> {
    return ((value: unknown, path = "") => {
        if (!isPlainObject(value)) throw err(path, "expected plain object");
        const out: Record<string, T> = {};
        for (const key of Object.keys(value)) {
            out[key] = valueValidator(value[key], joinPath(path, key));
        }
        return out;
    }) as ValidatorFn<Record<string, T>>;
}

type Shape<T> = { [K in keyof T]: ValidatorFn<T[K]> };

export function objectStrict<T extends Record<string, unknown>>(shape: Shape<T>): ValidatorFn<T> {
    const requiredKeys: string[] = [];
    for (const key of Object.keys(shape)) {
        const validator = shape[key as keyof T];
        if (typeof validator !== "function") throw new Error(`shape.${key}: validator must be a function`);
        if (!validator.__optional) requiredKeys.push(key);
    }

    const allowedKeys = new Set(Object.keys(shape));

    return ((value: unknown, path = "") => {
        if (!isPlainObject(value)) throw err(path, "expected plain object");

        for (const key of Object.keys(value)) {
            if (!allowedKeys.has(key)) throw err(joinPath(path, key), "unexpected key");
        }

        for (const key of requiredKeys) {
            if (!(key in value)) throw err(joinPath(path, key), "missing required key");
        }

        const out: Record<string, unknown> = {};
        for (const key of Object.keys(shape)) {
            if (key in value) {
                const validator = shape[key as keyof T];
                out[key] = validator(value[key], joinPath(path, key));
            }
        }

        return out as T;
    }) as ValidatorFn<T>;
}

export function validate<T>(schema: ValidatorFn<T>, value: unknown): ValidationResult<T> {
    try {
        const validated = schema(value, "");
        return { ok: true, value: validated, errors: [] };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, value: undefined, errors: [message] };
    }
}
