/**
 * Strip undefined-valued keys so an object literal satisfies the
 * `exactOptionalPropertyTypes: true` rule. Replaces the repeated pattern:
 *     ...(x !== undefined ? { k: x } : {})
 * with:
 *     omitUndef({ k: x })
 *
 * Pure, no allocation amplification (one shallow copy), no prototype chain
 * surprises (uses a null-prototype scratch object — see pricing.ts for the
 * same defensive pattern).
 */
export const omitUndef = (o) => {
    const out = Object.create(null);
    for (const k in o) {
        const v = o[k];
        if (v !== undefined)
            out[k] = v;
    }
    return out;
};
