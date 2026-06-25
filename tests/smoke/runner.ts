import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import { defaultTools, ToolRegistry } from "@/tool"
import { CaptureStream } from "./capture-stream"
import { runAssertions } from "./expect"
import { runJudge } from "./judge"
import { buildLiveLLM, hasProviderKey } from "./provider"
import { RecordingLLM } from "./recorder"
import { TrajectoryReplayLLM } from "./replay-llm"
import type {
  AssertionFailure,
  Depth,
  ExpectSpec,
  ScenarioMeta,
  ScenarioResult,
  TrajectoryEntry,
} from "./types"

/** An `LLMPort` that also exposes a `nextRun()` cursor — implemented by both
 *  the tier-0 {@link TrajectoryReplayLLM} and the record-mode `RecordingLLM`.
 *  Lets {@link runConversation} drive either without branching. */
export interface SmokeLLM extends LLMPort {
  nextRun(): void
}

const FIXTURES_DIR = join(import.meta.dir, "fixtures")
const DEPTHS: readonly Depth[] = ["single", "medium", "tikitaka"]

/** Discover every scenario folder under `fixtures/<depth>/<NN-name>/`. */
export const discoverScenarios = (filter?: { depth?: Depth; id?: string }): ScenarioMeta[] => {
  const out: ScenarioMeta[] = []
  for (const depth of DEPTHS) {
    if (filter?.depth !== undefined && filter.depth !== depth) continue
    const depthDir = join(FIXTURES_DIR, depth)
    if (!existsSync(depthDir)) continue
    for (const name of readdirSync(depthDir).sort()) {
      const dir = join(depthDir, name)
      if (!existsSync(join(dir, "prompts.jsonl"))) continue
      if (filter?.id !== undefined && filter.id !== name) continue
      out.push({ id: name, depth, dir, tags: readTags(dir) })
    }
  }
  return out
}

const readTags = (dir: string): string[] => {
  const p = join(dir, "tags.json")
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** Parse `prompts.jsonl`. Each non-empty line MUST be either a JSON string or a
 *  `{ "text": string }` object — anything else (numbers, arrays, nested shapes,
 *  null) throws with the file path so a fixture author sees the typo at the
 *  scenario boundary instead of inheriting a silently-empty user message
 *  (Audit C §2 medium). */
const readPrompts = (dir: string): string[] => {
  const path = join(dir, "prompts.jsonl")
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l, i) => {
      const parsed: unknown = JSON.parse(l)
      if (typeof parsed === "string") return parsed
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "text" in parsed &&
        typeof (parsed as { text: unknown }).text === "string"
      ) {
        return (parsed as { text: string }).text
      }
      throw new Error(
        `prompts.jsonl: invalid prompt at ${path}:${i + 1} ` +
          `(expected a JSON string or {"text": string}, got ${typeof parsed})`,
      )
    })
}

const readTrajectory = (dir: string): TrajectoryEntry[] | undefined => {
  const p = join(dir, "trajectory.jsonl")
  if (!existsSync(p)) return undefined
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TrajectoryEntry)
}

const readExpect = (dir: string): ExpectSpec => {
  const p = join(dir, "expect.json")
  if (!existsSync(p)) return {}
  return JSON.parse(readFileSync(p, "utf8")) as ExpectSpec
}

interface ScenarioConfig {
  permission: PermissionContext["mode"]
  maxTurns: number
}

/** Closed set of permission modes accepted by `config.json`. Mirrors
 *  `PermissionMode` in `@/permission` — kept inline here so the smoke layer can
 *  validate without growing a fresh import. */
const VALID_PERMISSION_MODES = new Set<PermissionContext["mode"]>([
  "default",
  "acceptEdits",
  "bypass",
  "auto",
])

/** Optional per-scenario `config.json`. Defaults: `permission: "bypass"` (a
 *  hermetic tmp sandbox with a REPLAYED LLM cannot do anything we did not
 *  script, so we let every tool run — the `forbidden`-tools assertions are the
 *  real behavioural safety check), `maxTurns: 8`. Invalid `permission` values
 *  THROW (Audit C §2 medium — silent fallback to "ask" would hide the misconfig
 *  in scenarios where the gate is the actual subject under test). */
export const readConfig = (dir: string): ScenarioConfig => {
  const p = join(dir, "config.json")
  const base: ScenarioConfig = { permission: "bypass", maxTurns: 8 }
  if (!existsSync(p)) return base
  const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<ScenarioConfig>
  const permission = parsed.permission ?? base.permission
  if (!VALID_PERMISSION_MODES.has(permission)) {
    throw new Error(
      `config.json: invalid permission "${permission}" at ${p} ` +
        `(expected one of: ${[...VALID_PERMISSION_MODES].join(" | ")})`,
    )
  }
  const maxTurns = parsed.maxTurns ?? base.maxTurns
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error(`config.json: maxTurns must be a positive integer at ${p} (got ${maxTurns})`)
  }
  return { permission, maxTurns }
}

const userMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

/** Read + parse a scenario's prompts (exported for the recorder). */
export const loadPrompts = (dir: string): string[] => readPrompts(dir)

/** Materialize the seed into a fresh tmp workspace (+ a `.seed-snapshot` copy
 *  for linesAdded deltas). Returns the workspace path. Caller cleans up. */
export const materializeWorkspace = (meta: ScenarioMeta): string => {
  const work = mkdtempSync(join(tmpdir(), `quanta-smoke-${meta.id}-`))
  const seed = join(meta.dir, "seed")
  if (existsSync(seed)) {
    cpSync(seed, work, { recursive: true })
    cpSync(seed, join(work, ".seed-snapshot"), { recursive: true })
  }
  return work
}

/**
 * Drive a full conversation: feed each prompt in order, advance the LLM's run
 * cursor + capture run boundary, and carry the produced transcript forward so
 * later prompts see full context (tikitaka). Shared by tier-0 replay
 * ({@link runScenario}) and record mode (`smoke:record`).
 */
export const runConversation = async (args: {
  prompts: readonly string[]
  work: string
  llm: SmokeLLM
  capture: CaptureStream
  config?: ScenarioConfig
  /** Optional external cancellation — when the operator hits Ctrl-C at the
   *  battery level, the `index.ts` SIGINT handler aborts this signal so the
   *  in-flight `runAgent` cooperatively unwinds (Audit A R9 / C §3). */
  signal?: AbortSignal
}): Promise<{ lastReason: string; totalTurns: number }> => {
  const { prompts, work, llm, capture } = args
  const config = args.config ?? { permission: "bypass", maxTurns: 8 }
  const messages: Message[] = []
  let lastReason = "completed"
  let totalTurns = 0
  for (let i = 0; i < prompts.length; i++) {
    if (args.signal?.aborted) {
      lastReason = "aborted"
      break
    }
    messages.push(userMsg(prompts[i] as string))
    if (i > 0) llm.nextRun()
    capture.beginRun()
    const outcome = await runAgent(
      buildConfig({
        llm,
        capture,
        work,
        messages,
        config,
        ...(args.signal ? { signal: args.signal } : {}),
      }),
    )
    messages.length = 0
    messages.push(...outcome.messages)
    lastReason = outcome.reason
    totalTurns += outcome.turns
  }
  return { lastReason, totalTurns }
}

export type SmokeTier = "replay" | "live"

/** Pick the LLM for a scenario run. `replay` reads the recorded trajectory;
 *  `live` wraps the real provider (skipping politely when no key). Returns a
 *  `skip` reason instead of an LLM when the tier cannot run this scenario.
 *  Empty `trajectory.jsonl` (file exists but holds 0 entries) is also a polite
 *  skip — pre-fix it would crash with "exhausted at run=0 turn=0" (Audit C §2). */
const pickLlm = (meta: ScenarioMeta, tier: SmokeTier): { llm: SmokeLLM } | { skip: string } => {
  if (tier === "live") {
    if (!hasProviderKey()) return { skip: "no provider API key — live smoke skipped" }
    return { llm: new RecordingLLM(buildLiveLLM().llm) }
  }
  const trajectory = readTrajectory(meta.dir)
  if (trajectory === undefined) {
    return { skip: "no trajectory.jsonl — record with `bun run smoke:record` (tier-0 pending)" }
  }
  if (trajectory.length === 0) {
    return { skip: "trajectory.jsonl is empty — re-record before this scenario can replay" }
  }
  return { llm: new TrajectoryReplayLLM(trajectory, meta.id) }
}

/**
 * Run a single scenario. `tier: "replay"` (default) drives the recorded
 * trajectory hermetically; `tier: "live"` hits the real provider. Copies the
 * seed into a tmp workspace, runs the conversation, evaluates the sync
 * assertion spec, then (if a `judge` block applies) the async LLM-judge.
 */
export const runScenario = async (
  meta: ScenarioMeta,
  opts?: { tier?: SmokeTier; signal?: AbortSignal },
): Promise<ScenarioResult> => {
  const tier = opts?.tier ?? "replay"
  const started = Date.now()
  const picked = pickLlm(meta, tier)
  if ("skip" in picked) {
    return { meta, status: "skipped", skipReason: picked.skip, failures: [], durationMs: 0 }
  }

  const prompts = readPrompts(meta.dir)
  const spec = readExpect(meta.dir)
  const work = materializeWorkspace(meta)
  try {
    const capture = new CaptureStream()
    const { lastReason, totalTurns } = await runConversation({
      prompts,
      work,
      llm: picked.llm,
      capture,
      config: readConfig(meta.dir),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    })

    // FLAG 2: a replay must consume EVERY recorded `(run,turn)` bucket. If the
    // agent diverged to fewer turns than recorded, leftover buckets are unused
    // and the run would otherwise "pass" silently. Throw — symmetric to the
    // exhaustion (over-consumption) throw inside TrajectoryReplayLLM. Live tier
    // has no recorded trajectory to under-consume, so this only fires on replay.
    // NOTE: this asserts COUNT (all buckets reached), not content; verifying the
    // agent fed back the same inputs that produced each turn is a follow-up
    // (content fingerprinting — intentionally out of scope for this low-risk pass).
    if (picked.llm instanceof TrajectoryReplayLLM && !picked.llm.consumedAll()) {
      throw new Error(
        `smoke trajectory under-consumed for scenario "${meta.id}" ` +
          `(agent diverged to fewer turns than recorded — re-record or fix). ` +
          `Unused recorded buckets (run:turn): ${picked.llm.remaining().join(", ")}`,
      )
    }

    const failures = [
      ...runAssertions({ spec, capture, cwd: work, stopReason: lastReason, turns: totalTurns }),
    ]
    // Surface the agent-loop error message when the run terminated with
    // `reason==="error"` UNEXPECTEDLY (Audit A R8 / C low): the underlying
    // error event is captured but pre-fix only the bare stopReason mismatch
    // reached the ScenarioResult — diagnostics for stale trajectories were
    // nearly opaque. Skipped when the fixture explicitly asserts
    // `stopReason: "error"` — for refusal/recovery scenarios the error event
    // IS the expected terminal state.
    if (lastReason === "error" && spec.stopReason !== "error") {
      const errMessages = capture.errorMessages()
      if (errMessages.length > 0) {
        failures.push({
          path: "agent.error",
          expected: "no agent-loop error",
          actual: errMessages.join(" · "),
        })
      }
    }
    // wallSeconds budget is owned here (the runner holds the clock).
    const durationMs = Date.now() - started
    const wallMax = spec.budget?.wallSeconds?.max
    if (wallMax !== undefined && durationMs / 1000 > wallMax) {
      failures.push({
        path: "budget.wallSeconds.max",
        expected: `<= ${wallMax}s`,
        actual: `${(durationMs / 1000).toFixed(1)}s`,
      })
    }
    // LLM-as-judge: tier-0 with a cached score is gated synchronously in
    // `runAssertions`; here we run the LIVE judge when the tier is live (a
    // separate provider call). Tier-0 with a judge block but no cache is a soft
    // note (cannot judge without an LLM) — never a hard failure.
    await applyJudge({
      spec,
      tier,
      capture,
      failures,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    })

    return {
      meta,
      status: failures.length === 0 ? "passed" : "failed",
      failures,
      durationMs,
      stopReason: lastReason,
      turns: totalTurns,
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Run the LIVE LLM-judge for a scenario when applicable, pushing a failure
 *  when the score is below threshold. No-op for tier-0 (handled sync) or when
 *  no `judge` block is declared. Forwards the runner's AbortSignal so the
 *  wallSeconds budget — checked BEFORE applyJudge by design — can actually cut
 *  a wedged provider stream (Audit A R2 / C §4). */
const applyJudge = async (args: {
  spec: ExpectSpec
  tier: SmokeTier
  capture: CaptureStream
  failures: AssertionFailure[]
  signal?: AbortSignal
}): Promise<void> => {
  const judge = args.spec.judge
  if (judge === undefined || args.tier !== "live") return
  if (!hasProviderKey()) return
  const result = await runJudge({
    judge,
    text: args.capture.assistantText(),
    llm: buildLiveLLM().llm,
    ...(args.signal ? { signal: args.signal } : {}),
  })
  if (result.score < judge.threshold) {
    args.failures.push({
      path: "judge",
      expected: `score >= ${judge.threshold}`,
      actual: `live score=${result.score} — ${result.rationale}`,
    })
  }
}

const buildConfig = (args: {
  llm: LLMPort
  capture: CaptureStream
  work: string
  messages: Message[]
  config: ScenarioConfig
  /** Optional external cancellation — when omitted the loop gets a fresh
   *  controller (legacy behaviour). When provided, the battery-level SIGINT
   *  handler shares one controller across every scenario. */
  signal?: AbortSignal
}): AgentConfig => ({
  llm: args.llm,
  registry: new ToolRegistry(defaultTools),
  stream: args.capture,
  // Smoke runs are non-interactive in a hermetic tmp sandbox with a REPLAYED
  // LLM — `bypass` lets every scripted tool run (the `forbidden`-tools
  // assertions are the behavioural safety check). A scenario can override via
  // `config.json` (e.g. to exercise the gate itself).
  permission: { mode: args.config.permission } as PermissionContext,
  messages: [...args.messages],
  system: "You are a coding agent. Be concise.",
  cwd: args.work,
  maxTurns: args.config.maxTurns,
  signal: args.signal ?? new AbortController().signal,
})
