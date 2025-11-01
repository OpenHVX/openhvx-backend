// @ts-nocheck
// lib/schemas/task.js
"use strict";

const {
    validate,
    objectStrict,
    optional,
    isString,
    isInteger,
    isEnum,
} = require("../validate");

const isBoolean = isEnum([true, false]);

// -------- SCHEMAS --------

// CloudInit subset (loose structure but still constrained)
const CloudInitSchema = objectStrict({
    hostname: optional(isString),
    user: optional(isString),
    ssh_authorized_keys: optional((v) => Array.isArray(v) && v.every(isString)),
    packages: optional((v) => Array.isArray(v) && v.every(isString)),
    runcmd: optional((v) => Array.isArray(v) && v.every(isString)),
    enableSerial: optional(isBoolean),
    serialReboot: optional(isBoolean),
    network: optional(objectStrict({
        mode: optional(isEnum(["dhcp"])),
    })),
});

const VmCreateSchema = objectStrict({
    name: isString,
    imageId: optional(isString),
    cpu: optional(isInteger),
    generation: optional(isInteger),
    ram: optional(isString), // e.g. "2GB"
    dynamic_memory: optional(isBoolean),
    min_ram: optional(isString),
    max_ram: optional(isString),
    network: optional(objectStrict({
        vpcId: optional(isString),
        subnetId: optional(isString),
    })),
    cloudInit: optional(CloudInitSchema),
});

// -------- REGISTERED ACTIONS --------
const PRE = {
    "vm.create": VmCreateSchema,

    "console.serial.open": objectStrict({
        readOnly: optional(isBoolean),
        timeoutSec: optional(isInteger),
    }),

    "vm.power": objectStrict({
        op: isEnum(["start", "stop", "restart"]),
    }),

    "vm.delete": objectStrict({
        guid: optional(isString),
        forceStop: optional(isBoolean),
    }),

    "inventory.refresh": objectStrict({
        full: optional(isBoolean),
    }),

    "vm.clone": objectStrict({
        newName: optional(isString),
    }),

    "net.tunnel.open": objectStrict({}),

    "echo": objectStrict({
        message: optional(isString),
    }),
};

// -------- EXPORTS --------
function isKnownAction(action) {
    return !!PRE[action];
}

function preValidate(action, data) {
    const schema = PRE[action];
    if (!schema) {
        return { ok: false, value: undefined, errors: [`action: UNKNOWN_ACTION (${action})`] };
    }
    return validate(schema, data);
}

module.exports = { isKnownAction, preValidate };
