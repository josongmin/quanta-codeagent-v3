/**
 * D1 — the side-agent CHILD composition root that runs a REAL LLM-backed bounded
 * agent pass per charter (the LLM swap point named in `worker-entry.mjs`).
 *
 * This is the TS module the forked `.mjs` worker dynamically imports on a
 * `charter` (verified empirically: a bun-forked child resolves `@/…` aliases +
 * `.ts` when its `execPath` is bun). It assembles a MINIMAL but REAL runnable
 * `AgentConfig`, builds a real {@link createSubagentRunner}, adapts it with the
 * SAME `subagentRunnerToSidePass` the in-process backer uses, and runs ONE
 * bounded, READ-BIASED pass over the charter — mapping the runner's `finalText`
 * to the finding `summary`/`detail`.
 *
 * LLM source (precedence):
 *   1. `seams.llmPort` — explicit injection (used by the record/replay test to
 *      capture the exact StreamInput the loop emits, so replay hits).
 *   2. `env.QUANTA_SIDE_AGENT_LLM_REPLAY` — a `.jsonl` cassette path ⇒ the
 *      hermetic REPLAY adapter (no API keys). Uses a LENIENT `fuzzy-content`
 *      match so a recorded interaction hits despite system-prompt / tools drift,
 *      and `onMiss:"throw"` so a genuine cassette gap is loud (not a silent
 *      degrade to the stub).
 *   3. else — the REAL provider built from the inherited env via the project LLM
 *      factory (`pickProvider` + `createLLM`); prod uses the real credentials the
 *      child inherited (`{...process.env, ...spec.env}` from the fork port).
 *
 * NO-THROW: any failure (no LLM source, assembly error, replay miss, runner
 * error) ⇒ resolve `null` so the supervisor treats the wake as nothing-found
 * (and `worker-entry.mjs` can DEGRADE to the deterministic pass). The replay e2e
 * happy path succeeds because the cassette was recorded against this very path.
 *
 * Slice note: this lives UNDER `@/side-agent` but is NOT re-exported from the
 * pure-leaf barrel — it deliberately reaches into `@/agent`, `@/llm`, `@/tool`,
 * `@/stream`, `@/permission` (it is a composition root, like the host wiring),
 * so the leaf `@/side-agent` (consumed by `@/agent/side-agent-runner`) stays
 * dependency-clean. The worker imports THIS file directly by path.
 */

import type { AgentConfig } from "@/agent"
import { subagentRunnerToSidePass } from "@/agent/side-agent-runner"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { EnvLike, LLMPort, Message } from "@/llm"
import { createLLM, pickProvider } from "@/llm"
import { jsonlReplayStore, replayLlmPort } from "@/llm/replay"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"

/** The charter the supervisor hands the child (mirror of the IPC `charter`). */
export interface CharterInput {
  readonly task: string
  readonly maxTurnsPerWake: number
}

/** A finding the child surfaces (mirror of the IPC `finding`). */
export interface CharterFinding {
  readonly summary: string
  readonly detail?: string
}

/** Hermetic test seams. Absent ⇒ real env-driven LLM resolution. */
export interface CharterRunnerSeams {
  /** Inject the LLMPort directly (record/replay test). Wins over env. */
  readonly llmPort?: LLMPort
  /** Override the working directory (default: `process.cwd()`). */
  readonly cwd?: string
}

/** A discard `StreamPort` — a forked side-agent has no UI surface to render to;
 *  the only product is the finding pushed back over IPC. */
const discardStream: StreamPort = { emit: (_event: AgentEvent): void => undefined }

/**
 * Build the child's LLMPort per the precedence above, or `null` when no source
 * is available (⇒ the caller degrades). NO-THROW: a bad provider/env collapses
 * to `null` rather than throwing into the supervisor.
 */
const buildLlmPort = (env: EnvLike, seams: CharterRunnerSeams): LLMPort | null => {
  if (seams.llmPort !== undefined) return seams.llmPort

  const cassettePath = env.QUANTA_SIDE_AGENT_LLM_REPLAY
  if (cassettePath !== undefined && cassettePath.length > 0) {
    // Hermetic replay — lenient match so the recorded interaction hits despite
    // system-prompt / tool-schema drift between record and replay. A genuine
    // miss throws (loud), surfaced by the runner's catch as a non-ok result.
    return replayLlmPort({
      store: jsonlReplayStore({ path: cassettePath }),
      matchPolicy: "fuzzy-content",
      onMiss: "throw",
    })
  }

  // Production: build the real provider from the inherited env. The child got
  // `{...process.env, ...spec.env}` from the fork port, so credentials are
  // present when the parent had them. A missing key ⇒ MissingApiKeyError, which
  // we swallow to `null` (the child then degrades, never crashes the supervisor).
  try {
    const provider = pickProvider(env)
    return createLLM(provider, {}, env)
  } catch {
    return null
  }
}

/**
 * Assemble a MINIMAL but REAL read-biased `AgentConfig` the subagent runner can
 * drive. The registry is the full default tool set (built via the DIP-clean
 * `buildDefaultTools()` composition entry — ARCHITECTURE.md §3: composition roots
 * must call `buildDefaultTools(...)`, not import the eager `defaultTools`
 * singleton; called with no ports it is id-/behavior-identical to that
 * singleton); the read-bias is applied by
 * `subagentRunnerToSidePass`, which passes `SIDE_AGENT_READONLY_TOOLS` as the
 * spawn's `toolFilter` (intersected against this registry inside the runner). A
 * permissive `acceptEdits` permission is harmless here because the tool surface
 * is already narrowed to read-only by that filter.
 */
const assembleChildConfig = (llm: LLMPort, cwd: string): AgentConfig => {
  const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "side-agent" }] }]
  return {
    llm,
    registry: new ToolRegistry(buildDefaultTools()),
    stream: discardStream,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: seed,
    system: "You are a background side-agent. Investigate the charter and report findings.",
    cwd,
    maxTurns: 8,
    signal: new AbortController().signal,
    onConfirm: async () => false,
  }
}

/**
 * Run ONE real bounded LLM-backed pass for `charter`. Returns the model-derived
 * finding, or `null` when nothing could run / nothing was found. NO-THROW.
 */
export const runCharterPassLLM = async (
  charter: CharterInput,
  env: EnvLike,
  seams: CharterRunnerSeams = {},
): Promise<CharterFinding | null> => {
  try {
    const task = typeof charter?.task === "string" ? charter.task.trim() : ""
    if (task.length === 0) return null
    const maxTurns =
      typeof charter?.maxTurnsPerWake === "number" && charter.maxTurnsPerWake > 0
        ? charter.maxTurnsPerWake
        : 1

    const llm = buildLlmPort(env, seams)
    if (llm === null) return null

    const cwd = seams.cwd ?? process.cwd()
    const cfg = assembleChildConfig(llm, cwd)
    const runner = createSubagentRunner(cfg)
    // Reuse the in-process backer's mapping (finalText → finding) verbatim.
    const pass = subagentRunnerToSidePass(runner)
    const finding = await pass.run({
      task,
      wake: 1,
      maxTurns,
      signal: new AbortController().signal,
    })
    return finding
  } catch {
    // NO-THROW into the supervisor — a failed pass is a wake that found nothing.
    return null
  }
}
