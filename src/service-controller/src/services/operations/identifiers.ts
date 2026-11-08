// These identifiers are also Windows path components in the Hyper-V adapter.
export function validPathSegment(value: unknown): value is string {
    if (typeof value !== "string" || !value || value.length > 128 || /[<>:"/\\|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value)) return false;
    return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
