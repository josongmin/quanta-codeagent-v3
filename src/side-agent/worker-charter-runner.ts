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
 * Distinguishes a genuine miss (`no_finding`) from import/provider/pass
 * failure (`failed`) so the worker never synthesizes a finding.
 *
 * Slice note: this lives UNDER `@/side-agent` but is NOT re-exported from the
 * pure-leaf barrel — it deliberately reaches into `@/agent`, `@/llm`, `@/tool`,
 * `@/stream`, `@/permission` (it is a composition root, like the host wiring),
 * so the leaf `@/side-agent` (consumed by `@/agent/side-agent-runner`) stays
 * dependency-clean. The worker imports THIS file directly by path.
 */

import type { AgentConfig } from "@/agent"
import { subagentRunnerToSidePass } from "@/agent/side-agent-runner"
import { childDepthOf } from "@/agent/spawn-depth"
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

/** Typed charter outcome — null miss vs import/provider/throw stay distinct. */
export type CharterPassResult =
  | { readonly outcome: "finding"; readonly finding: CharterFinding }
  | { readonly outcome: "no_finding" }
  | { readonly outcome: "failed"; readonly reason: string }

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
 * Env key by which the SPAWNING agent's real depth is threaded across the OS
 * process boundary onto the forked worker (via `{...process.env, ...spec.env}`
 * from the fork port). Absent ⇒ the fork boundary did not carry lineage, so the
 * worker falls back to the fail-closed floor below (treated as depth 0 = a
 * top-level descendant, never granted a widened budget).
 */
export const WORKER_PARENT_DEPTH_ENV = "QUANTA_SIDE_AGENT_PARENT_DEPTH" as const

/**
 * DEFENSE-IN-DEPTH depth containment for a process-backed side-agent worker.
 *
 * RUNNER SEMANTICS (the subtlety that dictates this design): the config
 * `assembleChildConfig` builds is the PARENT handed to `createSubagentRunner`;
 * `subagentRunnerToSidePass` invokes that runner ONCE to spawn the actual
 * investigating pass, which runs at `childDepthOf(parent) = parent.depth + 1`.
 * The runner's reject fires when `childDepthOf(parent) > effectiveCap`. So under
 * the default operator policy cap (`maxDescendantDepth = 1`) the daemon config
 * MUST be depth 0 for its single investigating pass (depth 1) to run at all —
 * pinning the daemon itself to depth 1 would make the pass depth 2 > cap and
 * DENY the legitimate investigation.
 *
 * The real hole a prior review flagged is not this one pass (which is a depth-1
 * LEAF, spawn tools already projected away under the default cap). It is that a
 * depth-BLIND daemon is treated as a genuine ROOT: if the operator cap were
 * WIDENED (`QUANTA_MAX_DESCENDANT_DEPTH > 1`), a background daemon would inherit
 * the FULL root spawning budget and its investigating pass could recurse
 * descendants — contained ONLY by the `subagentRunnerToSidePass` read-only tool
 * filter (single-layer). A daemon is a DESCENDANT, not the user's root session,
 * and must not get the root's budget.
 *
 * FIX (fail-closed, non-breaking): pin a TIGHTENING-ONLY per-config
 * `subagent.maxDepth = childDepthOf(daemon)` so the effective ceiling
 * (`min(operator policy, this)`) admits EXACTLY the one investigating pass and
 * NO deeper, regardless of a widened operator policy. The investigating pass runs
 * at `depth >= 1`; its OWN `childDepthOf` exceeds the pinned cap, so any
 * descendant it tried to mint is admission-denied at the capability layer —
 * defense-in-depth ON TOP of (not replacing) the read-only filter. The daemon
 * parent depth reflects the threaded spawning-agent lineage when present (so a
 * deeper spawner gets a proportionally deeper — never shallower — budget), else
 * the fail-closed {@link MIN_DAEMON_DEPTH} floor.
 */
export const MIN_DAEMON_DEPTH = 0 as const

/**
 * Resolve the DAEMON PARENT config depth from the threaded spawning-agent depth
 * (`WORKER_PARENT_DEPTH_ENV`), else the fail-closed {@link MIN_DAEMON_DEPTH}
 * floor. A malformed / forged / absent value floors to 0 (a top-level
 * descendant) — it can only DEEPEN the lineage (max with the floor), never grant
 * a shallower/wider budget. This is the daemon's OWN depth; its single
 * investigating pass runs one level deeper (`childDepthOf`). */
export const resolveDaemonDepth = (env: EnvLike): number => {
  const raw = env[WORKER_PARENT_DEPTH_ENV]
  const parent = raw !== undefined && raw.length > 0 ? Number.parseInt(raw, 10) : Number.NaN
  const derived = Number.isInteger(parent) && parent >= 0 ? parent : MIN_DAEMON_DEPTH
  return Math.max(derived, MIN_DAEMON_DEPTH)
}

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
 *
 * DEPTH CONTAINMENT (defense-in-depth): `daemonDepth` is the daemon PARENT's
 * lineage depth (see {@link resolveDaemonDepth}); the config carries it as
 * `depth` AND pins a TIGHTENING-ONLY `subagent.maxDepth = childDepthOf(daemon)`.
 * The single investigating pass runs at `childDepthOf(daemon) (>= 1)` and is
 * admitted (childDepth == cap); its OWN children exceed that pinned cap, so a
 * background daemon can never recurse descendants even if the operator policy is
 * widened — the read-only tool filter is no longer the sole containment.
 */
export const assembleChildConfig = (
  llm: LLMPort,
  cwd: string,
  daemonDepth: number,
): AgentConfig => {
  const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "side-agent" }] }]
  // The tightening cap = the depth of the ONE investigating pass this daemon
  // spawns (`childDepthOf(daemon)`). `effectiveCap = min(operator policy, this)`
  // then admits exactly that pass and denies anything deeper (fail-closed under a
  // widened policy). `childDepthOf` on a well-formed non-negative int never throws.
  const passDepth = childDepthOf({ depth: daemonDepth })
  // SECURITY BOUNDARY (honest, documented): this OS-PROCESS daemon is a fresh
  // ROOT config — the spawning parent's `ownershipPolicy` (QUANTA_FS_OWNERSHIP_
  // ENFORCE) is NOT carried across the process fork (only `depth` crosses, via
  // WORKER_PARENT_DEPTH_ENV). So a fenced parent spawning an OS-process side-agent
  // gets an UNFENCED daemon. Bounded by: both gates default-OFF (QUANTA_SIDE_AGENT
  // + QUANTA_SIDE_AGENT_PROCESS) AND the read-biased SIDE_AGENT_READONLY_TOOLS
  // default filter. Full parity would require serializing owned/forbidden across
  // the fork (like depth) — deferred (disproportionate for a default-OFF² path);
  // the in-process spawn boundary (the audited HIGH) IS composed via
  // narrowChildOwnership. Distinct from the in-process fence — do not conflate.
  return {
    llm,
    registry: new ToolRegistry(buildDefaultTools()),
    stream: discardStream,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: seed,
    system: "You are a background side-agent. Investigate the charter and report findings.",
    cwd,
    // Daemon lineage depth (0 = top-level descendant). Load-bearing: it is the
    // parent depth the runner derives the investigating pass's depth from.
    depth: daemonDepth,
    // Tightening-only recursion cap — pins the effective ceiling to the single
    // investigating-pass depth so a widened operator policy cannot hand a
    // background daemon a deeper spawning budget than its one pass.
    subagent: { maxDepth: passDepth },
    maxTurns: 8,
    signal: new AbortController().signal,
    onConfirm: async () => false,
  }
}

/**
 * Run ONE real bounded LLM-backed pass for `charter`. Distinguishes a genuine
 * miss (`no_finding`) from import/provider/pass failure (`failed`).
 */
export const runCharterPassLLM = async (
  charter: CharterInput,
  env: EnvLike,
  seams: CharterRunnerSeams = {},
): Promise<CharterPassResult> => {
  try {
    const task = typeof charter?.task === "string" ? charter.task.trim() : ""
    if (task.length === 0) return { outcome: "no_finding" }
    const maxTurns =
      typeof charter?.maxTurnsPerWake === "number" && charter.maxTurnsPerWake > 0
        ? charter.maxTurnsPerWake
        : 1

    const llm = buildLlmPort(env, seams)
    if (llm === null) return { outcome: "failed", reason: "llm provider unavailable" }

    const cwd = seams.cwd ?? process.cwd()
    const cfg = assembleChildConfig(llm, cwd, resolveDaemonDepth(env))
    const runner = createSubagentRunner(cfg)
    const pass = subagentRunnerToSidePass(runner)
    const finding = await pass.run({
      task,
      wake: 1,
      maxTurns,
      signal: new AbortController().signal,
    })
    if (finding === null) return { outcome: "no_finding" }
    if ("summary" in finding) return { outcome: "finding", finding }
    const first = finding[0]
    if (first === undefined) return { outcome: "no_finding" }
    return { outcome: "finding", finding: first }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "charter pass threw"
    return { outcome: "failed", reason }
  }
}
