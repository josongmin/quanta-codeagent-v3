/**
 * `@/apps/headless` — second-consumer surface proof (ADR-0308 / ARCH-07).
 *
 * Drives the SAME `@/host/bootstrap` + internal `@/runner/*` cores the CLI uses, with
 * fully-faked deps + zero network. The proof's value is invariant: future
 * surfaces (Web/Tauri/embedded-browser per `surface-model.md`) can plug into
 * `@/host/bootstrap` + internal `@/runner/*` helpers without touching `src/apps/cli/**`.
 *
 * SLICE INVARIANT (enforced by biome + hellgate test):
 *   - May import: `@/host/bootstrap`, `@/host/runtime`, selected internal
 *     `@/runner/*` modules, `@/sdk/runtime`, `@/agent` (types only),
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
import type { RuntimeSession } from "@/sdk/runtime"
import {
  attachSessionTransport,
  createRuntimeFromBootstrap,
  summarizeRuntimeContext,
} from "@/sdk/runtime"
import { buildFakeBootstrapDeps, buildFakeRuntime, RecordingStream } from "./fake-deps"
import { FakeLlm } from "./fake-llm"
import type {
  FakeCompletion,
  HeadlessRunInput,
  HeadlessRunResult,
  HeadlessRuntimeWires,
} from "./types"

export { buildFakeBootstrapDeps, buildFakeRuntime, RecordingStream } from "./fake-deps"
export { FakeLlm, scriptFromCompletion } from "./fake-llm"
export type {
  FakeCompletion,
  HeadlessRunInput,
  HeadlessRunResult,
  HeadlessRuntimeWires,
} from "./types"

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

/** Compose the runtime-context inputs from a bootstrap result + the
 *  recording stream. Surface-clean: only fields the headless path needs
 *  (no admissibility, no plan-store, no follow-up queue). The signal flows
 *  through from the caller via `boot.abort.signal`. */
type HeadlessRuntimeContext = Awaited<
  ReturnType<typeof createRuntimeFromBootstrap>
>["runtimeContext"]

const buildHeadlessRuntimeArgs = (
  boot: SessionBootstrapResult,
  input: HeadlessRunInput,
  stream: RecordingStream,
): Parameters<typeof createRuntimeFromBootstrap>[0] => ({
  boot,
  stream,
  // The headless surface does not interact with a human — `onConfirm` denies
  // every prompt so any tool that escalates is safely refused. Pair with a
  // pre-approved tool registry (or `mode: "bypass"`) for tool-call tests.
  onConfirm: async () => false,
  execution: {
    history: boot.history,
    cwd: boot.cwd,
    envSource: input.env ?? {},
  },
  memoryAuto: {
    env: input.env ?? {},
    homeDir: input.homeDir ?? "/tmp",
  },
  history: [...boot.history],
  state: boot.features.state,
  idMeta: boot.idMeta,
  shutdown: boot.shutdownMcp,
})

const abortedOutcome = (messages: readonly import("@/llm").Message[]): AgentOutcome => ({
  reason: "aborted",
  turns: 0,
  messages: [...messages],
})

const summarizeHeadlessWires = (runtimeContext: HeadlessRuntimeContext): HeadlessRuntimeWires =>
  summarizeRuntimeContext(runtimeContext)

const buildHeadlessSessionConfig = (
  boot: SessionBootstrapResult,
): Parameters<
  Awaited<ReturnType<typeof createRuntimeFromBootstrap>>["runtime"]["createSession"]
>[0] => ({
  cwd: boot.cwd,
  model: boot.model,
  permissionMode: boot.mode,
  ...(boot.identityModeState !== undefined ? { identityMode: boot.identityModeState.get() } : {}),
  ...(boot.toolProfileState !== undefined ? { toolProfile: boot.toolProfileState.get() } : {}),
})

const buildAbortedHeadlessResult = (args: {
  readonly boot: SessionBootstrapResult
  readonly runtimeContext: HeadlessRuntimeContext
  readonly stream: RecordingStream
}): HeadlessRunResult => {
  const messages = [...args.boot.history]
  return {
    ...args.boot,
    outcome: abortedOutcome(messages),
    messages,
    events: args.stream.events,
    wires: summarizeHeadlessWires(args.runtimeContext),
  }
}

const attachHeadlessTransport = async (args: {
  readonly session: RuntimeSession
  readonly input: HeadlessRunInput
}): Promise<Awaited<ReturnType<typeof attachSessionTransport>> | undefined> => {
  if (args.input.transport === undefined) return undefined
  return await attachSessionTransport({
    session: args.session,
    transport: args.input.transport,
    ...(args.input.transportReplayWindow !== undefined
      ? { replayWindow: args.input.transportReplayWindow }
      : {}),
  })
}

/** Run a single agent turn through `@/host/bootstrap` + internal
 *  `@/runner/*` helpers with faked deps. Returns the bootstrap result, the
 *  per-turn outcome, the resulting message history, emitted `AgentEvent`s,
 *  and a lean reusable-wire summary.
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

  let session: RuntimeSession | undefined
  let runtimeFacade: Awaited<ReturnType<typeof createRuntimeFromBootstrap>>["runtime"] | undefined
  let transportHandle: Awaited<ReturnType<typeof attachSessionTransport>> | undefined
  try {
    const { runtime, runtimeContext } = await createRuntimeFromBootstrap(
      buildHeadlessRuntimeArgs(boot, input, stream),
    )
    runtimeFacade = runtime
    const runtimeSession = await runtimeFacade.createSession(buildHeadlessSessionConfig(boot))
    session = runtimeSession
    transportHandle = await attachHeadlessTransport({ session: runtimeSession, input })
    if (input.signal?.aborted === true) {
      return buildAbortedHeadlessResult({ boot, runtimeContext, stream })
    }
    await runtimeSession.input.append(input.prompt, undefined, { signal: boot.abort.signal })
    const turn = await runtimeSession.turn.run(undefined, { signal: boot.abort.signal })
    if (turn.turn === undefined) {
      throw new Error("headless SDK session completed without a turn payload")
    }
    const outcome = turn.turn.outcome
    return {
      ...boot,
      outcome,
      messages: turn.turn.messages,
      events: stream.events,
      wires: summarizeHeadlessWires(runtimeContext),
    }
  } finally {
    await transportHandle?.close().catch(() => undefined)
    await session?.close().catch(() => undefined)
    await runtimeFacade?.close().catch(() => undefined)
  }
}
