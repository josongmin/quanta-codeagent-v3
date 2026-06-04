/**
 * Edit-repair composition wire (ADR-0472 — composition-layer adapter).
 *
 * WHAT: builds the ports the edit-repair LOOP (`./edit-repair-loop/runner.ts`)
 * needs, but cannot build itself (the loop slice imports `@/shared` ONLY). This
 * file lives at the composition layer of `@/agent` — like `lsp-bridge.ts` /
 * `mcp-bridge.ts`, it is the ONE place allowed to adapt real infra
 * (`@/llm` LLMPort, `@/tool/diagnostics` DiagnosticsProvider, an exec port)
 * down onto the slice's injected PORT shapes.
 *
 * Three adapters:
 *   - `buildRepairReactor(llm, opts)` → `RepairReactorPort`: a tools-DENIED
 *     single-shot fast-model call (mirrors `fast-apply-fallback`'s inversion —
 *     the LLM is INJECTED, never imported as a concrete adapter). Given the
 *     failure + per-loop custom instructions + the target file, it asks the
 *     model for a corrected edit, applies it via the injected `apply` fn, and
 *     returns a `RepairAttempt`.
 *   - `lintRepairCheck(provider, filePath, cwd, preDiags)` → `RepairCheck`:
 *     snapshots diagnostics for the file, computes the lint-delta vs the
 *     pre-edit snapshot, returns `ok(null)` when nothing was introduced else
 *     `ok({check:"lints", diagnostics})`.
 *   - `commandRepairCheck(exec, command)` → `RepairCheck`: runs the command;
 *     exit 0 → `ok(null)`; exit≠0 → `ok({check:"command", output, exitCode})`.
 *
 * NO-THROW (boundary contract): every infra error — a stream that throws on
 * construction or mid-iteration, an apply fn that throws or returns `err`, a
 * diagnostics provider that throws or is unavailable, an exec that throws —
 * collapses to a typed, degraded-but-valid outcome (`applied:false` /
 * `err(msg)`), NEVER an exception past the port boundary.
 *
 * DEFAULT-OFF: nothing here runs unless the composition root wires it behind
 * `editRepairLoopEnabled` (gate `QUANTA_EDIT_REPAIR_LOOP`). Building an adapter
 * is inert; only `runRepairLoop` drives it.
 */

import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { errMessage, ok, type Result } from "@/shared"
import type {
  DiagnosticItem,
  DiagnosticsProvider as ToolDiagnosticsProvider,
} from "@/tool/diagnostics"
import { computeLintDelta } from "./edit-repair-loop/lint-delta"
import type {
  Diagnostic,
  RepairAttempt,
  RepairCheck,
  RepairFailure,
  RepairReactorPort,
  RepairRequest,
} from "./edit-repair-loop/types"

// ---------------------------------------------------------------------------
// buildRepairReactor
// ---------------------------------------------------------------------------

/** Applies a corrected file revision the repair model produced. INJECTED so the
 *  hellgate uses a fake (the real adapter at the composition root writes the
 *  file / re-runs apply_patch). NO-THROW by contract — but the reactor catches
 *  throws too, so an `err` Result and a thrown error both map to applied:false. */
export type RepairApplyFn = (
  file: string,
  content: string,
  signal?: AbortSignal,
) => Promise<Result<void, string>>

/** Options for {@link buildRepairReactor}. */
export interface RepairReactorOpts {
  /** How the model's corrected edit lands on disk. INJECTED. */
  readonly apply: RepairApplyFn
}

/**
 * Build the fast-model repair reactor. Mirrors `fast-apply-fallback`'s port
 * inversion: the `LLMPort` is INJECTED (no concrete adapter import), the call
 * is a single tools-DENIED streamed turn, and every failure mode collapses to
 * `applied:false` (NO-THROW).
 */
export const buildRepairReactor = (llm: LLMPort, opts: RepairReactorOpts): RepairReactorPort => {
  return async (req: RepairRequest, signal?: AbortSignal): Promise<RepairAttempt> => {
    if (signal?.aborted) {
      return { applied: false, rationale: "aborted before dispatch" }
    }

    const input: StreamInput = {
      messages: [{ role: "user", content: [{ type: "text", text: buildRepairPrompt(req) }] }],
      // Tools are DENIED: the repair model emits a corrected edit as text only;
      // it never gets to call tools (the loop, not the model, drives apply).
      tools: [],
      ...(signal ? { signal } : {}),
    }

    let reply: string
    try {
      reply = await collectText(llm.stream(input))
    } catch (e) {
      return { applied: false, rationale: `repair model stream failed: ${errMessage(e)}` }
    }

    const content = reply.trim()
    if (content.length === 0) {
      return { applied: false, rationale: "repair model returned no content" }
    }

    if (signal?.aborted) {
      return { applied: false, rationale: "aborted before apply" }
    }

    let applied: Result<void, string>
    try {
      applied = await opts.apply(req.file, reply, signal)
    } catch (e) {
      return { applied: false, rationale: `apply threw: ${errMessage(e)}` }
    }

    if (!applied.ok) {
      return { applied: false, rationale: `apply rejected the edit: ${applied.error}` }
    }

    return { applied: true, rationale: `repair model edited ${req.file}` }
  }
}

/**
 * Compose the repair prompt. Names the file under repair, renders the failing
 * check (introduced lints / test+command output), and appends the per-loop
 * custom instructions. Mirrors `buildFastApplyPrompt`'s focused single-shot
 * shape. Exported for the hellgate.
 */
export const buildRepairPrompt = (req: RepairRequest): string => {
  const lines: string[] = [
    `Repair the file ${req.file}. Your previous edit left a check failing.`,
    "",
    `Failing check: ${req.failure.check}`,
  ]
  if (req.failure.diagnostics.length > 0) {
    lines.push("Diagnostics introduced by your edit:")
    for (const d of req.failure.diagnostics) {
      const code = d.code.length > 0 ? ` [${d.code}]` : ""
      lines.push(`  ${d.file}:${d.line} (${d.severity})${code} ${d.message}`)
    }
  }
  if (req.failure.output.length > 0) {
    const exit = req.failure.exitCode !== undefined ? ` (exit ${req.failure.exitCode})` : ""
    lines.push(`Output${exit}:`, req.failure.output)
  }
  if (req.customInstructions.length > 0) {
    lines.push("", `Custom instructions: ${req.customInstructions}`)
  }
  lines.push(
    "",
    `Reply with ONLY the complete corrected contents of ${req.file}. No prose, no fences.`,
  )
  return lines.join("\n")
}

/** Drain a single streamed turn into its concatenated text. Ignores every
 *  non-text event (usage / progress / tool deltas — none expected here, tools
 *  are denied). `stream_reset` discards what was accumulated (a backup provider
 *  took over), matching the assembler contract. */
const collectText = async (stream: AsyncIterable<StreamEvent>): Promise<string> => {
  let text = ""
  for await (const ev of stream) {
    if (ev.type === "stream_reset") {
      text = ""
    } else if (ev.type === "text_delta") {
      text += ev.delta
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// lintRepairCheck
// ---------------------------------------------------------------------------

/** Map a tool-side `DiagnosticItem` (LSP coords, 4-level severity) down to the
 *  loop's `Diagnostic` (1-based line, 3-level severity). `information`/`hint`
 *  fold to `"info"` since the loop's identity tuple ignores severity anyway. */
const toLoopDiagnostic = (file: string, d: DiagnosticItem): Diagnostic => ({
  file,
  // tool side is 0-based LSP; loop renders 1-based.
  line: d.range.start.line + 1,
  code: d.code ?? "",
  message: d.message,
  severity: d.severity === "error" || d.severity === "warning" ? d.severity : "info",
  ...(d.range.start.character !== undefined ? { column: d.range.start.character + 1 } : {}),
})

/** Snapshot the file's current diagnostics via the tool provider, mapped to the
 *  loop's shape. Returns `err` when no server can handle the file (open → null)
 *  or any infra step throws. */
const snapshotDiagnostics = async (
  provider: ToolDiagnosticsProvider,
  filePath: string,
  cwd: string,
): Promise<Result<readonly Diagnostic[], string>> => {
  let session: Awaited<ReturnType<ToolDiagnosticsProvider["open"]>>
  try {
    session = await provider.open(filePath, cwd)
  } catch (e) {
    return { ok: false, error: `diagnostics provider threw: ${errMessage(e)}` }
  }
  if (session === null) {
    return { ok: false, error: `diagnostics unavailable: ${provider.unavailableReason(filePath)}` }
  }
  try {
    const items = await session.diagnostics(filePath)
    return ok(items.map((i) => toLoopDiagnostic(filePath, i)))
  } catch (e) {
    return { ok: false, error: `diagnostics run failed: ${errMessage(e)}` }
  } finally {
    await session.stop().catch(() => undefined)
  }
}

/**
 * Build a `lints` repair check. On each invocation it snapshots the file's
 * CURRENT diagnostics and diffs them against `preDiags` (the pre-edit snapshot)
 * via {@link computeLintDelta}, reporting only the diagnostics the edit
 * INTRODUCED. `ok(null)` ⇒ no new lints (green); `ok(failure)` ⇒ introduced
 * diagnostics; `err(msg)` ⇒ a broken / unavailable checker.
 */
export const lintRepairCheck = (
  provider: ToolDiagnosticsProvider,
  filePath: string,
  cwd: string,
  preDiags: readonly Diagnostic[],
): RepairCheck => {
  return async (_signal?: AbortSignal): Promise<Result<RepairFailure | null, string>> => {
    const post = await snapshotDiagnostics(provider, filePath, cwd)
    if (!post.ok) return post
    const introduced = computeLintDelta(preDiags, post.value)
    if (introduced.length === 0) return ok(null)
    const failure: RepairFailure = { check: "lints", diagnostics: introduced, output: "" }
    return ok(failure)
  }
}

// ---------------------------------------------------------------------------
// commandRepairCheck
// ---------------------------------------------------------------------------

/** One command run. INJECTED so the hellgate uses a fake (the real adapter at
 *  the composition root shells out via the bash/exec infra). NO-THROW is NOT
 *  required of the runner — {@link commandRepairCheck} catches its throws. */
export type ExecRunner = (
  command: string,
  signal?: AbortSignal,
) => Promise<{ exitCode: number; output: string }>

/**
 * Build a `command` repair check (drives a test runner / build / lint command).
 * Exit 0 ⇒ `ok(null)` (green). Exit≠0 ⇒ `ok({check:"command", output, exitCode})`.
 * A throwing runner ⇒ `err(msg)` (treated by the loop as `check-error`).
 */
export const commandRepairCheck = (exec: ExecRunner, command: string): RepairCheck => {
  return async (signal?: AbortSignal): Promise<Result<RepairFailure | null, string>> => {
    let res: { exitCode: number; output: string }
    try {
      res = await exec(command, signal)
    } catch (e) {
      return { ok: false, error: `command check threw: ${errMessage(e)}` }
    }
    if (res.exitCode === 0) return ok(null)
    const failure: RepairFailure = {
      check: "command",
      diagnostics: [],
      output: res.output,
      exitCode: res.exitCode,
    }
    return ok(failure)
  }
}
