/**
 * SSOT for the set of FILE-EDIT (mutating-FS) tool names — the tools that write
 * source files. Shared by every guard that must reason about "did the model edit
 * a file": the localize-phase Phase-1 block AND the verify-guard finish gate.
 *
 * Why one SSOT: the two guards previously kept SEPARATE sets and DRIFTED —
 * localize-phase covered all 5 edit tools while verify-guard covered only
 * {edit, write}, so a model that fixed source via `apply_patch`/`scripted_replace`
 * then declared "done" was NEVER finish-gated (the regression-trap class). One
 * declaration here means a new edit tool can't be added to one guard but missed
 * by the other.
 *
 * `bash` is DELIBERATELY EXCLUDED: a `bash` with `>` redirection / `sed -i` IS
 * technically a write, but bash is also the test/repro/probe channel — the
 * verify-guard treats bash as a VERIFY signal, and the localize-phase guard
 * exempts it so exploration isn't blocked. Adding a new dedicated edit tool
 * (e.g. `multi_edit`) requires listing it HERE (and updating the ADR) — silent
 * coverage would be a policy regression. The closed set is exported for
 * invariant tests.
 */
export const MUTATING_FS_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "scripted_replace",
  "apply_patch",
  "apply_patch_structured",
])
