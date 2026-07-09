/**
 * D-6 (jul-10, Wave-4) — the "not wired" EXIT-CODE CONVENTION, as one leaf.
 *
 * Convention (adopted by every not-wired surface site):
 *
 *   - print `"<feature>: not wired in this surface"` — one line, stdout
 *     (surface chrome), never a throw;
 *   - when the wire has a KNOWN env gate, print a machine-greppable
 *     `hint: set <GATE>=1 to enable` line naming EVERY missing flag
 *     (UUX-2-22 / UUX-6-17 — the operator must never have to source-dive to
 *     learn the switch);
 *   - when no gate exists, print NOTHING speculative — a free-form `hint:`
 *     line is allowed, an invented env var is not;
 *   - return **EXIT CODE 2** ({@link NOT_WIRED_EXIT}).
 *
 * Why 2: `0` claimed success while nothing happened (UUX-4-27 — scripts
 * treating exit 0 as "it ran" were being lied to), and `1` is the established
 * "user/runtime error" code. `2` = "this surface cannot answer" — distinct,
 * scriptable, and greppable via the `hint:` prefix.
 *
 * Slice pin: pure leaf, ZERO imports. Callers pass their own writer
 * (`ctx.out`) so the helper stays surface-agnostic and unit-testable.
 */

/** The D-6 exit code: the feature is not wired in this surface. */
export const NOT_WIRED_EXIT = 2

export interface NotWiredSpec {
  /** Display name of the surface entry point, e.g. `"/dream"`. */
  readonly feature: string
  /** KNOWN env gate(s) that wire the feature. Multi-flag features pass every
   *  MISSING flag so the hint says exactly what to flip (UUX-6-17). */
  readonly gate?: string | readonly string[] | undefined
  /** Free-form hint for wires WITHOUT an env gate (never invent one). */
  readonly hint?: string | undefined
}

/**
 * Print the honest not-wired posture and return {@link NOT_WIRED_EXIT}.
 * `out` is the caller's stdout writer (`SlashContext.out`).
 */
export const notWired = (out: (chunk: string) => void, spec: NotWiredSpec): number => {
  out(`${spec.feature}: not wired in this surface\n`)
  const gates = typeof spec.gate === "string" ? [spec.gate] : (spec.gate ?? [])
  if (gates.length > 0) {
    out(`hint: set ${gates.map((g) => `${g}=1`).join(" and ")} to enable\n`)
  }
  if (spec.hint !== undefined && spec.hint.length > 0) {
    out(`hint: ${spec.hint}\n`)
  }
  return NOT_WIRED_EXIT
}
