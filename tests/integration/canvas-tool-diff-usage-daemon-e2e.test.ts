/**
 * SOTA++ hellgate e2e (W3) — canvas `tool.diff` + `context.usage` flow the WHOLE
 * daemon pipeline, from a REAL agent turn to a REAL WebSocket client frame:
 *
 *     RecordingLLM streams a `write` tool_use
 *       └─ real agent loop dispatch (@/agent/dispatch)
 *            └─ ToolContext.toolDiff = config.onToolDiff   ← canvas tool-diff source
 *                 └─ write tool captures before/after (no recompute)
 *                      └─ source fan-out → per-connection emitter.feedToolDiff
 *                           └─ diffOps + caps run ONCE → tool.diff frame
 *                                └─ ws.send(encodeCanvasFrame) → WS wire
 *                                     └─ client decodeCanvasFrame → kind:"tool.diff"
 *
 *   ...and IN THE SAME TURN the loop's `onPromptAssembled` seam fires
 *   (context-assembler.ts) → canvas usage source → emitter.feedUsage →
 *   `context.usage` frame with measured segment/total token counts.
 *
 * This is the gap the sibling UNIT hellgates (`tool-diff-capture-hellgate`,
 * `context-usage-breakdown-hellgate`, `canvas-web-components-hellgate`) could
 * NOT pin: they exercise the seam, the source fan-out, and the emitter math in
 * ISOLATION. Here a real `Bun.serve` daemon + a real `WebSocket` client +
 * a real loop turn light the FULL emit→sink→WS path.
 *
 * Hermetic + offline: a `RecordingLLM` (no network) scripts the turn; the write
 * lands in a `tmpdir` file. NO timing assertions — every wait is an event/frame
 * barrier (`waitForCanvas`, `waitForOpen`).
 *
 * Default-OFF byte-identical (gate OFF): with `QUANTA_WEB_CANVAS` unset the
 * composition root never eagerly mints the observable facade ⇒ `canvasPorts` is
 * undefined ⇒ NO canvas sink attaches ⇒ the same turn emits ZERO canvas frames.
 *
 * Red-on-injection: a variant factory that drops the `onToolDiff` /
 * `onPromptAssembled` wires (the exact regression a careless refactor would
 * introduce) yields NO `tool.diff` / `context.usage` frame respectively — RED.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSystemPrompt } from "@/agent"
import type { AgentConfig } from "@/agent/types"
import { main } from "@/apps/web-daemon"
import { createCanvasToolDiffSource } from "@/apps/web-daemon/canvas-tool-diff-source"
import { createCanvasUsageSource } from "@/apps/web-daemon/canvas-usage-source"
import type { ObservableRuntimeFacade } from "@/apps/web-daemon/runtime-factory"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { encodeSessionTransportMessage } from "@/ipc/session"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { type CanvasMessage, decodeCanvasFrame } from "@/protocol/canvas"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"

/* ------------------------------------------------------------------ */
/* RecordingLLM — scripts a write tool_use then a text completion.     */
/* ------------------------------------------------------------------ */

/** Replays one StreamEvent[] per `stream()` call, in order. NO network. */
class RecordingLLM implements LLMPort {
  // A TABLED model id so `resolveModelWindow` yields a real 200k context window
  // (the usage gauge's `max`); an un-tabled id would report `max: 0`.
  readonly model = "claude-sonnet-4-6"
  calls = 0
  private readonly scripts: StreamEvent[][]
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const script = this.scripts[this.calls] ?? this.scripts[this.scripts.length - 1] ?? []
    this.calls += 1
    for (const ev of script) yield ev
  }
}

const toolUseScript = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/* ------------------------------------------------------------------ */
/* A REAL runtime factory — mirrors buildProductionRuntimeFactory's    */
/* `base` AgentConfig (onPromptAssembled + onToolDiff wired), injects   */
/* the RecordingLLM + acceptEdits permission so write auto-allows.      */
/* ------------------------------------------------------------------ */

interface FactoryOpts {
  /** When false, do NOT wire `onToolDiff` (red-on-injection variant). */
  readonly wireToolDiff?: boolean
  /** When false, do NOT wire `onPromptAssembled` (red-on-injection variant). */
  readonly wireUsage?: boolean
}

const buildRealCanvasFactory = (
  cwd: string,
  scripts: StreamEvent[][],
  bag: { sessionId?: string },
  opts: FactoryOpts = {},
): (() => Promise<ObservableRuntimeFacade>) => {
  const wireToolDiff = opts.wireToolDiff ?? true
  const wireUsage = opts.wireUsage ?? true
  return async (): Promise<ObservableRuntimeFacade> => {
    const abort = new AbortController()
    // acceptEdits ⇒ the `write` tool (hitlTier "pre-approval-ok") auto-allows,
    // so the turn never blocks on an approval round-trip.
    let permMode: PermissionContext["mode"] = "acceptEdits"
    const permission: PermissionContext = {
      get mode() {
        return permMode
      },
      set mode(next) {
        permMode = next
      },
    }
    const canvasUsage = createCanvasUsageSource()
    const canvasToolDiff = createCanvasToolDiffSource()

    const base: Omit<AgentConfig, "modePolicy" | "budgetMeter"> = {
      llm: new RecordingLLM(scripts),
      registry: new ToolRegistry(buildDefaultTools()),
      stream: new StdoutStream(),
      permission,
      messages: [],
      system: buildSystemPrompt(cwd),
      cwd,
      maxTurns: 8,
      signal: abort.signal,
      hitl: { enabled: true },
      // The wires under test. The red-on-injection variants drop one of them.
      ...(wireUsage ? { onPromptAssembled: canvasUsage.sink } : {}),
      ...(wireToolDiff ? { onToolDiff: canvasToolDiff.sink } : {}),
    }
    const { runtime } = await createRuntimeFromAgentConfigBase({
      base,
      turnAssembler: buildInteractiveTurnAssembler(),
      history: [...base.messages],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    const facade = runtime as ObservableRuntimeFacade
    // Expose the canvas sources so the daemon's `buildCanvasPorts` reads them
    // (gate ON only). Mirrors runtime-factory's `Object.defineProperty` wiring.
    Object.defineProperty(facade, "canvasUsage", { get: () => canvasUsage, enumerable: true })
    Object.defineProperty(facade, "canvasToolDiff", {
      get: () => canvasToolDiff,
      enumerable: true,
    })
    // Capture the real session id (a uuid) so the test can address `connect`.
    const realCreate = facade.createSession.bind(facade)
    facade.createSession = (async (cfg) => {
      const session = await realCreate(cfg)
      bag.sessionId = session.sessionId
      return session
    }) as typeof facade.createSession
    return facade
  }
}

/* ------------------------------------------------------------------ */
/* WS client helpers                                                   */
/* ------------------------------------------------------------------ */

const waitForOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true })
  })

/** Collect EVERY decoded canvas frame the socket receives until `predicate`
 *  is satisfied (resolving with the full collected list), or reject on timeout.
 *  Canvas frames ride the raw WS wire (NOT a SessionTransportMessage), so we
 *  decode each string with `decodeCanvasFrame` and ignore non-canvas frames. */
const collectCanvas = (
  ws: WebSocket,
): {
  frames: CanvasMessage[]
  waitFor: (kind: CanvasMessage["kind"], timeoutMs?: number) => Promise<CanvasMessage>
} => {
  const frames: CanvasMessage[] = []
  ws.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return
    const canvas = decodeCanvasFrame(event.data)
    if (canvas !== null) frames.push(canvas)
  })
  const waitFor = (kind: CanvasMessage["kind"], timeoutMs = 4000): Promise<CanvasMessage> =>
    new Promise((resolve, reject) => {
      const existing = frames.find((f) => f.kind === kind)
      if (existing !== undefined) return resolve(existing)
      const timer = setInterval(() => {
        const hit = frames.find((f) => f.kind === kind)
        if (hit !== undefined) {
          clearInterval(timer)
          clearTimeout(deadline)
          resolve(hit)
        }
      }, 10)
      const deadline = setTimeout(() => {
        clearInterval(timer)
        reject(
          new Error(
            `waitForCanvas(${kind}): timed out (saw ${frames.map((f) => f.kind).join(",")})`,
          ),
        )
      }, timeoutMs)
    })
  return { frames, waitFor }
}

/** Drive a real turn: connect → input.append → turn.run. */
const driveTurn = (ws: WebSocket, sessionId: string, prompt: string): void => {
  const issuedAt = new Date().toISOString()
  ws.send(encodeSessionTransportMessage({ kind: "connect", sessionId }))
  ws.send(
    encodeSessionTransportMessage({
      kind: "command",
      command: { sessionId, commandId: "cmd-append", issuedAt, type: "input.append", text: prompt },
    }),
  )
  ws.send(
    encodeSessionTransportMessage({
      kind: "command",
      command: { sessionId, commandId: "cmd-run", issuedAt, type: "turn.run" },
    }),
  )
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const handles: WebDaemonHandle[] = []
const tmpDirs: string[] = []
let savedCanvasGate: string | undefined

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()
    if (h !== undefined) await h.stop().catch(() => undefined)
  }
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
  // Restore the gate after every test (hermetic env).
  if (savedCanvasGate === undefined)
    delete (process.env as Record<string, string | undefined>).QUANTA_WEB_CANVAS
  else process.env.QUANTA_WEB_CANVAS = savedCanvasGate
})

const setup = (
  gateOn: boolean,
  factoryOpts: FactoryOpts = {},
): {
  dir: string
  file: string
  before: string
  after: string
  bag: { sessionId?: string }
  factory: () => Promise<ObservableRuntimeFacade>
} => {
  savedCanvasGate = process.env.QUANTA_WEB_CANVAS
  if (gateOn) process.env.QUANTA_WEB_CANVAS = "1"
  else delete (process.env as Record<string, string | undefined>).QUANTA_WEB_CANVAS

  const dir = mkdtempSync(join(tmpdir(), "canvas-e2e-"))
  tmpDirs.push(dir)
  const file = join(dir, "target.ts")
  const before = "const x = 1\nconst y = 2\nconst z = 3\n"
  const after = "const x = 42\nconst y = 2\nconst z = 3\n"
  writeFileSync(file, before, "utf8")

  const bag: { sessionId?: string } = {}
  const scripts: StreamEvent[][] = [
    // Turn-1 LLM response: write the new content to the seeded file.
    toolUseScript("call-write-1", "write", { path: file, content: after }),
    // Turn-2 (after tool result): finish.
    textScript("done"),
  ]
  const factory = buildRealCanvasFactory(dir, scripts, bag, factoryOpts)
  return { dir, file, before, after, bag, factory }
}

/* ================================================================== */

describe("W3 canvas e2e — tool.diff + context.usage flow daemon → WS client", () => {
  test("gate ON: a real write turn delivers a tool.diff frame (before/after) to the client", async () => {
    const { file, after, bag, factory } = setup(/* gateOn */ true)
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)
    expect(bag.sessionId).toBeDefined()

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    const { waitFor } = collectCanvas(ws)
    // Let the server-side open() finish wiring the canvas sink + session.
    await new Promise((r) => setTimeout(r, 30))

    driveTurn(ws, bag.sessionId!, "please edit the file")

    const diff = await waitFor("tool.diff")
    expect(diff.kind).toBe("tool.diff")
    if (diff.kind !== "tool.diff") throw new Error("narrow")
    expect(diff.toolCallId).toBe("call-write-1")
    expect(diff.path).toBe(file)
    // The line-diff ran ONCE in the emitter: line 1 changed, lines 2-3 kept.
    expect(diff.additions).toBe(1)
    expect(diff.deletions).toBe(1)
    const added = diff.lines.filter((l) => l.type === "added").map((l) => l.content)
    const removed = diff.lines.filter((l) => l.type === "removed").map((l) => l.content)
    expect(removed).toContain("const x = 1")
    expect(added).toContain("const x = 42")
    expect(diff.binary).toBeUndefined()

    ws.close()
    await new Promise((r) => setTimeout(r, 20))
    expect(after).toContain("42") // sanity: scripted content used
  })

  test("gate ON: the same turn delivers a context.usage frame with measured token counts", async () => {
    const { bag, factory } = setup(/* gateOn */ true)
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    const { waitFor } = collectCanvas(ws)
    await new Promise((r) => setTimeout(r, 30))

    driveTurn(ws, bag.sessionId!, "please edit the file")

    const usage = await waitFor("context.usage")
    expect(usage.kind).toBe("context.usage")
    if (usage.kind !== "context.usage") throw new Error("narrow")
    expect(usage.segments.length).toBeGreaterThan(0)
    // total = sum of segment tokens (the loop's estimator computed every count).
    const sum = usage.segments.reduce((a, s) => a + s.tokens, 0)
    expect(usage.total).toBe(sum)
    expect(usage.total).toBeGreaterThan(0)
    expect(usage.max).toBeGreaterThan(0)

    ws.close()
    await new Promise((r) => setTimeout(r, 20))
  })

  test("gate OFF (default): the SAME turn delivers ZERO canvas frames (byte-identical)", async () => {
    const { bag, factory } = setup(/* gateOn */ false)
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    const { frames } = collectCanvas(ws)
    await new Promise((r) => setTimeout(r, 30))

    driveTurn(ws, bag.sessionId!, "please edit the file")
    // Give the whole turn ample time to run + any (absent) frames to arrive.
    await new Promise((r) => setTimeout(r, 600))

    expect(frames).toHaveLength(0)

    ws.close()
    await new Promise((r) => setTimeout(r, 20))
  })

  test("red-on-injection: dropping onToolDiff ⇒ NO tool.diff frame (usage still flows)", async () => {
    const { bag, factory } = setup(/* gateOn */ true, { wireToolDiff: false })
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    const { frames, waitFor } = collectCanvas(ws)
    await new Promise((r) => setTimeout(r, 30))

    driveTurn(ws, bag.sessionId!, "please edit the file")

    // Usage still flows (its wire is intact) — use it as a turn-progressed barrier.
    await waitFor("context.usage")
    // Drain a little more in case a tool.diff were (wrongly) in flight.
    await new Promise((r) => setTimeout(r, 200))
    expect(frames.some((f) => f.kind === "tool.diff")).toBe(false)

    ws.close()
    await new Promise((r) => setTimeout(r, 20))
  })

  test("red-on-injection: dropping onPromptAssembled ⇒ NO context.usage frame (diff still flows)", async () => {
    const { bag, factory } = setup(/* gateOn */ true, { wireUsage: false })
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    const { frames, waitFor } = collectCanvas(ws)
    await new Promise((r) => setTimeout(r, 30))

    driveTurn(ws, bag.sessionId!, "please edit the file")

    // Diff still flows (its wire is intact) — use it as a turn-progressed barrier.
    await waitFor("tool.diff")
    await new Promise((r) => setTimeout(r, 200))
    expect(frames.some((f) => f.kind === "context.usage")).toBe(false)

    ws.close()
    await new Promise((r) => setTimeout(r, 20))
  })
})
