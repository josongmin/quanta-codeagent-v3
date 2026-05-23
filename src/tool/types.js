/**
 * SEAM-MIRROR STRUCTURAL HASH (literal anchor; no cross-slice import).
 *
 * The `@/tool` slice CANNOT import from `@/agent` or `@/permission` (RFC §3.1
 * slice fence; biome enforces structurally), so a direct cross-slice
 * `Equals<>`/`satisfies` compile check is impossible HERE. The closed-union
 * mirrors above (`GitWriteProtectReason`, `BlockerSurface`) are documented as
 * convention-only — reviewers verify on PR and a consumer-side round-trip test
 * in `tests/unit/` (which CAN see both slices) catches drift at test time.
 *
 * This `as const` tuple is a literal grep anchor: a future drift in the union
 * literal MUST be reflected here too, and a consumer-side test asserts the
 * tuple matches the producer's `ALL_*` array. The `satisfies` clauses below
 * are pure in-slice checks — they verify the tuple's literal set matches THIS
 * file's mirror exactly (catches drift between the mirror and the anchor).
 *
 * If you add a 6th `GitWriteProtectReason`:
 *   1. add the literal to the producer (`src/permission/git-write-guard.ts`).
 *   2. add it to the mirror union above.
 *   3. add it to this anchor tuple.
 *   4. extend `ALL_GIT_WRITE_PROTECT_REASONS` in the producer.
 * Steps 2-3 are local — the satisfies below will fail to compile if you skip
 * either. Steps 1+4 are caught by the consumer-side round-trip test.
 */
export const GIT_WRITE_PROTECT_REASONS_MIRROR = [
    "git_hooks",
    "git_hooks_dir",
    "git_config",
    "git_attributes",
    "editor_config",
];
export const BLOCKER_SURFACES_MIRROR = [
    "type",
    "owner",
    "wire",
    "test",
    "runtime",
    "build",
    "other",
];
// Force evaluation — if either lookup degrades to the error object the
// assignment fails at `tsc`, producing the message above.
const _gitWriteProtectReasonAnchorCheck = true;
const _blockerSurfaceAnchorCheck = true;
void _gitWriteProtectReasonAnchorCheck;
void _blockerSurfaceAnchorCheck;
