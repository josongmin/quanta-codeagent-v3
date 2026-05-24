/**
 * REPL paint helpers — small, byte-identical primitives the REPL surface
 * called inline. Extracted so the contract appears in ONE place instead of
 * being duplicated verbatim at 7+ call sites.
 */

/**
 * Single byte-identical blank-line painter for the REPL.
 *
 * Centralizes a contract that 7+ call sites previously copied verbatim:
 *   `process.stderr.write("\n")`
 *
 * The choice of `stderr` (not `stdout`) is load-bearing:
 *   - `stdout` is reserved for the agent stream / one-shot prompt output;
 *   - the composer chrome (prompts, banners, blank rows) MUST go to `stderr`
 *     so a piped consumer (`quanta "..." | jq`) sees only the agent text.
 *
 * Single newline char exactly — no flush, no ANSI, no padding — to remain
 * byte-identical to every site this replaces.
 */
export const paintBlankLine = (): void => {
  process.stderr.write("\n")
}
