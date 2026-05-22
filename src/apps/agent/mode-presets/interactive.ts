/**
 * Mode-preset runner — INTERACTIVE.
 *
 * RFC may-22-unified-agent-runtime / Phase 4+. The unified agent surface
 * (`apps/agent/index.ts` — Track A) dispatches on `req.mode` to one of four
 * `runMode` functions; this is the `mode === "interactive"` cell.
 *
 * Interactive is the human-paced REPL: reviewer-backed permission, persistent
 * memory, full tool surface, multi-turn `user-stop` termination. Rather than
 * re-derive all of that here (the legacy entry point already wires it), this
 * preset DELEGATES to `apps/cli/repl#runRepl` — the single source of truth
 * for the REPL stack. The `assembleAgentConfig` call still runs (so the
 * `interactive` matrix is validated and the modePolicy/budgetMeter are
 * available for tests / future seams), but the REPL itself owns the run.
 *
 * Default-OFF byte-identical: when Track A's CLI wrapper invokes
 * `runMode({mode:"interactive", base:…})`, behavior is identical to a direct
 * `runRepl()` call from `apps/cli/index.ts` — no extra console output,
 * no extra side-effects.
 *
 * Slice boundary: this file may import `@/agent`, `@/llm`, `@/permission`,
 * `@/shared`, `@/tool`, `@/stream`, the sibling assemble.ts, AND
 * `apps/cli/repl` (the REPL is the deliberate cross-app delegate; the slice
 * isolation overrides allow it under `src/apps/**`). NO imports from other
 * mode-preset siblings.
 */

import type { AgentConfig } from "@/agent"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import { runRepl } from "../../cli/repl"
import {
  type AssembleRequest,
  assembleAgentConfig,
  type RunOutcome,
  resolveRunAgent,
} from "../assemble"
import { exitCodeForOutcome } from "../run"

/** Build the MINIMUM AgentConfig.base needed for `assembleAgentConfig` to
 *  validate the interactive matrix. Real wiring (llm + registry + REPL stream)
 *  lives in `runRepl` itself — this stub is only consumed when a test passes a
 *  `seams.runAgent` to bypass the REPL entirely. */
const stubBase = (req: AssembleRequest): Omit<AgentConfig, "modePolicy" | "budgetMeter"> => {
  const llm: LLMPort = req.base.llm
  const stream: StreamPort = req.base.stream
  const permission: PermissionContext = req.base.permission ?? { mode: "default" }
  const registry =
    req.base.registry !== undefined && req.base.registry instanceof ToolRegistry
      ? req.base.registry
      : new ToolRegistry(defaultTools)
  return {
    ...req.base,
    llm,
    registry,
    stream,
    permission,
    messages: req.base.messages ?? [],
    system: req.base.system ?? "",
    cwd: req.base.cwd ?? process.cwd(),
    maxTurns: req.base.maxTurns ?? 200,
    signal: req.base.signal ?? new AbortController().signal,
  }
}

/**
 * INTERACTIVE runner. Build the per-mode AgentConfig via `assembleAgentConfig`
 * (so the modePolicy + budgetMeter are present on the returned config), then
 * either:
 *
 *   - When `req.seams?.runAgent` is set (hermetic tests): call the stub and
 *     return its outcome. Bypasses the REPL stdin loop entirely.
 *   - Otherwise: delegate to `runRepl()` — the legacy REPL entry — and
 *     translate SIGINT to exit code 130, every other clean termination to 0.
 *
 * Returns `RunOutcome = { exitCode, outcome? }` exactly as Track A expects.
 */
export const runMode = async (req: AssembleRequest): Promise<RunOutcome> => {
  if (req.mode !== "interactive") {
    throw new Error(`interactive.runMode: req.mode must be "interactive", got "${req.mode}"`)
  }
  const cfg = assembleAgentConfig({ ...req, base: stubBase(req) })

  // Hermetic test path — never touch the real REPL.
  if (req.seams?.runAgent) {
    const runner = resolveRunAgent(req.seams)
    const outcome = await runner(cfg)
    // Canonical exit-code table (audit R2: was a bespoke `error?1:0`, which
    // mapped budget_exhausted/max_turns/aborted all to 0).
    return { exitCode: exitCodeForOutcome(outcome), outcome }
  }

  // Real REPL delegate. `runRepl` owns its own SIGINT wiring and exits via
  // `process.exit` on a fatal — we still wrap to convert any thrown abort to
  // 130 (the canonical SIGINT-on-exit code) so a future caller that prefers
  // graceful return-codes over process.exit gets a clean signal.
  const replOverride = req.seams?.runRepl
  try {
    await (replOverride ?? runRepl)()
    return { exitCode: 0 }
  } catch (e) {
    const err = e as Error & { code?: string }
    if (err.name === "AbortError" || err.code === "ABORT_ERR") return { exitCode: 130 }
    throw e
  }
}
