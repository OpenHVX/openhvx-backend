// lib/schemas/task.js (CommonJS)
// Validates ONLY user-provided "data" per action, before enrich().

const {
    validate,
    objectStrict,
    optional,
    isString,
    isInteger,
    isEnum,
} = require('../validate');

// Boolean helper from your primitives (using enum of literals)
const isBoolean = isEnum([true, false]);

// Per-action PRE payload schemas (user input)
const PRE = {
    'vm.create': objectStrict({
        name: isString,
        image: isString, // alias or ID; enrich() will resolve
        cpu: optional(isInteger),
        ramMB: optional(isInteger),
        diskGB: optional(isInteger),
        network: objectStrict({
            vpcId: isString,
            subnetId: isString,
        }),
        cloudInit: optional(objectStrict({
            userData: optional(isString),
        })),
    }),

    'console.serial.open': objectStrict({
        readOnly: optional(isBoolean),
        timeoutSec: optional(isInteger),
    }),

    'vm.power': objectStrict({
        op: isEnum(['start', 'stop', 'restart']),
    }),

    'vm.delete': objectStrict({}),

    'inventory.refresh': objectStrict({
        full: optional(isBoolean),
    }),

    // Optional placeholders (tune as you formalize these)
    'vm.clone': objectStrict({
        newName: optional(isString),
    }),

    'net.tunnel.open': objectStrict({}),

    'echo': objectStrict({
        message: optional(isString),
    }),
};

function isKnownAction(action) {
    return !!PRE[action];
}

// Validate the user "data" against PRE schema
function preValidate(action, data) {
    const schema = PRE[action];
    if (!schema) {
        return { ok: false, value: undefined, errors: [`action: UNKNOWN_ACTION (${action})`] };
    }
    return validate(schema, data);
}

module.exports = { isKnownAction, preValidate };
