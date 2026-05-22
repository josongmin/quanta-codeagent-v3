import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSystemPrompt } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { StructuredLogger } from "@/observability"
import type { PermissionContext, ToolAction } from "@/permission"
import {
  argvPrompt,
  assembleConfig,
  buildStreaming,
  buildSummarizerLlm,
  buildTooling,
  loadFeatures,
  pickPersona,
  pickProvider,
  type SessionDeps,
} from "../../src/apps/cli/internal"

/**
 * IN-PROCESS end-to-end integration of the CLI export-closure assembly path
 * (feature `cli-export-2026-05-21-l2-l3`, L3→L4 promotion).
 *
 * GAP this closes: the helpers in `src/apps/cli/internal.ts` are consumed by
 * `src/apps/cli/repl.ts#runRepl` to assemble the real `AgentConfig`, but the
 * existing unit tests are narrow (env-contract / argv / retry only). There was
 * NO test exercising the full `loadFeatures → buildTooling → buildSystemPrompt
 * → assembleConfig` closure that `runRepl` walks.
 *
 * APPROACH — in-process, NOT subprocess. A hermetic subprocess `bun
 * src/apps/cli/index.ts <prompt>` cannot run a real turn without a provider API
 * key: `runRepl` builds the LLM via `buildLLM` (real `@/llm` factory) and then
 * immediately invokes the model on the one-shot prompt — there is no
 * replay/fake-provider env knob on the CLI binary path (the tier-0 replay LLM
 * lives only in `tests/smoke`, wired into `runAgent` directly, not the CLI).
 * The existing `session-cli-subprocess.test.ts` only ever spawns paths that
 * SHORT-CIRCUIT before the LLM (`--help`, conflict/missing-id, `session …`).
 *
 * So this suite imports the REAL helpers and drives the exact assembly
 * sequence `runRepl` performs (verbatim ordering), substituting a stub
 * `LLMPort` at the one seam that needs a key (the final composed LLM). Every
 * other helper — provider/persona resolution, feature loading, tool registry
 * build, store/embedder gating, system-prompt build, the conditional-spread
 * `assembleConfig` — runs for real. This exercises the export closure
 * end-to-end with zero network and no API key.
 *
 * No production code is modified by this suite.
 */

/** Minimal deterministic `LLMPort` — substitutes for `buildLLM(...)`'s output
 *  at the `finalLLM` seam so the assembly path needs no provider key. It is
 *  never streamed in these tests (we assert on the assembled config, not on a
 *  turn), but `stream` is implemented so the double is a faithful `LLMPort`. */
class StubLLM implements LLMPort {
  readonly model = "stub-model"
  // biome-ignore lint/correctness/useYield: never invoked; satisfies the port shape.
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("StubLLM.stream must not be called by the assembly path")
  }
}

const REAL_ENV = { ...process.env }

/** Reset env to a clean, key-free, anthropic-pinned baseline before each test
 *  so a dev machine's live OPENAI/ANTHROPIC keys + any QUANTA_* knobs can't
 *  perturb the default-OFF assertions. Each test sets only the knobs it needs. */
const resetEnv = (): void => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("QUANTA_")) delete process.env[k]
  }
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_BASE_URL
  process.env.QUANTA_PROVIDER = "anthropic"
}

let workspace: string
const realArgv = process.argv

beforeEach(() => {
  resetEnv()
  workspace = mkdtempSync(join(tmpdir(), "cli-export-asm-"))
  // Hermetic argv: a single positional one-shot prompt, no flags.
  process.argv = ["bun", "src/apps/cli/index.ts", "echo", "hi"]
})

afterEach(() => {
  process.argv = realArgv
  // Restore the real env wholesale (tests mutate process.env in place).
  for (const k of Object.keys(process.env)) {
    if (!(k in REAL_ENV)) delete process.env[k]
  }
  Object.assign(process.env, REAL_ENV)
  rmSync(workspace, { recursive: true, force: true })
})

/**
 * Drive the REAL export-closure assembly exactly as `runRepl` does, returning
 * the assembled `AgentConfig` plus the log lines emitted along the way. The
 * only substitution is the `finalLLM` seam (a {@link StubLLM} instead of
 * `buildLLM(provider, model)`), so no provider key is required. `pickProvider`,
 * `pickPersona`, `loadFeatures`, `buildTooling`, `buildStreaming`,
 * `buildSummarizerLlm`, `buildSystemPrompt` and `assembleConfig` all run for
 * real against the live `process.env`/`process.argv` the test set up.
 */
const assemble = async (cwd: string) => {
  const logs: string[] = []
  const slog = new StructuredLogger({ sink: (line) => logs.push(line) })

  const provider = pickProvider()
  const persona = pickPersona()
  const llm: LLMPort = new StubLLM()

  const features = await loadFeatures(slog)
  const tooling = buildTooling(
    features.mcpTools,
    features.lspTools,
    features.lspNavTools,
    features.gitToolList,
    slog,
  )
  // Observability default-OFF (no --observe-dir): plain StdoutStream, no run ctx.
  const { stream, run } = buildStreaming(undefined, slog)
  const permission: PermissionContext = { mode: "default" }
  const abort = new AbortController()
  const system = buildSystemPrompt(cwd, { persona })
  const onConfirm = async (_a: ToolAction): Promise<boolean> => false

  const deps: SessionDeps = {
    llm,
    registry: tooling.registry,
    stream,
    permission,
    system,
    cwd,
    maxTurns: 40,
    signal: abort.signal,
    onConfirm,
    store: tooling.store,
    sessionId: tooling.sessionId,
    embedder: tooling.embedder,
    memoryConfig: tooling.memoryConfig,
    planMode: features.planMode,
    metrics: features.metrics,
    run,
    subagentConfig: tooling.subagentConfig,
    skillsConfig: tooling.skillsConfig,
    compactionBreakerConfig: tooling.compactionBreakerConfig,
    verifyGuardConfig: tooling.verifyGuardConfig,
    summarizerLlm: buildSummarizerLlm(provider, abort.signal),
    onShellEvent: undefined,
    workMetricsSink: undefined,
  }
  const config = assembleConfig(
    [{ role: "user", content: [{ type: "text", text: argvPrompt() }] }],
    deps,
  )
  return { config, logs, provider, tooling }
}

describe("CLI export-closure assembly (in-process e2e)", () => {
  // ── Test A — default-OFF assembly is well-formed ─────────────────────────
  test("A: assembles a well-formed AgentConfig with all core ports present", async () => {
    const { config, provider } = await assemble(workspace)

    // Provider resolution honored the pinned env.
    expect(provider).toBe("anthropic")

    // Every core port the loop requires is present and of the right shape.
    expect(config.llm).toBeDefined()
    expect(typeof config.llm.stream).toBe("function")
    expect(config.registry).toBeDefined()
    expect(config.stream).toBeDefined()
    expect(config.permission).toEqual({ mode: "default" })
    expect(config.cwd).toBe(workspace)
    expect(config.maxTurns).toBe(40)
    expect(config.signal).toBeInstanceOf(AbortSignal)
    expect(typeof config.onConfirm).toBe("function")

    // System prompt is the real prompt (non-empty, identifies the agent).
    expect(config.system.length).toBeGreaterThan(100)
    expect(config.system).toContain("Quanta")

    // The seed message is the positional argv prompt ("echo hi"), proving
    // `argvPrompt` ran over the test's argv inside the closure.
    expect(config.messages).toHaveLength(1)
    expect(config.messages[0]?.role).toBe("user")
    expect(config.messages[0]?.content).toEqual([{ type: "text", text: "echo hi" }])

    // Default tool registry is non-empty (defaultTools merged in by buildTooling).
    const specs = config.registry.specs()
    expect(specs.length).toBeGreaterThan(0)

    // Default-OFF invariants: none of the gated blocks are present, so the
    // assembled config is byte-identical to the no-knob default the loop expects.
    expect(config.store).toBeUndefined()
    expect(config.embedder).toBeUndefined()
    expect(config.memory).toBeUndefined()
    expect(config.subagent).toBeUndefined()
    expect(config.skills).toBeUndefined()
    expect(config.compactionBreaker).toBeUndefined()
    expect(config.verifyGuard).toBeUndefined()
    expect(config.planMode).toBeUndefined()
    expect(config.metrics).toBeUndefined()
    expect(config.compaction).toBeUndefined()
    expect(config.sessionId).toBeUndefined()
  })

  // ── Test B — helper resolution is logged + memory/store-gated branch fires ─
  test("B: store + subagent + skills knobs flow through buildTooling into the config and are logged", async () => {
    // Flip the memory store on (volatile InMemoryStore — no disk/key needed)
    // plus two opt-in capability knobs, then assert (1) the slog lines that
    // buildTooling emits per internal.ts and (2) the resulting config wiring.
    process.env.QUANTA_MEMORY = "memory"
    process.env.QUANTA_SUBAGENT = "1"
    process.env.QUANTA_SUBAGENT_MAX_DEPTH = "2"
    process.env.QUANTA_SKILLS = "1"

    const { config, logs, tooling } = await assemble(workspace)

    // (1) buildTooling logged the enabled capabilities (slog lines).
    const events = logs.map((l) => JSON.parse(l).event as string)
    expect(events).toContain("subagent.on")
    expect(events).toContain("skills.on")

    // (2) store-gated branch fired: the InMemoryStore is wired AND assembleConfig
    //     spread the store + sessionId + the default `compaction: {}` block.
    expect(tooling.store).toBeDefined()
    expect(config.store).toBe(tooling.store)
    expect(config.sessionId).toBe(tooling.sessionId)
    expect(config.compaction).toEqual({})

    // (3) the opt-in capability blocks landed on the config with their parsed knobs.
    expect(config.subagent).toEqual({ maxDepth: 2 })
    expect(config.skills).toEqual({})
  })

  // ── Test C — provider env switch flows through the closure ───────────────
  test("C: QUANTA_PROVIDER=openai is honored by pickProvider through the assembly", async () => {
    process.env.QUANTA_PROVIDER = "openai"
    const { provider, config } = await assemble(workspace)
    expect(provider).toBe("openai")
    // The system prompt + registry are provider-agnostic but must still build.
    expect(config.system).toContain("Quanta")
    expect(config.registry.specs().length).toBeGreaterThan(0)
  })
})
