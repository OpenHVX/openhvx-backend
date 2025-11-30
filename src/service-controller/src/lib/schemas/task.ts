import {
    arrayOf,
    isEnum,
    isInteger,
    isString,
    objectStrict,
    optional,
    validate,
} from "../validate";
import type { ValidationResult, Validator } from "../validate";

const isBoolean = isEnum([true, false] as const);

export interface CloudInitNetwork {
    mode?: "dhcp";
}

export interface CloudInitConfig extends Record<string, unknown> {
    hostname?: string;
    user?: string;
    ssh_authorized_keys?: string[];
    packages?: string[];
    runcmd?: string[];
    enableSerial?: boolean;
    serialReboot?: boolean;
    network?: CloudInitNetwork;
}

export interface VmCreatePayload extends Record<string, unknown> {
    name: string;
    imageId?: string;
    cpu?: number;
    generation?: number;
    ram?: string;
    dynamic_memory?: boolean;
    min_ram?: string;
    max_ram?: string;
    network?: {
        vpcId?: string;
        subnetId?: string;
    };
    cloudInit?: CloudInitConfig;
}

const CloudInitSchema = objectStrict<CloudInitConfig>({
    hostname: optional(isString),
    user: optional(isString),
    ssh_authorized_keys: optional(arrayOf(isString)),
    packages: optional(arrayOf(isString)),
    runcmd: optional(arrayOf(isString)),
    enableSerial: optional(isBoolean),
    serialReboot: optional(isBoolean),
    network: optional(
        objectStrict({
            mode: optional(isEnum(["dhcp"] as const)),
        })
    ),
});

const VmCreateSchema = objectStrict<VmCreatePayload>({
    name: isString,
    imageId: optional(isString),
    cpu: optional(isInteger),
    generation: optional(isInteger),
    ram: optional(isString),
    dynamic_memory: optional(isBoolean),
    min_ram: optional(isString),
    max_ram: optional(isString),
    network: optional(
        objectStrict({
            vpcId: optional(isString),
            subnetId: optional(isString),
        })
    ),
    cloudInit: optional(CloudInitSchema),
});

const PRE = {
    "vm.create": VmCreateSchema,

    "console.serial.open": objectStrict({
        readOnly: optional(isBoolean),
        timeoutSec: optional(isInteger),
    }),

    "vm.power": objectStrict({
        guid: optional(isString),
        state: isEnum(["start", "stop", "restart"] as const),
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

    echo: objectStrict({
        message: optional(isString),
    }),
} as const satisfies Record<string, Validator<unknown>>;

export type TaskAction = keyof typeof PRE;

export function isKnownAction(action: string): action is TaskAction {
    return Object.prototype.hasOwnProperty.call(PRE, action);
}

export function preValidate(action: string, data: unknown): ValidationResult<unknown> {
    const schema = (PRE as Record<string, Validator<unknown>>)[action];
    if (!schema) {
        return { ok: false, value: undefined, errors: [`action: UNKNOWN_ACTION (${action})`] };
    }
    return validate(schema, data);
}
