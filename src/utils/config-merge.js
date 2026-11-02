const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

function isConfigObject(value) {
    return value !== null && Object.prototype.toString.call(value) === '[object Object]';
}

function configKeys(value) {
    return Reflect.ownKeys(value).filter(key =>
        !unsafeKeys.has(key) && Object.prototype.propertyIsEnumerable.call(value, key)
    );
}

/**
 * Copy configuration data without inherited or prototype-mutating fields.
 * Functions and runtime values such as dates, URLs and abort signals keep their identity.
 * Non-enumerable metadata (including account slot leases) stays with its owner.
 */
export function cloneConfig(value) {
    if (Array.isArray(value)) {
        return value.map(cloneConfig);
    }
    if (!isConfigObject(value)) {
        return value;
    }

    const copy = {};
    for (const key of configKeys(value)) {
        copy[key] = cloneConfig(value[key]);
    }
    return copy;
}

/**
 * Merge global and provider configuration without modifying either input.
 * Keep the existing configuration rules: objects merge recursively, arrays
 * concatenate, and other provider values (including null/false) replace defaults.
 * Filter unsafe keys in both inputs, including values nested inside arrays.
 */
export function mergeConfig(base, override) {
    if (Array.isArray(override)) {
        return (Array.isArray(base) ? base.concat(override) : override).map(cloneConfig);
    }
    if (!isConfigObject(override)) {
        return cloneConfig(override);
    }

    const merged = isConfigObject(base) ? cloneConfig(base) : {};
    for (const key of configKeys(override)) {
        merged[key] = Object.hasOwn(merged, key)
            ? mergeConfig(merged[key], override[key])
            : cloneConfig(override[key]);
    }
    return merged;
}
