import type { ToolUseBlock } from "@/llm"
import type { LLMPort } from "@/llm/ports"
import { err, errMessage, ok, runtimeConfig } from "@/shared"
import { writeFile } from "@/storage"
import type { DiagnosticItem } from "@/tool"
import {
  computeLintDeltaTolerant,
  type Diagnostic,
  type RepairReactorPort,
  renderLintDelta,
  runRepairLoop,
} from "../edit-repair-loop"
import { buildRepairReactor, commandRepairCheck, lintRepairCheck } from "../edit-repair-wire"
import type { AgentConfig } from "../types"

/** ADR-0472 — repair-loop attempt cap DEFAULT. NOT a tunable heuristic: ≥2 so the
 *  model sees its OWN first failure fed back at least once before the loop gives
 *  up; bounded small so a stuck repair can never spin the dispatch hot path. A
 *  host may override via `config.editRepair.maxIters` (Cursor `maxIters` parity).
 */
const REPAIR_MAX_ITERS = 2

/** H1 — resolve the repair iteration cap: the host's `config.editRepair.maxIters`
 *  when it is a valid integer ≥ 1, else {@link REPAIR_MAX_ITERS}. Keeps the magic
 *  number in ONE place and rejects a malformed override (0 / negative / NaN /
 *  fractional) rather than letting it weaken the bound. Pure. */
const resolveRepairMaxIters = (config: AgentConfig): number => {
  const n = config.editRepair?.maxIters
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : REPAIR_MAX_ITERS
}

/** H1 — the shared fast-model repair reactor for a path-bearing edit: writes the
 *  model's corrected file content back through the storage port. The LINT loop
 *  and the COMMAND loop drive the SAME apply (a repaired edit is a repaired edit
 *  regardless of which check flagged it), so the apply closure lives in ONE
 *  place. NO-THROW: a write failure collapses to `err(msg)`, which the runner
 *  treats as a declined attempt (loop ends, output unchanged). */
const buildEditApplyReactor = (llm: LLMPort, cwd: string | undefined): RepairReactorPort =>
  buildRepairReactor(llm, {
    apply: async (file, content) => {
      try {
        await writeFile(file, content, cwd)
        return ok(undefined)
      } catch (e) {
        return err(errMessage(e))
      }
    },
  })

/** ADR-0472 — extract the single target path of a path-bearing EDIT tool
 *  (`edit`/`write`), or `null` for anything else (apply_patch is multi-file —
 *  deferred; non-edit tools have no lint-delta). Pure, no-throw. */
const extractEditPath = (call: ToolUseBlock): string | null => {
  if (call.name !== "edit" && call.name !== "write") return null
  const input = call.input as Record<string, unknown> | null | undefined
  if (input === null || typeof input !== "object") return null
  for (const key of ["path", "file_path", "file"] as const) {
    const v = input[key]
    if (typeof v === "string" && v.length > 0) return v
  }
  return null
}

/** ADR-0495 — the edit's NET line delta (newlines added − removed), the
 *  tolerance window for {@link computeLintDeltaTolerant} so a pre-existing lint
 *  that merely shifted lines is not mis-reported as introduced. Derived from the
 *  edit INPUT (no extra I/O): `edit` ⇒ Δnewlines(new_string, old_string);
 *  `write` ⇒ 0 (full overwrite — prior line count unknown, so fall back to the
 *  exact-line legacy behavior). Pure, no-throw. */
const countNewlines = (s: string): number => {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}
const editLineShift = (call: ToolUseBlock): number => {
  const input = call.input as Record<string, unknown> | null | undefined
  if (call.name !== "edit" || input === null || typeof input !== "object") return 0
  const o = input.old_string
  const n = input.new_string
  if (typeof o !== "string" || typeof n !== "string") return 0
  return countNewlines(n) - countNewlines(o)
}

/** Map a `@/tool` `DiagnosticItem` (LSP-shaped, 0-based, severity incl.
 *  information/hint) to the edit-repair `Diagnostic` (1-based-agnostic, severity
 *  error|warning|info). Pure. */
const toDiag = (item: DiagnosticItem, file: string): Diagnostic => ({
  file,
  line: item.range.start.line,
  column: item.range.start.character,
  code: item.code ?? "",
  message: item.message,
  severity: item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "info",
})

/** ADR-0472 — open a lint-delta bracket around a path-bearing edit. Returns a
 *  `finish(output)` that appends the INTRODUCED-lint delta (post − pre), or
 *  `null` when the feature is off / no provider / non-edit / no session
 *  (graceful degradation — byte-identical output). The provider session is
 *  opened BEFORE the edit (pre-snapshot) and queried after (post-snapshot).
 *  NO-THROW: any provider error degrades to a null bracket. */
export const openLintBracket = async (
  call: ToolUseBlock,
  config: AgentConfig,
): Promise<{ finish: (output: string) => Promise<string> } | null> => {
  if (!runtimeConfig().editRepairLoop) return null
  const provider = config.diagnosticsProvider
  if (provider === undefined) return null
  const filePath = extractEditPath(call)
  if (filePath === null) return null
  try {
    const session = await provider.open(filePath, config.cwd)
    if (session === null) return null
    const pre = await session.diagnostics(filePath)
    return {
      finish: async (output: string): Promise<string> => {
        try {
          const post = await session.diagnostics(filePath)
          // ADR-0495 — tolerant delta: pass the edit's net line delta so a
          // pre-existing lint that merely shifted lines is NOT mis-blamed on the
          // edit. lineShift=0 (write / no shift) ≡ the legacy exact-line delta.
          const introduced = computeLintDeltaTolerant(
            pre.map((d) => toDiag(d, filePath)),
            post.map((d) => toDiag(d, filePath)),
            editLineShift(call),
          )
          if (introduced.length === 0) {
            await session.stop()
            return output
          }
          // ADR-0472 active repair — when the edit introduced lints AND a model is
          // wired, drive a bounded fast-model loop to CLEAR them (re-edit → re-check
          // until green / maxIters). No model ⇒ fall back to the passive lint-delta
          // annotation (the model self-corrects next turn). NO-THROW throughout.
          const llm = config.llm
          if (llm === undefined) {
            await session.stop()
            return `${output}\n\n${renderLintDelta(introduced)}`
          }
          const reactor = buildEditApplyReactor(llm, config.cwd)
          // `lintRepairCheck` works in 1-based line space (matching the wire's
          // `toLoopDiagnostic`); `toDiag` keeps the LSP 0-based line, so +1 the
          // pre-snapshot here or the delta would read as all-introduced.
          const pre1Based: Diagnostic[] = pre.map((d) => ({
            ...toDiag(d, filePath),
            line: d.range.start.line + 1,
          }))
          const check = lintRepairCheck(provider, filePath, config.cwd, pre1Based)
          const report = await runRepairLoop(
            {
              file: filePath,
              checkKind: "lints",
              maxIters: resolveRepairMaxIters(config),
              customInstructions: config.editRepair?.customInstructions ?? "",
            },
            { check, reactor },
            config.signal,
          )
          await session.stop()
          return report.green
            ? `${output}\n\n[edit-repair] cleared the edit's introduced lints in ${report.attempts} attempt(s).`
            : `${output}\n\n${renderLintDelta(introduced)}\n[edit-repair] could not auto-clear (${report.stop}); please fix the above.`
        } catch {
          return output // NO-THROW: any snapshot/loop failure leaves output unchanged.
        }
      },
    }
  } catch {
    return null // NO-THROW: a pre-snapshot/open failure ⇒ no bracket.
  }
}

/** ADR-0472 / H1 — LoopOnCommand / LoopOnTests. After a path-bearing edit
 *  (`edit`/`write`), when the host wired `config.editRepair.{command,exec}` AND
 *  the repair loop is on AND a fast `llm` is available, run the configured
 *  command (a test / build / lint script) and, on non-zero exit, drive a bounded
 *  `checkKind:"command"` repair loop that re-edits the file until the command
 *  goes green or `maxIters`. INDEPENDENT of the diagnostics provider — a host can
 *  enable LoopOnCommand without any LSP. Returns `output` UNCHANGED when the
 *  feature is off / the tool is not an edit / command|exec|llm is unwired, so the
 *  default path is byte-identical. NO-THROW: any loop/apply failure leaves the
 *  output untouched (pure observability augmentation, never breaks the turn). */
export const runEditCommandRepair = async (
  call: ToolUseBlock,
  config: AgentConfig,
  output: string,
): Promise<string> => {
  if (!runtimeConfig().editRepairLoop) return output
  const command = config.editRepair?.command
  const exec = config.editRepair?.exec
  const llm = config.llm
  // An empty / whitespace-only command means "no command wired" (a host that set
  // the field to "" is opting OUT), NOT "run the empty string" — guard it so we
  // never shell out to a blank command.
  if (
    command === undefined ||
    command.trim().length === 0 ||
    exec === undefined ||
    llm === undefined
  ) {
    return output
  }
  const filePath = extractEditPath(call)
  if (filePath === null) return output
  try {
    const report = await runRepairLoop(
      {
        file: filePath,
        checkKind: "command",
        maxIters: resolveRepairMaxIters(config),
        customInstructions: config.editRepair?.customInstructions ?? "",
      },
      { check: commandRepairCheck(exec, command), reactor: buildEditApplyReactor(llm, config.cwd) },
      config.signal,
    )
    // Already-green (0 attempts) ⇒ no annotation: the command passed on the
    // first try, so the edit output stays byte-identical (no noise).
    if (report.green && report.attempts === 0) return output
    return report.green
      ? `${output}\n\n[edit-repair] \`${command}\` passed after ${report.attempts} repair attempt(s).`
      : `${output}\n\n[edit-repair] \`${command}\` still failing (${report.stop.kind}) after ${report.attempts} attempt(s); please fix.`
  } catch {
    return output // NO-THROW.
  }
}
