/**
 * Tiny `clsx`-style helper — joins truthy string/falsey-coerced inputs into a
 * space-separated class list. We avoid `clsx` as a dep because the helper is
 * <20 LOC and adding a runtime dep for a one-liner is wasteful.
 *
 * Accepts strings, `null`/`undefined`/`false`/`""` (skipped), and nested
 * arrays for grouped variants.
 */

export type ClassValue = string | false | null | undefined | ClassValue[]

export const cx = (...values: readonly ClassValue[]): string => {
  const out: string[] = []
  const walk = (value: ClassValue): void => {
    if (value === false || value === null || value === undefined) return
    if (typeof value === "string") {
      if (value.length > 0) out.push(value)
      return
    }
    for (const item of value) walk(item)
  }
  for (const value of values) walk(value)
  return out.join(" ")
}
