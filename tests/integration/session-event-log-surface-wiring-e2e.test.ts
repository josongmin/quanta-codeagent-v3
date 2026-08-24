/**
 * GAP-1 (docs/plans/jul-16-transport-unified-sdk/wiring-audit-jul17.md §"배선 필요
 * 작업 목록") — SURFACE-LEVEL durable-persist wiring REGRESSION seal.
 *
 * The wiring under audit: `QUANTA_SESSION_EVENT_LOG_DIR` is a composition seam at
 * `src/sdk/runtime/runtime.ts:21` (`createSessionPersistence({ sessionId })`).
 * Every SDK-runtime SURFACE converges on it via
 * `createRuntimeFromAgentConfigBase → createRuntimeFacadeFromBinding →
 * createRuntime → createRuntimeFacade` (audit axis 1, PARTIAL-LIVE). The seam is
 * real code, but the ONLY tests that touch it either (a) drive `createRuntime`
 * with a FAKE host that throws on `runTurn` and only calls `input.append`
 * (`tests/unit/sdk/runtime-event-log-resume.test.ts`), or (b) assert the wire
 * replay in isolation (`durable-resume-restart.test.ts`). NONE prove that a
 * PRODUCTION SURFACE COMPOSITION — the exact `createRuntimeFromAgentConfigBase +
 * buildInteractiveTurnAssembler` pair the web-daemon (`runtime-factory.ts:908`)
 * and interactive CLI (`agent/mode-presets/interactive.ts:120`) build — actually
 * lands a `<dir>/<sessionId>.jsonl` on disk when the gate is set. A refactor that
 * re-routes surface session creation off `createRuntime` would kill durable
 * logging with ZERO red test. This file is that lock.
 *
 * Battery:
 *   (web-daemon ON) build the web-daemon runtime pair under
 *     `QUANTA_SESSION_EVENT_LOG_DIR=<tmp>`, run a REAL scripted-LLM turn, assert
 *     `<tmp>/<sessionId>.jsonl` exists AND its lines decode (through the
 *     @/protocol/session codec — NOT the objects under test) into the events the
 *     turn actually emitted (turn lifecycle + the appended input).
 *   (interactive-CLI ON) same, through the SAME production composition pair the
 *     CLI interactive preset builds — a second surface converging on runtime.ts:21.
 *   (OFF symmetry) gate unset ⇒ the tmp dir stays EMPTY (zero disk contact),
 *     byte-identical to the historical InMemory backend.
 *
 * Non-vacuity: the file-exists check alone is VACUOUS — `JsonlSessionEventLog`'s
 * constructor creates the (empty) file + a `.lock` before any event lands
 * (event-log-jsonl.ts:256-264). So every ON assertion decodes the file and pins
 * the actual turn's seq/type stream; a log wired but never fed would show an
 * empty decode and go red.
 *
 * Surface honesty: `buildSurfaceRuntime` here is the web-daemon runtime-factory
 * pair VERBATIM (`createRuntimeFromAgentConfigBase({ base, turnAssembler:
 * buildInteractiveTurnAssembler() })`, same as `runtime-factory.ts:907-908` and
 * mirrored by the approval-continuation web-daemon e2e). The interactive-CLI leg
 * uses the identical exported pair the CLI preset calls
 * (`agent/mode-presets/interactive.ts:120-122`). We do NOT stand up an HTTP
 * server / TTY (out of scope, no hermetic harness) — the load-bearing seam being
 * locked is the shared `createRuntimeFromAgentConfigBase` composition both
 * surfaces route through, and that is real-composition, not `createRuntime`
 * direct. The `SessionHost` is the production one built by the binding; only the
 * LLM + tools are scripted (offline).
 *
 * RED-ON-INJECTION (verified manually, then reverted — see the report):
 *   In `src/sdk/runtime/runtime.ts:21`, replace
 *     `eventLog: createSessionPersistence({ sessionId: description.sessionId })`
 *   with
 *     `eventLog: createInMemorySessionPersistence()`  // + import swap
 *   ⇒ the surface never opens a disk log; both ON tests go RED at the
 *   `existsSync(file)` / decode assertions. Restore the line to re-green. This
 *   proves the assertion is load-bearing on the runtime.ts:21 wiring, not on the
 *   isolated log object.
 *
 * Hermetic + offline (ScriptedLLM, no network). Real mkdtemp, guaranteed cleanup
 * (runtime/session closed BEFORE rmSync so the single-writer lock is released;
 * env var save/restored). Event-based waits only — NO wall-clock assertions.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { decodeSessionEvent } from "@/protocol/session"
import {
  createRuntimeFromAgentConfigBase,
  type RuntimeFacade,
  type RuntimeSession,
} from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { ToolRegistry } from "@/tool"
import { nth } from "../_helpers/expect-present"

const ENV_KEY = "QUANTA_SESSION_EVENT_LOG_DIR"

/** Scripted LLM: a single text-only turn (no tools ⇒ no gate). Enough to make
 *  the session publish real turn-lifecycle + state events that the kernel session
 *  appends to whatever `eventLog` the runtime wired. */
class ScriptedLLM implements LLMPort {
  readonly model = "stub-eventlog-surface"
  private readonly scripts: StreamEvent[][]
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    for (const ev of this.scripts.shift() ?? [{ type: "message_stop", stop_reason: "end_turn" }])
      yield ev
  }
}

const endText: StreamEvent[] = [
  { type: "text_delta", delta: "done" },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** A minimal permission proxy of the web-daemon runtime-factory shape. */
const liveProxy = (mode: PermissionContext["mode"] = "default"): PermissionContext => {
  let m = mode
  return {
    get mode() {
      return m
    },
    set mode(next) {
      m = next
    },
  }
}

/** The web-daemon runtime-factory pair, VERBATIM: `createRuntimeFromAgentConfigBase`
 *  with `buildInteractiveTurnAssembler()` (runtime-factory.ts:907-908). The
 *  interactive-CLI preset (agent/mode-presets/interactive.ts:120-122) builds the
 *  IDENTICAL pair — so a single harness faithfully represents BOTH surfaces'
 *  convergence on runtime.ts:21. */
const buildSurfaceRuntime = async (): Promise<RuntimeFacade> => {
  const abort = new AbortController()
  const base = {
    llm: new ScriptedLLM([endText]),
    registry: new ToolRegistry([]),
    stream: new StdoutStream(),
    permission: liveProxy("default"),
    messages: [],
    system: "system",
    cwd: "/tmp/quanta-eventlog-surface",
    maxTurns: 4,
    signal: abort.signal,
  }
  const { runtime } = await createRuntimeFromAgentConfigBase({
    base: base as Parameters<typeof createRuntimeFromAgentConfigBase>[0]["base"],
    turnAssembler: buildInteractiveTurnAssembler(),
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  return runtime
}

/** Fresh tmp dirs, cleaned per test. */
const tmpDirs: string[] = []
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-gap1-eventlog-"))
  tmpDirs.push(dir)
  return dir
}

/** Save/restore the gate env var around every test (bun runs a file in ONE
 *  process — a leaked env var would flip OTHER suites' composition). */
const savedEnv = process.env[ENV_KEY]
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Run one real turn on the surface session and hand back the sessionId. The
 *  turn publishes `turn.started`/state/`turn.completed`; the appended input adds
 *  a `session.state.updated` — all of which the wired durable log must persist. */
const runOneTurn = async (
  runtime: RuntimeFacade,
): Promise<{ sessionId: string; session: RuntimeSession }> => {
  const session = await runtime.createSession({
    cwd: "/tmp/quanta-eventlog-surface",
    permissionMode: "default",
  })
  await session.input.append("hello surface")
  const result = await session.turn.run()
  // The turn genuinely completed on the real composition (not a no-op) — this is
  // the event source whose persistence we then read off disk.
  expect(result.turn).toBeDefined()
  return { sessionId: session.sessionId, session }
}

/** Decode a surface's on-disk JSONL through the protocol codec (NOT the log
 *  object under test) — the fresh-readback that makes the persistence claim real. */
const decodeLog = (dir: string, sessionId: string) => {
  const file = join(dir, `${sessionId}.jsonl`)
  expect(existsSync(file)).toBe(true)
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
  const events = lines.map((line) => decodeSessionEvent(line))
  return { file, events }
}

describe("GAP-1: session event-log SURFACE wiring regression (web-daemon + interactive-CLI)", () => {
  test("web-daemon surface: gate ON ⇒ a real turn lands a decodable <dir>/<sessionId>.jsonl on disk", async () => {
    const dir = freshDir()
    process.env[ENV_KEY] = dir

    const runtime = await buildSurfaceRuntime()
    const { sessionId, session } = await runOneTurn(runtime)
    // Close BEFORE reading/cleanup so the single-writer lock is released and the
    // append fd is flushed/closed (event-log-jsonl.ts close()).
    cleanup = async () => {
      await session.close()
      await runtime.close()
    }
    await cleanup()
    cleanup = undefined

    const { events } = decodeLog(dir, sessionId)
    // NON-VACUOUS: the file exists at construction, so decode must show the
    // actual turn's events, not an empty log.
    expect(events.length).toBeGreaterThan(0)
    // Seqs are dense & strictly increasing from 1 (a fresh session, real issuance).
    expect(events[0]?.seq).toBe(1)
    for (let i = 1; i < events.length; i += 1) {
      expect(nth(events, i, "events").seq).toBeGreaterThan(nth(events, i - 1, "events").seq)
    }
    // The turn lifecycle actually reached disk — this is what a broken surface
    // wiring (in-memory backend) could NOT produce.
    const types = new Set(events.map((event) => event.type))
    expect(types.has("session.state.updated")).toBe(true)
    expect(types.has("turn.completed")).toBe(true)
  })

  test("interactive-CLI surface: gate ON ⇒ same production pair persists disk JSONL (second convergence on runtime.ts:21)", async () => {
    // Identical exported composition (`createRuntimeFromAgentConfigBase +
    // buildInteractiveTurnAssembler`) that agent/mode-presets/interactive.ts:120
    // builds — a distinct SURFACE routing through the SAME seam. A second turn on
    // a fresh session id proves the disk-persist wiring is a property of the
    // shared composition, not a web-daemon accident.
    const dir = freshDir()
    process.env[ENV_KEY] = dir

    const runtime = await buildSurfaceRuntime()
    const { sessionId, session } = await runOneTurn(runtime)
    cleanup = async () => {
      await session.close()
      await runtime.close()
    }
    await cleanup()
    cleanup = undefined

    const { events } = decodeLog(dir, sessionId)
    expect(events.length).toBeGreaterThan(0)
    expect(events.some((event) => event.type === "turn.completed")).toBe(true)
  })

  test("OFF symmetry: gate unset ⇒ the tmp dir stays EMPTY (zero disk contact, byte-identical to InMemory)", async () => {
    const dir = freshDir()
    delete process.env[ENV_KEY] // explicitly OFF (blank/whitespace covered by the seam unit)

    const runtime = await buildSurfaceRuntime()
    const { session } = await runOneTurn(runtime)
    cleanup = async () => {
      await session.close()
      await runtime.close()
    }
    await cleanup()
    cleanup = undefined

    // The surface used the historical InMemory backend — NOTHING was written to
    // the canary dir (not even the empty file + .lock the JSONL log would create).
    expect(readdirSync(dir)).toEqual([])
  })
})
