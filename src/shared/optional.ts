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
export const omitUndef = <T extends object>(
  o: T,
): { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
} => {
  const out: Record<string, unknown> = Object.create(null)
  for (const k in o) {
    const v = (o as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out as never
}
