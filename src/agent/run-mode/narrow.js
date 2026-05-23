/**
 * Type-narrowing helpers + runtime matrix assert (RFC §6.2). The compile-time
 * narrow is the primary defense; the runtime assert is defense-in-depth
 * against unsafe casts and dynamic-dispatch paths.
 *
 * Usage:
 *   const policy = MODE_PRESETS.batch
 *   narrowMode("batch", policy)       // asserts policy is ModePolicy & {mode:"batch"}
 *   assertModeMatrix(policy)          // throws on matrix violations
 *
 * `narrowMode` is a TS assertion function — it does not return; it narrows.
 */
import { MODE_PRESETS } from "./presets";
import { LEVER_FIELDS } from "./types";
/**
 * Compile-time narrow: after this call, `policy` is typed as
 * `ModePolicy & { mode: M }` so subsequent code can rely on the matrix
 * column for that mode. Mismatch throws at runtime as defense-in-depth.
 */
export function narrowMode(mode, policy) {
    if (policy.mode !== mode) {
        throw new Error(`narrowMode: expected policy.mode === ${JSON.stringify(mode)} but got ${JSON.stringify(policy.mode)}`);
    }
}
/**
 * Defensive runtime check enforcing the full matrix from RFC §6.2.
 *
 * Audit R1 fix: the prior implementation hand-checked only 13 of the 48 cells
 * (3-5 levers per mode), so a cast-corrupted lever in any unchecked cell
 * sailed through — defeating the stated "defense against unsafe casts"
 * purpose. This version compares EVERY one of the 12 lever `kind`s against
 * the canonical `MODE_PRESETS[mode]` reference, so all 48 cells are enforced
 * and the check can never drift from the preset matrix (single source of
 * truth). Propositional only — string `kind` equality, no thresholds.
 */
export const assertModeMatrix = (policy) => {
    const ref = MODE_PRESETS[policy.mode];
    if (ref === undefined) {
        throw new Error(`matrix: unknown mode ${JSON.stringify(policy.mode)}`);
    }
    for (const lever of LEVER_FIELDS) {
        const got = policy[lever].kind;
        const want = ref[lever].kind;
        if (got !== want) {
            throw new Error(`matrix: ${policy.mode} mode requires ${lever}.kind === ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        }
    }
};
