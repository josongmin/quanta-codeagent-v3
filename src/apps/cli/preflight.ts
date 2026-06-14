/**
 * #19 — APPROVAL-TIME APPLICABILITY PRE-FLIGHT.
 *
 * Rendered in the CLI confirm prompt (right after the inline diff preview, see
 * `repl/runtime-context-compose.ts#buildCliOnConfirm`) so the operator learns,
 * BEFORE they approve, whether a mutating `edit` / `apply_patch` would actually
 * land — instead of approving a tool that immediately fails on a stale anchor /
 * missing target. Pure preview: this NEVER mutates the filesystem (it reuses the
 * SAME pre-flight plan the real tools run, but the `apply_patch` port suppresses
 * every write and `edit` only re-runs the in-memory matcher).
 *
 * Reuse, NOT reimplementation (no second matcher to drift):
 *   - edit         → `applyExactEdit` (+ `applyFuzzyEdit` when the action asked
 *                    for `fuzzy`), the SAME functions `@/tool/edit` runs. The
 *                    `line_ranges` validation mirrors the tool's `resolveLineRanges`.
 *   - apply_patch  → `parsePatch` + `applyPatch` against a {@link PreflightPatchPort}
 *                    whose reads are real but whose writes/deletes/renames are
 *                    no-ops, so the applier's PLAN phase does its full validation
 *                    (missing target / occupied move dest / unlocatable anchor)
 *                    while the COMMIT phase touches nothing.
 *
 * Best-effort, NEVER throws: any unexpected failure collapses to `undefined`
 * (no warning) so the confirm path is unaffected. A returned string is the
 * single-line warning to surface; `undefined` means "no concern — proceed".
 *
 * Layering: lives in `apps/cli` (the surface composition layer, which already
 * reaches `@/tool`/`@/patch`), NOT in `diff-preview.ts` (that module is
 * deliberately decoupled from the tool implementations). `write` always lands
 * (full overwrite) and `scripted_replace` already dry-runs in the diff preview,
 * so neither is pre-flighted here.
 */

import { readFile } from "node:fs/promises"
import * as path from "node:path"
import {
  applyPatch,
  PatchAnchorNotFoundError,
  PatchApplyError,
  type PatchFileSystemPort,
  PatchParseError,
  parsePatch,
} from "@/patch"
import type { ToolAction } from "@/permission"
import { errMessage, gateOn } from "@/shared"
// The SAME matchers the `edit` tool runs — reused so a preview verdict can never
// drift from the real apply. `@/tool/edit` is a library slice; `apps/cli` (the
// entrypoint) is allowed to import it (the slice fence only blocks the reverse).
import { applyExactEdit } from "@/tool/edit/exact"
import { applyFuzzyEdit } from "@/tool/edit/fuzzy"
import { type LineRange, validateLineRanges } from "@/tool/edit/line-range"

/** Whether the approval-time applicability pre-flight runs. Default ON when the
 *  CLI seeds `QUANTA_PREFLIGHT_CHECK=1` (see `CLI_FEATURE_GATES` in
 *  `apps/cli/index.ts`); any truthy vocab (`1`/`on`/`true`/`yes`) enables it.
 *  An explicit `"0"` / falsy value disables it so the confirm prompt is
 *  byte-identical to the pre-#19 path. Non-CLI surfaces never seed the gate ⇒
 *  they never call this. */
export const preflightCheckEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => gateOn(env, "QUANTA_PREFLIGHT_CHECK")

export interface PreflightOptions {
  /** Session cwd — relative paths in the action resolve against it (mirrors the
   *  tool's jail base = `ctx.cwd`). */
  readonly cwd: string
  /** Injection seam for tests + non-fs sources. Reads UTF-8 text; rejects when
   *  the file is absent/unreadable (the matchers treat that as "not found").
   *  Defaults to `node:fs/promises#readFile`. */
  readonly readFile?: (absPath: string) => Promise<string>
}

/**
 * Produce a one-line applicability warning for a mutating tool action, or
 * `undefined` when the action is expected to apply cleanly (or is not a class we
 * pre-flight). NEVER throws — a best-effort preview.
 */
export const preflightApplyWarning = async (
  action: ToolAction,
  opts: PreflightOptions,
): Promise<string | undefined> => {
  const reader = opts.readFile ?? defaultReadFile
  const resolve = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(opts.cwd, p))
  try {
    switch (action.tool) {
      case "edit":
        return await preflightEdit(action.input, resolve, reader)
      case "apply_patch":
        return await preflightApplyPatch(action.input, resolve, reader)
      default:
        return undefined
    }
  } catch {
    // Best-effort: an unexpected internal failure must not surface mid-prompt.
    return undefined
  }
}

// ───────────────────────────────────────────────────────────────────────
// edit
// ───────────────────────────────────────────────────────────────────────

const preflightEdit = async (
  input: unknown,
  resolve: (p: string) => string,
  reader: (p: string) => Promise<string>,
): Promise<string | undefined> => {
  const i = asRecord(input)
  if (i === undefined) return undefined
  const filePath = asString(i.path)
  const oldString = asString(i.old_string)
  const newString = asString(i.new_string)
  if (filePath === undefined || oldString === undefined || newString === undefined) return undefined
  const replaceAll = i.replace_all === true
  const fuzzy = i.fuzzy === true

  // Mirror the tool's `resolveLineRanges`: validate BEFORE matching so a
  // malformed span is reported as the model error it is, not a phantom "no match".
  const rangesRaw = liftLineRanges(i.line_ranges)
  if (rangesRaw !== undefined) {
    const verdict = validateLineRanges(rangesRaw)
    if (!verdict.ok) return `${WARN} edit ${filePath} — invalid line_ranges: ${verdict.message}`
  }
  const ranges = rangesRaw !== undefined && rangesRaw.length > 0 ? rangesRaw : undefined

  let source: string
  try {
    source = await reader(resolve(filePath))
  } catch {
    // edit requires an existing file; a missing target is a hard miss.
    return `${WARN} edit ${filePath} — file not found; the edit will fail`
  }

  const exact = applyExactEdit(source, oldString, newString, replaceAll, ranges)
  if (exact.ok) return undefined

  if (fuzzy) {
    const fz = applyFuzzyEdit(source, oldString, newString, replaceAll, ranges)
    if (fz.ok) return undefined // fuzzy rescues it — no concern
    return `${WARN} edit ${filePath} — exact AND fuzzy match failed: ${exact.message}`
  }
  // No fuzzy requested: exact missed. A wired fast-apply-merge rung MIGHT still
  // rescue it (default-OFF, host-dependent), so phrase it as "may not apply"
  // rather than a certainty, and point at the fuzzy escape hatch.
  return `${WARN} edit ${filePath} — old_string may not apply: ${exact.message} (pass fuzzy:true to try whitespace-tolerant matching)`
}

/** Coerce the raw `line_ranges` input into `LineRange[]`, or `undefined` when
 *  absent / not the expected `{start,end}[]` shape. Malformed-but-present ranges
 *  are surfaced by `validateLineRanges`, so we only need the structural lift. */
const liftLineRanges = (v: unknown): LineRange[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: LineRange[] = []
  for (const item of v) {
    const r = asRecord(item)
    if (r === undefined || typeof r.start !== "number" || typeof r.end !== "number")
      return undefined
    out.push({ start: r.start, end: r.end })
  }
  return out
}

// ───────────────────────────────────────────────────────────────────────
// apply_patch
// ───────────────────────────────────────────────────────────────────────

/**
 * A {@link PatchFileSystemPort} whose READS are real (delegated to the injected
 * reader, paths resolved against cwd) but whose WRITES are no-ops. Running the
 * real {@link applyPatch} against it exercises the applier's PLAN phase in full
 * — every existence check, anchor location, intra-patch overlay step — while
 * the COMMIT phase mutates nothing. A plan failure throws the SAME typed error
 * the real apply would; a clean plan resolves harmlessly.
 */
class PreflightPatchPort implements PatchFileSystemPort {
  constructor(
    private readonly resolve: (p: string) => string,
    private readonly reader: (p: string) => Promise<string>,
  ) {}

  readFile(p: string): Promise<string> {
    return this.reader(this.resolve(p))
  }

  async exists(p: string): Promise<boolean> {
    try {
      await this.reader(this.resolve(p))
      return true
    } catch {
      return false
    }
  }

  // Write-suppressed: the COMMIT phase touches nothing (this is a preview).
  async writeFile(): Promise<void> {}
  async deleteFile(): Promise<void> {}
  async renameFile(): Promise<void> {}
}

const preflightApplyPatch = async (
  input: unknown,
  resolve: (p: string) => string,
  reader: (p: string) => Promise<string>,
): Promise<string | undefined> => {
  const i = asRecord(input)
  if (i === undefined) return undefined
  const patchText = asString(i.patch)
  if (patchText === undefined) return undefined

  const port = new PreflightPatchPort(resolve, reader)
  try {
    const patch = parsePatch(patchText)
    await applyPatch(patch, port)
    return undefined // plan + (no-op) commit succeeded ⇒ will apply cleanly
  } catch (e) {
    // Only the KNOWN patch-failure classes mean "won't apply" — surface those.
    // An unexpected internal error is a preview bug, not an apply verdict, so it
    // stays silent (the outer try/catch already collapses it to undefined too).
    if (
      e instanceof PatchParseError ||
      e instanceof PatchApplyError ||
      e instanceof PatchAnchorNotFoundError
    ) {
      return `${WARN} apply_patch — will not cleanly apply: ${errMessage(e)}`
    }
    return undefined
  }
}

// ───────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────

/** Leading sigil for every pre-flight line so the operator can spot it against
 *  the diff above it. Plain text (no ANSI) — keeps the warning legible when
 *  stderr is piped/captured. */
const WARN = "⚠ pre-flight:"

const defaultReadFile = (p: string): Promise<string> => readFile(p, "utf8")

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
