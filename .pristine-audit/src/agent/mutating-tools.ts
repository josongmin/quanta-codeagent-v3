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

/** V4A file-marker scan — every path an `apply_patch`/`apply_patch_structured`
 *  patch text touches (`*** Add|Update|Delete File:`, `*** Move to:`). Pure
 *  string scan; tolerant of malformed input (returns what it finds). */
export const v4aTargetPaths = (patch: string): string[] => {
  const out: string[] = []
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm
  for (const m of patch.matchAll(re)) {
    const p = (m[1] ?? m[2] ?? "").trim()
    if (p) out.push(p)
  }
  return out
}

/** The target file path(s) a mutating call would write, keyed off the SSOT
 *  {@link MUTATING_FS_EDIT_TOOLS} so every consumer (test-scope pre-flight,
 *  thrash-dedup bucketing) agrees on "which file does this call touch" — the
 *  drift this module exists to kill (a new edit tool covered by one consumer
 *  but not the other):
 *   - `edit`/`write`            → `input.path`
 *   - `scripted_replace`        → `input.file`
 *   - `apply_patch`(_structured) → every file marker in `input.patch` (multi-file)
 *  Defensive against `input:unknown`: a non-mutating or malformed shape yields
 *  `[]` (never a false target). NOTE: this is the "full mutating-set" extractor;
 *  the edit-repair lint bracket ({@link ../dispatch/edit-repair}) deliberately
 *  uses a NARROWER single-file `edit`/`write` probe because a multi-file patch's
 *  lint delta cannot be attributed to one file — a different concern, not drift. */
export const mutatingTargetPaths = (name: string, input: unknown): string[] => {
  if (!MUTATING_FS_EDIT_TOOLS.has(name)) return []
  if (typeof input !== "object" || input === null) return []
  const o = input as Record<string, unknown>
  if (name === "scripted_replace") return typeof o.file === "string" ? [o.file] : []
  if (name === "apply_patch" || name === "apply_patch_structured") {
    return typeof o.patch === "string" ? v4aTargetPaths(o.patch) : []
  }
  // edit | write — guard above guarantees one of these remains
  return typeof o.path === "string" ? [o.path] : []
}
