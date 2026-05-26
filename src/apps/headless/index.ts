/**
 * `@/apps/headless` — second-consumer surface proof (ADR-0308 / ARCH-07).
 *
 * Drives the SAME `@/host/bootstrap` + internal `@/runner/*` cores the CLI uses, with
 * fully-faked deps + zero network. The proof's value is invariant: future
 * surfaces (Web/Tauri/embedded-browser per `surface-model.md`) can plug into
 * the shared host/runtime helpers without touching `src/apps/cli/**`.
 *
 * SLICE INVARIANT (enforced by biome + hellgate test):
 *   - Public entry may import: `@/sdk/runtime`, `@/agent` (types only),
 *     `@/llm` (types only), `@/stream`, `@/permission` (types only),
 *     `@/tool` (registry + types), `@/observability` (logger), `@/shared`
 *     (logger / runtime-config — none used today), `node:*`.
 *   - Any bootstrap/runtime-compat ownership stays in local private adapters.
 *   - MUST NOT import: `src/apps/cli/**`, `src/apps/bench/**`,
 *     `src/apps/agent/**`.
 *
 * Single public entry: {@link runHeadlessOnce}.
 */

import type { AgentOutcome } from "@/agent"
import type { Message } from "@/llm"
import {
  buildFakeBootstrapDeps,
  buildFakeRuntime,
  HEADLESS_FAKE_SESSION_ID,
  RecordingStream,
} from "./fake-deps"
import { FakeLlm } from "./fake-llm"
import { openHeadlessRuntimeSession, summarizeHeadlessSessionWires } from "./session-bridge"
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

const abortedOutcome = (messages: readonly Message[]): AgentOutcome => ({
  reason: "aborted",
  turns: 0,
  messages: [...messages],
})

const EMPTY_WIRES: HeadlessRuntimeWires = {
  executionPlane: {
    conversationCheckpoint: false,
    fork: false,
    forkSession: false,
    delegation: false,
    subagentBackground: false,
    autoBackground: false,
  },
  memoryAuto: {
    sessionCtx: false,
    stage1OutputsStore: false,
    memoryConsolidator: false,
    memoryConsolidatorEnabled: false,
  },
}

const buildHeadlessMeta = (args: {
  readonly provider: string
  readonly model: string
  readonly mode: string
  readonly maxTurns: number
  readonly cwd: string
  readonly sessionId: string
}): Pick<HeadlessRunResult, "provider" | "model" | "mode" | "maxTurns" | "cwd" | "sessionId"> => ({
  provider: args.provider,
  model: args.model,
  mode: args.mode,
  maxTurns: args.maxTurns,
  cwd: args.cwd,
  sessionId: args.sessionId,
})

const buildPreBootstrapAbortedResult = (args: {
  readonly provider: string
  readonly model: string
  readonly mode: string
  readonly maxTurns: number
  readonly cwd: string
}): HeadlessRunResult => {
  const messages: readonly Message[] = []
  return {
    ...buildHeadlessMeta({
      provider: args.provider,
      model: args.model,
      mode: args.mode,
      maxTurns: args.maxTurns,
      cwd: args.cwd,
      sessionId: HEADLESS_FAKE_SESSION_ID,
    }),
    outcome: abortedOutcome(messages),
    messages,
    events: [],
    wires: EMPTY_WIRES,
  }
}

/** Run a single agent turn through `@/host/bootstrap` + internal
 *  `@/runner/*` helpers with faked deps. Returns SDK-facing session metadata,
 *  the per-turn outcome, the resulting message history, emitted `AgentEvent`s,
 *  an SDK snapshot when a session was opened, and a lean reusable-wire summary.
 *
 *  Honors `input.signal`: an already-aborted signal short-circuits the run
 *  BEFORE bootstrap (no host work, no `runOnce` call) and returns a
 *  synthetic `outcome.reason === "aborted"`. A signal that aborts MID-RUN
 *  bubbles through the shared host abort controller. */
export const runHeadlessOnce = async (input: HeadlessRunInput): Promise<HeadlessRunResult> => {
  const completions = completionsOf(input)
  const runtime = buildFakeRuntime({
    maxTurns: input.maxTurns ?? 5,
    cwd: input.cwd ?? "/tmp/headless",
    env: input.env ?? {},
    homeDir: input.homeDir ?? "/tmp",
  })
  if (input.signal?.aborted === true) {
    return buildPreBootstrapAbortedResult({
      provider: runtime.provider,
      model: runtime.model,
      mode: runtime.mode,
      maxTurns: runtime.maxTurns,
      cwd: runtime.cwd,
    })
  }
  const llm = new FakeLlm(completions)
  const stream = new RecordingStream()
  const deps = buildFakeBootstrapDeps(llm, stream, [], {
    ...(input.subagentConfig !== undefined ? { subagentConfig: input.subagentConfig } : {}),
  })

  let bridge: Awaited<ReturnType<typeof openHeadlessRuntimeSession>> | undefined
  try {
    bridge = await openHeadlessRuntimeSession({
      input,
      deps,
      runtime,
      stream,
    })
    if (bridge.boot.abort.signal.aborted) {
      return {
        ...buildHeadlessMeta({
          provider: bridge.boot.provider,
          model: bridge.boot.model,
          mode: bridge.boot.mode,
          maxTurns: bridge.boot.maxTurns,
          cwd: bridge.boot.cwd,
          sessionId: bridge.boot.sessionId,
        }),
        outcome: abortedOutcome([]),
        messages: [],
        events: stream.events,
        snapshot: await bridge.session.snapshot(),
        wires: summarizeHeadlessSessionWires(bridge.runtimeContext),
      }
    }
    await bridge.session.input.append(input.prompt, undefined, { signal: bridge.boot.abort.signal })
    const turn = await bridge.session.turn.run(undefined, { signal: bridge.boot.abort.signal })
    if (turn.turn === undefined) {
      throw new Error("headless SDK session completed without a turn payload")
    }
    const outcome = turn.turn.outcome
    const snapshot = await bridge.session.snapshot()
    return {
      ...buildHeadlessMeta({
        provider: bridge.boot.provider,
        model: bridge.boot.model,
        mode: bridge.boot.mode,
        maxTurns: bridge.boot.maxTurns,
        cwd: bridge.boot.cwd,
        sessionId: bridge.boot.sessionId,
      }),
      outcome,
      messages: turn.turn.messages,
      events: stream.events,
      snapshot,
      wires: summarizeHeadlessSessionWires(bridge.runtimeContext),
    }
  } finally {
    await bridge?.transportHandle?.close().catch(() => undefined)
    await bridge?.session.close().catch(() => undefined)
    await bridge?.runtimeFacade.close().catch(() => undefined)
  }
}
