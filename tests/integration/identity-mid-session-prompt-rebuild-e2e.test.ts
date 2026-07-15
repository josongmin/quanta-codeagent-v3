/**
 * HELLGATE — `identity-mid-session-prompt-rebuild` TRUE 2-turn e2e.
 *
 * WHAT WAS UNTESTED (verified): no live-loop e2e proved that a mid-session
 * `/identity` swap changes what the NEXT turn's LLM sees as `StreamInput.system`.
 * The only existing coverage was unit source-string SSOT pins
 * (`slash-state-ssot-hellgate`, `mode-cycle-permission-authority-hellgate`) —
 * they grep for the wire text but NEVER run the fresh-per-turn read through a
 * real loop with a real `refreshSystemPrompt`.
 *
 * THE REAL SEAM this drives (NOT a reconstruction — the ONE production cell):
 *
 *   bootstrapSession(deps, runtime)                       [src/host/bootstrap/bootstrap-session.ts]
 *     └─ buildSessionStatePorts (PRIVATE) mints the REAL:
 *          • identityModeState  (createIdentityModeSessionState)
 *          • systemSource       (createSystemSource, seeded from mode "default")
 *          • refreshSystemPrompt = () => systemSource.set(buildPromptFromIdentityMode())
 *                                  ^ fresh-reads the LIVE identityModeState each call
 *   buildBaseFromBootstrap(boot)                          [context-binding/base.ts]
 *     └─ lifts boot.systemSource + boot.identityModeState onto the RuntimeBase
 *   runRuntimeTurn({ base, ... })  (ONCE PER REPL TURN)   [context-binding/turn-runner.ts]
 *     └─ buildAgentConfigFromBase → `system: systemSource?.get() ?? system`  (FRESH read)
 *       └─ runAgent(config)  → FakeLLM captures StreamInput.system for that turn
 *
 * The mid-session swap is driven through the REAL `/identity set <mode>` command
 * handler — `buildIdentityModeAdapter` wired EXACTLY as the REPL composes it
 * (`setActive: identityModeState.set`, `onChange: refreshSystemPrompt`, mirroring
 * `slash-surface.ts#maybeIdentity` + `surface-compose.ts:802`). So `adapter.set("audit")`
 * fires the genuine chain: im.set → onChange() → refreshSystemPrompt() → systemSource.set(...).
 *
 * NON-VACUOUS (paired within ONE run): turn 1's captured system carries the OLD
 * ("default") identity text; turn 2's — after the swap — carries the NEW ("audit")
 * identity text AND drops the old. The two identity bodies share no substring
 * (locked by identity-hellgate: every line appears in exactly one mode).
 *
 * RED-ON-INJECTION: the final case neuters `refreshSystemPrompt` (replaces it with
 * a no-op AND stops mutating identityModeState mid-turn) ⇒ turn 2 keeps the OLD
 * prefix ⇒ the "carries the NEW mode" assertion goes RED. This proves the test
 * fails when the wire is cut, not vacuously.
 */

import { describe, expect, test } from "bun:test"
import type { IdentityMode } from "@/agent/identity"
import { buildSystemPromptForMode, defaultModeVariantRegistry } from "@/agent/system-prompt"
import {
  bootstrapSession,
  type SessionBootstrapDeps,
  type SessionRuntimeConfigShape,
} from "@/host/bootstrap"
import { buildIdentityModeAdapter } from "@/apps/cli/repl/ctx-adapters/identity-mode-adapter"
import { buildBaseFromBootstrap } from "@/host/runtime/internal/context-binding/base"
import { runRuntimeTurn } from "@/host/runtime/internal/context-binding/turn-runner"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { ResolveResumeInput } from "@/runner/orchestrate"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"

// ── a FakeLLM that CAPTURES `StreamInput.system` per turn ────────────────────
// One "ok" end_turn per call ⇒ each turn completes immediately (no tool calls,
// so an empty transcript grows only by user+assistant text). Records the system
// envelope so the test can assert the per-turn fresh read.
class CapturingLLM implements LLMPort {
  readonly model = "identity-e2e-capture"
  readonly seenSystem: (StreamInput["system"] | undefined)[] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seenSystem.push(input.system)
    yield { type: "text_delta", delta: "ok" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

// The per-turn system reaches the wire as either a raw string or a cached
// system block; normalize to a comparable string for the substring assertions.
const systemText = (s: StreamInput["system"] | undefined): string => {
  if (s === undefined) return ""
  if (typeof s === "string") return s
  // Cached/blocked system envelope (array of { type:"text", text }).
  if (Array.isArray(s)) {
    return s.map((b) => (b !== null && typeof b === "object" && "text" in b ? String(b.text) : "")).join("\n")
  }
  return JSON.stringify(s)
}

// Distinctive, mode-unique identity substrings (each appears in EXACTLY one mode
// per the identity-hellgate cross-mode-leak lock — so a substring hit is a real
// mode fingerprint, never a shared phrase).
const DEFAULT_FINGERPRINT = "pragmatic coding partner"
const AUDIT_FINGERPRINT = "audit mode"

// ── light fake bootstrap deps (mirrors bootstrap-host-extraction fixture, but
//    with a REAL ToolRegistry + the capturing LLM so runAgent runs a real turn) ─
const makeFakeDeps = (
  llm: LLMPort,
  overrides: Partial<SessionBootstrapDeps> = {},
): SessionBootstrapDeps => {
  const base: SessionBootstrapDeps = {
    buildLifecycleBundle: () => ({
      pills: { update: () => undefined },
      taskRegistry: undefined,
      followUpQueue: undefined,
      activityStore: undefined as never,
    }),
    deriveMcpPillServers: () => [],
    buildCostPanelOrUndefined: () => undefined,
    buildBranchProgressOrUndefined: () => undefined,
    buildPlanStoreOrUndefined: () => undefined,
    buildWorkMetricsSink: () => undefined,
    buildLlm: () => llm,
    buildAutoTitlePort: () => undefined,
    buildStreaming: () => ({ stream: { emit: () => undefined }, run: undefined }),
    // REAL registry — the fake extraction fixture returns `{ tools: () => [] }`,
    // which is NOT a ToolRegistry and would crash runAgent's dispatch reads.
    buildTooling: () =>
      ({
        store: undefined,
        embedder: undefined,
        sessionId: "identity-e2e-session",
        registry: new ToolRegistry(defaultTools),
        memoryConfig: undefined,
        subagentConfig: undefined,
        skillsConfig: undefined,
        compactionBreakerConfig: undefined,
        verifyGuardConfig: undefined,
      }) as never,
    loadFeatures: async () => ({
      planMode: false,
      metrics: undefined,
      state: undefined,
      resume: undefined,
      mcpTools: [],
      mcpClients: [],
      mcpConfigs: [],
      lspTools: [],
      lspNavTools: [],
      gitToolList: [],
      astGrepTools: [],
    }),
    loadImageBlock: () => ({ kind: "image", data: "", mimeType: "image/png" }) as never,
    pickIdentity: () => undefined,
    pickPersona: () => "default" as never,
    resolveResume: async (_input: ResolveResumeInput) => ({
      sessionId: "resolved-session",
      history: [],
      idMeta: undefined,
      inIdMode: false,
      conflictError: undefined,
      missingIdError: undefined,
    }),
    composeShellEvent: () => undefined,
    switchToSessionCwd: (cwd) => cwd,
    materializeReviewerAgent: () => undefined,
    createSubagentBackedGuardianReview: () => (async () => ({})) as never,
    createSubagentBackedGuardianAssess: () => (async () => ({})) as never,
    buildMcpSurfaceInfo: () => undefined,
    buildIdleGuards: () => ({
      idleMonitor: { markActive: () => undefined } as never,
      rejectCounter: { recordAccept: () => undefined } as never,
    }),
  }
  return { ...base, ...overrides }
}

const makeRuntime = (
  env: Record<string, string | undefined>,
): SessionRuntimeConfigShape => ({
  provider: "openai" as never,
  model: "test-model",
  mode: "default" as never,
  maxTurns: 5,
  cwd: "/tmp/test",
  // QUANTA_IDENTITY gate ON ⇒ the initial systemSource + refreshSystemPrompt both
  // route through buildPromptFromIdentityMode (the mode-driven prompt path). The
  // bootstrap reads THIS injected env, not process.env, for the identity gate.
  env,
  homeDir: "/tmp",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  newSession: false,
  title: undefined,
  idleMs: 60_000,
  snoozeDefaultMs: 300_000,
  rejectLimit: 20,
  idleSuppressOn: false,
  observeDir: undefined,
  pendingImagePaths: [],
  mcpConfigPath: undefined,
  argPrompt: undefined,
  spinnerIntervalMs: "80",
})

const IDENTITY_ENV = { QUANTA_IDENTITY: "1", QUANTA_IDENTITY_MODE: "default" }

// One REPL turn through the REAL per-turn seam: buildAgentConfigFromBase does the
// FRESH `systemSource.get()` read, then runAgent. Returns the new full transcript
// so the caller can chain it as turn 2's history (SAME `base`, mutated between).
const runOneTurn = async (
  base: Parameters<typeof runRuntimeTurn>[0]["base"],
  history: readonly Message[],
  prompt: string,
): Promise<Message[]> => {
  const result = await runRuntimeTurn({
    base,
    history,
    prompt,
    state: undefined,
    idMeta: undefined,
  })
  expect(result.outcome.reason).toBe("completed")
  return result.outcome.messages
}

describe("identity mid-session prompt rebuild — real 2-turn e2e", () => {
  test("turn 2 (after /identity set audit) system carries the NEW mode; turn 1 had the old", async () => {
    __resetRuntimeConfig()
    const llm = new CapturingLLM()
    // REAL bootstrap ⇒ REAL identityModeState + systemSource + refreshSystemPrompt.
    const boot = await bootstrapSession(makeFakeDeps(llm), makeRuntime(IDENTITY_ENV), {})

    // Sanity: the bootstrap seeded the system from mode "default".
    expect(boot.system).toContain(DEFAULT_FINGERPRINT)
    expect(boot.system).not.toContain(AUDIT_FINGERPRINT)

    // REAL base builder lifts boot.systemSource + identityModeState onto the base.
    const base = buildBaseFromBootstrap({
      boot,
      stream: { emit: () => undefined },
      onConfirm: async () => false,
    })

    // ── TURN 1 (old identity: "default") ──────────────────────────────────────
    const afterT1 = await runOneTurn(base, [], "first user message")

    // ── mid-session /identity set audit — driven through the REAL slash handler.
    //    Wire the adapter EXACTLY as the REPL does: authoritative session cell as
    //    setActive, refreshSystemPrompt as onChange. adapter.set fires the genuine
    //    im.set → onChange() → refreshSystemPrompt() → systemSource.set(...) chain.
    const adapter = buildIdentityModeAdapter({
      registry: boot.identityModeState.registry,
      getActive: () => boot.identityModeState.get(),
      setActive: (mode) => boot.identityModeState.set(mode),
      onChange: boot.refreshSystemPrompt,
    })
    const setResult = adapter.set("audit")
    expect(setResult).toBe("ok")
    // The authoritative cell flipped AND the shared systemSource was rebuilt.
    expect(boot.identityModeState.get()).toBe("audit")
    expect(boot.systemSource.get()).toContain(AUDIT_FINGERPRINT)

    // ── TURN 2 (new identity: "audit") — SAME base, fresh per-turn system read ─
    await runOneTurn(base, afterT1, "second user message")

    // Two turns captured.
    expect(llm.seenSystem.length).toBe(2)
    const t1 = systemText(llm.seenSystem[0])
    const t2 = systemText(llm.seenSystem[1])

    // PAIRED, non-vacuous: turn 1 = OLD mode, turn 2 = NEW mode, each EXCLUSIVE.
    expect(t1).toContain(DEFAULT_FINGERPRINT)
    expect(t1).not.toContain(AUDIT_FINGERPRINT)

    expect(t2).toContain(AUDIT_FINGERPRINT)
    expect(t2).not.toContain(DEFAULT_FINGERPRINT)

    // The two turns genuinely differ (guards against both capturing the same cell).
    expect(t1).not.toBe(t2)
    __resetRuntimeConfig()
  })

  test("RED-ON-INJECTION: neuter refreshSystemPrompt ⇒ turn 2 KEEPS the old prefix", async () => {
    // This is the falsifier. If `refreshSystemPrompt` is a no-op and the identity
    // cell is NOT flipped, the shared systemSource never rebuilds ⇒ turn 2's fresh
    // read still yields the OLD ("default") prompt. We assert the BROKEN behavior
    // here so the mechanism is proven load-bearing: were the production wire cut,
    // the primary test's `t2.toContain(AUDIT_FINGERPRINT)` would fail exactly like this.
    __resetRuntimeConfig()
    const llm = new CapturingLLM()
    const boot = await bootstrapSession(makeFakeDeps(llm), makeRuntime(IDENTITY_ENV), {})
    const base = buildBaseFromBootstrap({
      boot,
      stream: { emit: () => undefined },
      onConfirm: async () => false,
    })

    const afterT1 = await runOneTurn(base, [], "first user message")

    // NEUTERED wire: adapter with a NO-OP onChange and NO setActive mutation —
    // this models "refreshSystemPrompt was disconnected / the per-turn read went
    // stale". The systemSource is never rebuilt.
    const brokenAdapter = buildIdentityModeAdapter({
      registry: boot.identityModeState.registry,
      getActive: () => boot.identityModeState.get(),
      // setActive intentionally OMITTED (adapter falls back to its own private
      // `active` var) so the authoritative cell + systemSource are untouched.
      onChange: () => {
        /* neutered — no systemSource.set */
      },
    })
    brokenAdapter.set("audit")
    // Proof the wire is actually cut: the shared cell + systemSource are unchanged.
    expect(boot.identityModeState.get()).toBe("default")
    expect(boot.systemSource.get()).toContain(DEFAULT_FINGERPRINT)

    await runOneTurn(base, afterT1, "second user message")

    const t1 = systemText(llm.seenSystem[0])
    const t2 = systemText(llm.seenSystem[1])
    // With the wire cut, turn 2 STILL carries the OLD identity and NEVER the new —
    // the exact regression the primary test's positive assertions would catch.
    expect(t2).toContain(DEFAULT_FINGERPRINT)
    expect(t2).not.toContain(AUDIT_FINGERPRINT)
    expect(t1).toBe(t2)
    __resetRuntimeConfig()
  })

  test("sanity: the two mode fingerprints are genuinely mode-exclusive (assertion is discriminating)", () => {
    // Guards against a vacuous fingerprint: prove each substring appears in its
    // OWN mode's rendered prompt and NOT the other's, using the REAL builder. If a
    // future edit made the two modes share text, the paired `.not.toContain`
    // assertions above would become tautologically true — this catches that.
    const registry = defaultModeVariantRegistry()
    const persona = "default" as const
    const renderMode = (mode: "default" | "audit"): string =>
      buildSystemPromptForMode({ mode, registry, persona })

    const defaultPrompt = renderMode("default")
    const auditPrompt = renderMode("audit")

    expect(defaultPrompt).toContain(DEFAULT_FINGERPRINT)
    expect(defaultPrompt).not.toContain(AUDIT_FINGERPRINT)
    expect(auditPrompt).toContain(AUDIT_FINGERPRINT)
    expect(auditPrompt).not.toContain(DEFAULT_FINGERPRINT)
    // Belt: also exercise the IdentityMode-typed swap target is a real member.
    const modes: IdentityMode[] = ["default", "audit"]
    expect(modes).toContain("audit")
  })
})
