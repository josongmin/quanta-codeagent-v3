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

import { bootstrapSession, type SessionBootstrapResult } from "@/host/bootstrap"
import { assembleConfig, type SessionDeps } from "@/runner/assemble"
import { runOnce } from "@/runner/orchestrate"
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
const composeHeadlessSessionDeps = (
  boot: SessionBootstrapResult,
  stream: RecordingStream,
): SessionDeps => ({
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
  const deps = buildFakeBootstrapDeps(llm, stream)
  const runtime = buildFakeRuntime({
    maxTurns: input.maxTurns ?? 5,
    cwd: input.cwd ?? "/tmp/headless",
    env: input.env ?? {},
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

  try {
    const sessionDeps = composeHeadlessSessionDeps(boot, stream)
    const { outcome, messages } = await runOnce({
      deps: sessionDeps,
      assembleConfig,
      history: [...boot.history],
      prompt: input.prompt,
      state: boot.features.state,
      idMeta: boot.idMeta,
    })
    return { ...boot, outcome, messages, events: stream.events }
  } finally {
    // Default-OFF: empty mcpClients ⇒ `shutdownMcp` is a no-op. Kept in a
    // `finally` so a future wired MCP path tears down cleanly.
    await boot.shutdownMcp()
  }
}
