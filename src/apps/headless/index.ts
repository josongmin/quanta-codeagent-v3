/**
 * `@/apps/headless` — second-consumer surface proof (ADR-0308 / ARCH-07).
 *
 * Drives the SAME `@/host/bootstrap` + `@/runner` cores the CLI uses, with
 * fully-faked deps + zero network. The proof's value is invariant: future
 * surfaces (Web/Tauri/embedded-browser per `surface-model.md`) can plug into
 * `@/host/bootstrap` + `@/runner` without touching `src/apps/cli/**`.
 *
 * SLICE INVARIANT (enforced by biome + hellgate test):
 *   - May import: `@/host/bootstrap`, `@/runner`, `@/agent` (types only),
 *     `@/llm` (types only), `@/stream`, `@/permission` (types only),
 *     `@/tool` (registry + types), `@/observability` (logger), `@/shared`
 *     (logger / runtime-config — none used today), `node:*`.
 *   - MUST NOT import: `src/apps/cli/**`, `src/apps/bench/**`,
 *     `src/apps/agent/**`.
 *
 * Single public entry: {@link runHeadlessOnce}.
 */

import type { AgentOutcome } from "@/agent"
import { bootstrapSession, type SessionBootstrapResult } from "@/host/bootstrap"
import {
  buildCapabilityManifestFromSessionDeps,
  createLegacySingleSessionRuntimeHost,
} from "@/host/runtime"
import {
  assembleConfig,
  buildSessionMemoryAutoWires,
  buildSharedExecutionPlaneSessionDeps,
  type SessionDeps,
} from "@/runner"
import { createRuntime, type RuntimeSessionInternal } from "@/sdk/runtime"
import { buildFakeBootstrapDeps, buildFakeRuntime, RecordingStream } from "./fake-deps"
import { FakeLlm } from "./fake-llm"
import type { FakeCompletion, HeadlessRunInput, HeadlessRunResult } from "./types"

export { buildFakeBootstrapDeps, buildFakeRuntime, RecordingStream } from "./fake-deps"
export { FakeLlm, scriptFromCompletion } from "./fake-llm"
export type { FakeCompletion, HeadlessRunInput, HeadlessRunResult } from "./types"

/** Normalize the input's completion(s) into the ordered list the fake LLM
 *  expects. Either form is valid; an empty list trips the FakeLlm's
 *  construction guard. */
const completionsOf = (input: HeadlessRunInput): readonly FakeCompletion[] => {
  if (input.fakeCompletions && input.fakeCompletions.length > 0) return input.fakeCompletions
  if (input.fakeCompletion) return [input.fakeCompletion]
  // Default: model says "ok". Keeps the smoke deterministic when the caller
  // is only proving the wiring (not asserting on text).
  return [{ text: "ok" }]
}

/** Compose the per-turn `SessionDeps` from a bootstrap result + the
 *  recording stream. Surface-clean: only fields the headless path needs
 *  (no admissibility, no plan-store, no follow-up queue). The signal flows
 *  through from the caller via `boot.abort.signal`. */
const composeHeadlessSessionDeps = async (
  boot: SessionBootstrapResult,
  input: HeadlessRunInput,
  stream: RecordingStream,
): Promise<SessionDeps> => {
  const base: SessionDeps = {
    llm: boot.llm,
    registry: boot.tooling.registry,
    stream,
    permission: boot.permission,
    system: boot.system,
    systemSource: boot.systemSource,
    cwd: boot.cwd,
    maxTurns: boot.maxTurns,
    signal: boot.abort.signal,
    // The headless surface does not interact with a human — `onConfirm` denies
    // every prompt so any tool that escalates is safely refused. Pair with a
    // pre-approved tool registry (or `mode: "bypass"`) for tool-call tests.
    onConfirm: async () => false,
    store: boot.tooling.store,
    sessionId: boot.sessionId,
    embedder: boot.tooling.embedder,
    memoryConfig: boot.tooling.memoryConfig,
    planMode: boot.features.planMode,
    metrics: boot.features.metrics,
    run: boot.run,
    subagentConfig: boot.tooling.subagentConfig,
    skillsConfig: boot.tooling.skillsConfig,
    compactionBreakerConfig: boot.tooling.compactionBreakerConfig,
    verifyGuardConfig: boot.tooling.verifyGuardConfig,
    summarizerLlm: undefined,
    ...(boot.toolProfileState !== undefined ? { toolProfileState: boot.toolProfileState } : {}),
    ...(boot.identityModeState !== undefined ? { identityModeState: boot.identityModeState } : {}),
    ...(boot.focusChain !== undefined ? { focusChain: boot.focusChain } : {}),
    onShellEvent: boot.onShellEvent,
    workMetricsSink: boot.workMetricsSink,
    sessionEffort: () => boot.effortStore.get(),
  }
  const executionPlaneDeps = await buildSharedExecutionPlaneSessionDeps({
    history: boot.history,
    sessionDeps: base,
    cwd: boot.cwd,
    envSource: input.env ?? {},
  })
  const memoryAuto = await buildSessionMemoryAutoWires({
    env: input.env ?? {},
    llm: boot.llm,
    sessionId: boot.sessionId,
    signal: boot.abort.signal,
    homeDir: input.homeDir ?? "/tmp",
  })
  return {
    ...base,
    ...executionPlaneDeps,
    ...(memoryAuto?.sessionCtx !== undefined ? { sessionCtx: memoryAuto.sessionCtx } : {}),
    ...(memoryAuto?.memoryConsolidator !== undefined
      ? { memoryConsolidator: memoryAuto.memoryConsolidator }
      : {}),
    ...(memoryAuto?.stage1OutputsStore !== undefined
      ? { stage1OutputsStore: memoryAuto.stage1OutputsStore }
      : {}),
  }
}

const abortedOutcome = (messages: readonly import("@/llm").Message[]): AgentOutcome => ({
  reason: "aborted",
  turns: 0,
  messages: [...messages],
})

/** Run a single agent turn through `@/host/bootstrap` + `@/runner` with
 *  faked deps. Returns the bootstrap result, the per-turn outcome, the
 *  resulting message history, and every `AgentEvent` the runner emitted.
 *
 *  Honors `input.signal`: an already-aborted signal short-circuits the run
 *  BEFORE bootstrap (no host work, no `runOnce` call) and returns a
 *  synthetic `outcome.reason === "aborted"`. A signal that aborts MID-RUN
 *  bubbles through `boot.abort.signal` (the signals are wired together via
 *  a one-way listener so user-cancel works without coupling to `process`). */
export const runHeadlessOnce = async (input: HeadlessRunInput): Promise<HeadlessRunResult> => {
  const completions = completionsOf(input)
  const llm = new FakeLlm(completions)
  const stream = new RecordingStream()
  const deps = buildFakeBootstrapDeps(llm, stream, [], {
    ...(input.subagentConfig !== undefined ? { subagentConfig: input.subagentConfig } : {}),
  })
  const runtime = buildFakeRuntime({
    maxTurns: input.maxTurns ?? 5,
    cwd: input.cwd ?? "/tmp/headless",
    env: input.env ?? {},
    homeDir: input.homeDir ?? "/tmp",
  })
  // Featureless surface config — the headless run never wires a cost panel /
  // branch progress / plan store / status pills, and the fake bootstrap deps
  // ignore the featureCfg slot entirely.
  const boot = await bootstrapSession(deps, runtime, {})

  // Wire the caller's signal into the boot AbortController so the runner's
  // per-turn `signal` (`boot.abort.signal`) cancels symmetrically with the
  // caller's. Honours an already-aborted signal up front so we never start
  // a turn we know is dead-on-arrival.
  if (input.signal) {
    if (input.signal.aborted) boot.abort.abort()
    else input.signal.addEventListener("abort", () => boot.abort.abort(), { once: true })
  }

  let session: RuntimeSessionInternal | undefined
  let runtimeFacade: Awaited<ReturnType<typeof createRuntime>> | undefined
  try {
    const sessionDeps = await composeHeadlessSessionDeps(boot, input, stream)
    const { runtimeHost, sessionHost } = createLegacySingleSessionRuntimeHost({
      boot,
      sessionDeps,
      assembleConfig,
      history: [...boot.history],
      state: boot.features.state,
      idMeta: boot.idMeta,
      shutdown: boot.shutdownMcp,
      buildCapabilityManifest: buildCapabilityManifestFromSessionDeps,
    })
    runtimeFacade = await createRuntime({ host: runtimeHost })
    session = (await runtimeFacade.createSession({
      cwd: boot.cwd,
      model: boot.model,
      permissionMode: boot.mode,
      ...(boot.identityModeState !== undefined
        ? { identityMode: boot.identityModeState.get() }
        : {}),
      ...(boot.toolProfileState !== undefined ? { toolProfile: boot.toolProfileState.get() } : {}),
    })) as RuntimeSessionInternal
    if (input.signal?.aborted === true) {
      const messages = [...sessionHost.peekMessages()]
      return {
        ...boot,
        outcome: abortedOutcome(messages),
        messages,
        events: stream.events,
        sessionDeps,
      }
    }
    await session.input.append(input.prompt, undefined, { signal: boot.abort.signal })
    await session.turn.run(undefined, { signal: boot.abort.signal })
    const outcome = sessionHost.peekLastOutcome() ?? abortedOutcome(sessionHost.peekMessages())
    return {
      ...boot,
      outcome,
      messages: sessionHost.peekMessages(),
      events: stream.events,
      sessionDeps,
    }
  } finally {
    await session?.close().catch(() => undefined)
    await runtimeFacade?.close().catch(() => undefined)
  }
}
