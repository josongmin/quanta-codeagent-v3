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
import {
  applyPatch,
  PatchAnchorNotFoundError,
  PatchApplyError,
  type PatchFileSystemPort,
  PatchParseError,
  parsePatch,
} from "@/patch"
import type { ToolAction } from "@/permission"
import { emitOperatorNotice, errMessage, gateOn } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
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
  // Preview reads must cross the same jail constructor as the eventual tool.
  // Otherwise approval can inspect a path execution will necessarily reject.
  const resolve = (p: string): string => resolveJailed(p, opts.cwd)
  try {
    switch (action.tool) {
      case "edit":
        return await preflightEdit(action.input, resolve, reader)
      case "apply_patch":
        return await preflightApplyPatch(action.input, resolve, reader, "apply_patch")
      case "apply_patch_structured":
        return await preflightApplyPatch(action.input, resolve, reader, "apply_patch_structured")
      default:
        return undefined
    }
  } catch (e) {
    // Best-effort: an unexpected internal failure must not surface mid-prompt
    // (the collapse to `undefined` stays). WS-G (UUX-6-16) — but it must not
    // be INVISIBLE: one latched warn per session so the operator knows the
    // pre-flight preview is degraded, not silently vouching.
    notePreflightInternalFailure(e)
    return undefined
  }
}

/** WS-G (UUX-6-16) — latched (once per session) internal-failure notice.
 *  Latching lives at module level because the pre-flight is stateless and
 *  invoked per approval prompt; a broken preview would otherwise warn on
 *  every confirm. */
let preflightFailureNotified = false

const notePreflightInternalFailure = (e: unknown): void => {
  if (preflightFailureNotified) return
  preflightFailureNotified = true
  emitOperatorNotice({
    severity: "warn",
    source: "preflight",
    message: `approval pre-flight check failed internally: ${errMessage(e)}`,
    hint: "previews are degraded this session; tools may still apply/fail normally",
  })
}

/** Test hygiene — clear the once-per-session latch. */
export const __resetPreflightFailureNoticeForTest = (): void => {
  preflightFailureNotified = false
}

// ───────────────────────────────────────────────────────────────────────
// edit
// ───────────────────────────────────────────────────────────────────────

/** Read the file an `edit` targets, or the warning to surface INSTEAD of a
 *  match verdict. A unit because every read failure means the same thing to the
 *  preflight — "we cannot judge this edit" — but each failure has a different
 *  operator-facing reason (jailed path, missing file, unreadable), and mixing
 *  those three messages into the match logic is what made the check unreadable.
 *  Exactly one of `source` / `warning` is set. */
const readEditTarget = async (
  filePath: string,
  resolve: (p: string) => string,
  reader: (p: string) => Promise<string>,
): Promise<{ readonly source: string; readonly warning?: undefined } | { readonly source?: undefined; readonly warning: string }> => {
  try {
    return { source: await reader(resolve(filePath)) }
  } catch (e) {
    if (e instanceof FsJailError) return { warning: jailWarning("edit", filePath) }
    if (isAbsentReadError(e)) {
      // edit requires an existing file; a missing target is a hard miss.
      return { warning: `${WARN} edit ${filePath} — file not found; the edit will fail` }
    }
    return {
      warning: `${WARN} edit ${filePath} — cannot safely inspect the target; the tool may reject it`,
    }
  }
}

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

  const read = await readEditTarget(filePath, resolve, reader)
  if (read.warning !== undefined) return read.warning
  const source = read.source

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
    } catch (e) {
      if (isAbsentReadError(e)) return false
      throw e
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
  toolName: "apply_patch" | "apply_patch_structured",
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
    if (e instanceof FsJailError) return jailWarning(toolName)
    if (
      e instanceof PatchParseError ||
      e instanceof PatchApplyError ||
      e instanceof PatchAnchorNotFoundError
    ) {
      const verdict =
        toolName === "apply_patch_structured"
          ? "one or more files may fail while clean siblings can still apply"
          : "will not cleanly apply"
      return `${WARN} ${toolName} — ${verdict}: ${errMessage(e)}`
    }
    if (!isAbsentReadError(e)) {
      return `${WARN} ${toolName} — cannot safely inspect a target; the tool may reject it`
    }
    // WS-G (UUX-6-16) — an unexpected internal error is a preview bug, not an
    // apply verdict; the verdict stays silent but the degrade is latched once.
    notePreflightInternalFailure(e)
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

/** A jailed execution would hard-deny this target. Preview reports that
 * deterministically and never invokes its reader on an escaped path. */
const jailWarning = (toolName: string, path?: string): string =>
  `${WARN} ${toolName}${path === undefined ? "" : ` ${path}`} — target is outside the workspace jail; the tool will reject it`

const defaultReadFile = (p: string): Promise<string> => readFile(p, "utf8")

/** Only confirmed absence maps to a normal preflight "file not found" verdict.
 * Permission/I/O failures remain explicit uncertainty instead of a misleading
 * clean preview or a silent false-negative existence check. */
const isAbsentReadError = (e: unknown): boolean => {
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = (e as { readonly code?: unknown }).code
    if (code === "ENOENT" || code === "ENOTDIR") return true
  }
  return e instanceof Error && /\bENOENT\b|\bENOTDIR\b/.test(e.message)
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
