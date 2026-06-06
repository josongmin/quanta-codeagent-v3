/**
 * Mode-preset runner — HEADLESS.
 *
 * RFC may-22-unified-agent-runtime / Phase 4+. The `mode === "headless"` cell:
 * one-shot execution. A single prompt becomes a single trajectory; the final
 * assistant message is emitted on stdout (or JSON events when
 * `output:"json"`); exit code is derived from `outcome.reason`.
 *
 * Levers bound by the `headless` preset (see `agent/run-mode/presets.ts`):
 *   permission = auto/acceptEdits, termination = single-turn,
 *   sandbox = user-cwd, externalDeps = hermetic-with-overrides,
 *   toolSurface = headless-safe, observation = stream-only, memory = ephemeral.
 *
 * Required `AssembleRequest` extras: `req.headless.prompt` (non-empty string).
 *
 * Default-OFF byte-identical: the headless preset uses the same `buildSystemPrompt`
 * and `defaultTools` registry as a one-shot `quanta "..."` CLI call, so the
 * trajectory bytes match the legacy single-prompt path when invoked via Track A.
 *
 * Slice boundary: this file may import `@/agent`, `@/llm`, `@/permission`,
 * `@/shared`, `@/tool`, `@/stream`, and the sibling assemble.ts. NO imports
 * from other mode-preset siblings.
 */

import type { AgentConfig } from "@/agent"
import { buildSystemPrompt, wireOptionalAgentPorts } from "@/agent"
import type { Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import { logger } from "@/shared"
import { StdoutStream, type StreamPort } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import {
  type AssembleRequest,
  assembleAgentConfig,
  type RunOutcome,
  resolveRunAgent,
} from "../assemble"
import { exitCodeForOutcome } from "../run"
import { StreamJsonSink } from "./stream-json-sink"

/** P26 — does this run want a STRUCTURED stdout contract (json / stream-json)?
 *  `text` / absent ⇒ false ⇒ the legacy StdoutStream + final-text path runs
 *  byte-identically. Single predicate so the two call sites (`buildHeadlessBase`
 *  stream choice + `runMode` final-print skip) cannot drift apart. */
const wantsStructuredOutput = (req: AssembleRequest): boolean =>
  req.headless?.output === "json" || req.headless?.output === "stream-json"

/** Build the AgentConfig.base for headless. Reuses the caller's `req.base`
 *  fields where present, fills the rest with safe headless defaults. The single
 *  user message is constructed from `req.headless.prompt` — this is the ONLY
 *  message in the conversation seed for a one-shot run. */
const buildHeadlessBase = (
  req: AssembleRequest,
  prompt: string,
  structuredSink: StreamJsonSink | undefined,
): Omit<AgentConfig, "modePolicy" | "budgetMeter"> => {
  const cwd = req.base.cwd ?? process.cwd()
  // P26 — when a structured stdout contract is selected the agent loop must
  // emit INTO the StreamJsonSink (which encodes each AgentEvent → versioned
  // SessionEvent NDJSON / JSON-array on stdout). It WINS over `req.base.stream`
  // so the human renderer never co-mingles with the machine contract. Absent ⇒
  // the historical `req.base.stream ?? new StdoutStream()` (byte-identical text).
  const stream: StreamPort = structuredSink ?? req.base.stream ?? new StdoutStream()
  const permission: PermissionContext = req.base.permission ?? { mode: "acceptEdits" }
  // DIP factory call; headless has no preset-specific fs/diagnostics ports.
  const registry =
    req.base.registry instanceof ToolRegistry
      ? req.base.registry
      : new ToolRegistry(buildDefaultTools())
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }] }]
  return wireOptionalAgentPorts(
    {
      ...req.base,
      llm: req.base.llm,
      registry,
      stream,
      permission,
      messages,
      system: req.base.system ?? buildSystemPrompt(cwd),
      cwd,
      maxTurns: req.base.maxTurns ?? 20,
      // T01 (audit L5 H-2): inherit the composition-root's REAL signal. The
      // dead `?? new AbortController().signal` throwaway is removed — `req.base`
      // carries a live SIGINT-wired signal (required field), so Ctrl+C now
      // reaches the loop instead of being swallowed by a dropped controller.
      signal: req.base.signal,
    },
    process.env,
  )
}

/**
 * HEADLESS runner.
 *
 * Validates `req.headless.prompt` is non-empty (otherwise the run has no task
 * and the LLM would hallucinate one — fail-fast is safer than burning a turn
 * on empty input). Assembles the AgentConfig, runs the agent, prints the
 * final assistant text (or, in JSON mode, the run lives on `req.base.stream`
 * already and we skip the final print), and returns the exit-code outcome.
 *
 * Hermetic: when `req.seams.runAgent` is set, the real loop is bypassed —
 * the test stub returns a synthetic AgentOutcome and we map it to exitCode.
 */
export const runMode = async (req: AssembleRequest): Promise<RunOutcome> => {
  if (req.mode !== "headless") {
    throw new Error(`headless.runMode: req.mode must be "headless", got "${req.mode}"`)
  }
  const prompt = req.headless?.prompt
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("headless.runMode: req.headless.prompt is required (non-empty string)")
  }
  // P26 — construct the structured-output sink ONCE (json / stream-json) so it
  // is both the `cfg.stream` the loop emits into AND the object we finalize after
  // the run (json mode flushes its buffered array here). Absent for text /
  // default ⇒ undefined ⇒ byte-identical legacy path.
  const structuredSink = wantsStructuredOutput(req)
    ? new StreamJsonSink({
        format: req.headless?.output === "json" ? "json" : "stream-json",
        ...(req.headless?.includePartial === true ? { includePartial: true } : {}),
      })
    : undefined

  const base = buildHeadlessBase(req, prompt, structuredSink)
  const cfg = assembleAgentConfig({ ...req, base })

  const runner = resolveRunAgent(req.seams)
  const outcome = await runner(cfg)

  // P26 — flush the json-mode aggregate (single JSON array). No-op in
  // stream-json mode (every line already streamed) and when no sink is wired.
  structuredSink?.finalize()

  // Final-answer emission — a STRUCTURED run (json / stream-json) already
  // streamed/buffered the machine contract onto stdout via the sink, so the
  // human-readable final-text print is SKIPPED (it would corrupt the
  // jq-parseable stdout). Plain text mode prints the LAST assistant message
  // verbatim. When the outcome carries no assistant turn (e.g. immediate
  // error), nothing is printed — the exit code carries the signal.
  if (!wantsStructuredOutput(req)) {
    const lastAssistant = outcome.messages.findLast?.((m) => m.role === "assistant")
    if (lastAssistant) {
      const textParts = Array.isArray(lastAssistant.content)
        ? lastAssistant.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
        : []
      const final = textParts.join("").trim()
      if (final !== "") logger.info(final)
    }
  }

  // Canonical exit-code table lives in `../run` (audit R2: headless previously
  // mapped aborted→0 and max_turns→2, diverging from the shared table where
  // aborted→130 / max_turns→1).
  return { exitCode: exitCodeForOutcome(outcome), outcome }
}
