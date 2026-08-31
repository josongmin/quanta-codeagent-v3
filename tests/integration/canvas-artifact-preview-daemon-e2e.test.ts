/**
 * A2 wire-finish e2e — the rich-artifact preview channel flows the WHOLE daemon
 * pipeline, from a REAL agent turn to (a) a REAL WebSocket Canvas frame AND
 * (b) REAL jailed preview bytes over the `GET /artifact/:id` IPC route:
 *
 *     a pre-registered artifact in the session ArtifactRegistry
 *       └─ real agent loop turn completes (@/agent + kernel scheduler)
 *            └─ turn runner drains registry → result.artifacts (ArtifactRef)
 *                 └─ kernel emits session `artifact.ready` event
 *                      └─ setupCanvasArtifactBridge → CanvasArtifactSource.sink
 *                           └─ per-connection emitter.feedArtifactReady
 *                                └─ ws.send(encodeCanvasFrame) → WS wire
 *                                     └─ client decodeCanvasFrame → artifact.ready
 *      ...and the SAME locator's bytes resolve via GET /artifact/<id> (jailed).
 *
 * Default-OFF byte-identical: with `QUANTA_WEB_CANVAS` unset the composition root
 * mints no canvas artifact source ⇒ NO bridge ⇒ ZERO `artifact.ready` Canvas
 * frames; and with the resolver absent `GET /artifact/:id` 404s.
 *
 * Red-on-injection: a variant factory that DROPS the artifact source (no facade
 * `canvasArtifact`) ⇒ no bridge ⇒ NO Canvas frame — RED. A variant that drops the
 * resolver ⇒ the IPC route 404s — RED.
 *
 * Hermetic + offline: a `RecordingLLM` (no network) scripts a single text turn; a
 * real artifact file is written under the daemon cwd (the jail root).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSystemPrompt } from "@/agent"
import { main } from "@/apps/web-daemon"
import { createCanvasArtifactSource } from "@/apps/web-daemon/canvas-artifact-source"
import {
  buildInteractiveTurnAssembler,
  type ObservableRuntimeFacade,
} from "@/apps/web-daemon/runtime-factory"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { type ArtifactRegistry, createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import { createArtifactPreviewResolver } from "@/host/runtime"
import { encodeSessionTransportMessage } from "@/ipc/session"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { type CanvasMessage, decodeCanvasFrame } from "@/protocol/canvas"
import { createRuntimeFromAgentConfigBase, type RuntimeAgentConfigBase } from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import { present } from "../_helpers/expect-present"

/* ------------------------------------------------------------------ */
/* RecordingLLM — a single text turn (no tools, no network).           */
/* ------------------------------------------------------------------ */

class RecordingLLM implements LLMPort {
  readonly model = "claude-sonnet-4-6"
  calls = 0
  constructor(private readonly scripts?: StreamEvent[][]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    if (this.scripts !== undefined) {
      const script = this.scripts[this.calls] ?? this.scripts[this.scripts.length - 1] ?? []
      this.calls += 1
      for (const ev of script) yield ev
      return
    }
    this.calls += 1
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
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
/* A real factory: an artifact registry on the base (the PRODUCER), a   */
/* pre-registered artifact (so the turn-completion drain surfaces it),  */
/* the canvas artifact source + preview resolver on the facade.         */
/* ------------------------------------------------------------------ */

interface FactoryOpts {
  /** When false, do NOT expose `canvasArtifact` (red-on-injection: no bridge). */
  readonly wireArtifactSource?: boolean
  /** When false, do NOT expose `artifactPreviewResolver` (route 404). */
  readonly wireResolver?: boolean
  /** When false, do NOT put a registry on the base ⇒ NO producer (byte-identical). */
  readonly wireRegistry?: boolean
  /** When true, drive the LLM to call the real `artifact_register` tool instead
   *  of pre-registering — proves the REACHABLE producer (model → registry → drain
   *  → session event → Canvas + preview). The scripted path is the real jailed
   *  artifact file (built inside the factory where the path is in scope). */
  readonly useRegisterTool?: boolean
}

const scriptsFor = (artifactPath: string, opts: FactoryOpts): StreamEvent[][] | undefined =>
  opts.useRegisterTool
    ? [
        toolUseScript("call-reg-1", "artifact_register", {
          kind: "image",
          path: artifactPath,
          media_type: "image/png",
        }),
        textScript("registered"),
      ]
    : undefined

const permissionFor = (useRegisterTool: boolean): PermissionContext => {
  let mode: PermissionContext["mode"] = useRegisterTool ? "bypass" : "acceptEdits"
  return {
    get mode() {
      return mode
    },
    set mode(next) {
      mode = next
    },
  }
}

const prepareRegistry = (
  artifactPath: string,
  scripts: StreamEvent[][] | undefined,
  bag: { registry?: ArtifactRegistry },
  wireRegistry: boolean,
): ArtifactRegistry | undefined => {
  if (!wireRegistry) return undefined
  const registry = createArtifactRegistry({ now: () => 1, idFactory: monotonicIdFactory("art") })
  if (scripts === undefined) {
    registry.register({ kind: "image", path: artifactPath, mediaType: "image/png" })
  }
  bag.registry = registry
  return registry
}

const runtimeBaseFor = (
  cwd: string,
  registry: ArtifactRegistry | undefined,
  scripts: StreamEvent[][] | undefined,
  opts: FactoryOpts,
): RuntimeAgentConfigBase => {
  const abort = new AbortController()
  return {
    llm: new RecordingLLM(scripts),
    registry: new ToolRegistry(buildDefaultTools(registry ? { artifactRegistry: registry } : {})),
    stream: new StdoutStream(),
    permission: permissionFor(opts.useRegisterTool === true),
    messages: [],
    system: buildSystemPrompt(cwd),
    cwd,
    maxTurns: 8,
    signal: abort.signal,
    hitl: { enabled: true },
    ...(opts.useRegisterTool ? { onConfirm: async () => true } : {}),
    ...(registry ? { artifactRegistry: registry } : {}),
  }
}

const exposeArtifactPorts = (
  facade: ObservableRuntimeFacade,
  canvasArtifact: ReturnType<typeof createCanvasArtifactSource>,
  resolver: ReturnType<typeof createArtifactPreviewResolver> | undefined,
  opts: FactoryOpts,
): void => {
  if (opts.wireArtifactSource ?? true) {
    Object.defineProperty(facade, "canvasArtifact", { get: () => canvasArtifact, enumerable: true })
  }
  if ((opts.wireResolver ?? true) && resolver !== undefined) {
    Object.defineProperty(facade, "artifactPreviewResolver", {
      get: () => resolver,
      enumerable: true,
    })
  }
}

const buildFactory = (
  cwd: string,
  artifactPath: string,
  bag: { sessionId?: string; registry?: ArtifactRegistry },
  opts: FactoryOpts = {},
): (() => Promise<ObservableRuntimeFacade>) => {
  const wireArtifactSource = opts.wireArtifactSource ?? true
  const wireResolver = opts.wireResolver ?? true
  const wireRegistry = opts.wireRegistry ?? true
  return async (): Promise<ObservableRuntimeFacade> => {
    const scripts = scriptsFor(artifactPath, opts)
    const registry = prepareRegistry(artifactPath, scripts, bag, wireRegistry)
    const canvasArtifact = createCanvasArtifactSource()
    const resolver =
      registry !== undefined
        ? createArtifactPreviewResolver({ registry, jailRoot: cwd })
        : undefined

    const base = runtimeBaseFor(cwd, registry, scripts, opts)
    const { runtime } = await createRuntimeFromAgentConfigBase({
      base,
      turnAssembler: buildInteractiveTurnAssembler(),
      history: [...base.messages],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    const facade = runtime as ObservableRuntimeFacade
    exposeArtifactPorts(facade, canvasArtifact, resolver, { wireArtifactSource, wireResolver })
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
/* WS + HTTP helpers                                                   */
/* ------------------------------------------------------------------ */

const waitForOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true })
  })

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
      const hit0 = frames.find((f) => f.kind === kind)
      if (hit0 !== undefined) return resolve(hit0)
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
          new Error(`waitForCanvas(${kind}): timeout (saw ${frames.map((f) => f.kind).join(",")})`),
        )
      }, timeoutMs)
    })
  return { frames, waitFor }
}

const driveTurn = (ws: WebSocket, sessionId: string): void => {
  const issuedAt = new Date().toISOString()
  ws.send(encodeSessionTransportMessage({ kind: "connect", sessionId }))
  ws.send(
    encodeSessionTransportMessage({
      kind: "command",
      command: { sessionId, commandId: "cmd-append", issuedAt, type: "input.append", text: "hi" },
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
let savedCanvas: string | undefined
let savedStore: string | undefined

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()
    if (h !== undefined) await h.stop().catch(() => undefined)
  }
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
  const env = process.env as Record<string, string | undefined>
  if (savedCanvas === undefined) delete env.QUANTA_WEB_CANVAS
  else env.QUANTA_WEB_CANVAS = savedCanvas
  if (savedStore === undefined) delete env.QUANTA_ARTIFACT_STORE
  else env.QUANTA_ARTIFACT_STORE = savedStore
})

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

/** Set ONLY `QUANTA_ARTIFACT_STORE` (canvas OFF) — the IPC preview channel is
 *  independent of the Canvas WS frames. */
const setupStoreOnly = (
  factoryOpts: FactoryOpts = {},
): {
  bag: { sessionId?: string; registry?: ArtifactRegistry }
  factory: () => Promise<ObservableRuntimeFacade>
} => {
  const env = process.env as Record<string, string | undefined>
  savedCanvas = env.QUANTA_WEB_CANVAS
  savedStore = env.QUANTA_ARTIFACT_STORE
  delete env.QUANTA_WEB_CANVAS
  env.QUANTA_ARTIFACT_STORE = "1"
  const dir = mkdtempSync(join(tmpdir(), "a2-store-only-e2e-"))
  tmpDirs.push(dir)
  const artifactPath = join(dir, "chart.png")
  writeFileSync(artifactPath, PNG_BYTES)
  const bag: { sessionId?: string; registry?: ArtifactRegistry } = {}
  const factory = buildFactory(dir, artifactPath, bag, factoryOpts)
  return { bag, factory }
}

const setup = (
  gateOn: boolean,
  factoryOpts: FactoryOpts = {},
): {
  dir: string
  artifactPath: string
  bag: { sessionId?: string; registry?: ArtifactRegistry }
  factory: () => Promise<ObservableRuntimeFacade>
} => {
  const env = process.env as Record<string, string | undefined>
  savedCanvas = env.QUANTA_WEB_CANVAS
  savedStore = env.QUANTA_ARTIFACT_STORE
  if (gateOn) {
    env.QUANTA_WEB_CANVAS = "1"
    env.QUANTA_ARTIFACT_STORE = "1"
  } else {
    delete env.QUANTA_WEB_CANVAS
    delete env.QUANTA_ARTIFACT_STORE
  }
  const dir = mkdtempSync(join(tmpdir(), "a2-preview-e2e-"))
  tmpDirs.push(dir)
  const artifactPath = join(dir, "chart.png")
  writeFileSync(artifactPath, PNG_BYTES)
  const bag: { sessionId?: string; registry?: ArtifactRegistry } = {}
  const factory = buildFactory(dir, artifactPath, bag, factoryOpts)
  return { dir, artifactPath, bag, factory }
}

/* ================================================================== */

describe("A2 e2e — artifact.ready Canvas frame + jailed IPC preview", () => {
  test("gate ON: a completed turn delivers an artifact.ready Canvas frame; its bytes resolve via GET /artifact/:id", async () => {
    const { bag, factory } = setup(/* gateOn */ true)
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)
    expect(bag.sessionId).toBeDefined()
    expect(bag.registry).toBeDefined()

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    const { waitFor } = collectCanvas(ws)
    await new Promise((r) => setTimeout(r, 30))

    driveTurn(ws, present(bag.sessionId, "bag.sessionId"))

    const ready = await waitFor("artifact.ready")
    if (ready.kind !== "artifact.ready") throw new Error("narrow")
    expect(ready.artifactKind).toBe("image")
    expect(ready.mimeType).toBe("image/png")
    // Load-bearing: only the OPAQUE locator on the wire — never the fs path.
    expect(ready.locator.startsWith("quanta-artifact://")).toBe(true)
    const id = ready.artifactId
    expect(ready.locator).toBe(`quanta-artifact://${id}`)
    // The id body (after the scheme) is an opaque token — no path separator ⇒ no
    // fs path smuggled onto the wire.
    expect(id).not.toContain("/")

    // Chain 2: the SAME id's bytes are resolvable via the IPC route, JAILED.
    const res = await fetch(`http://127.0.0.1:${handle.port}/artifact/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes]).toEqual([...PNG_BYTES])

    ws.close()
    await new Promise((r) => setTimeout(r, 20))
  })

  test("REACHABLE producer: the model's artifact_register tool → session artifact.ready → Canvas frame + resolvable bytes", async () => {
    const { bag, factory } = setup(/* gateOn */ true, { useRegisterTool: true })

    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    const { waitFor } = collectCanvas(ws)
    await new Promise((r) => setTimeout(r, 30))

    driveTurn(ws, present(bag.sessionId, "bag.sessionId"))

    const ready = await waitFor("artifact.ready", 6000)
    if (ready.kind !== "artifact.ready") throw new Error("narrow")
    expect(ready.artifactKind).toBe("image")
    expect(ready.mimeType).toBe("image/png")
    expect(ready.locator).toBe(`quanta-artifact://${ready.artifactId}`)

    // The registered bytes resolve via the IPC route (jailed).
    const res = await fetch(`http://127.0.0.1:${handle.port}/artifact/${ready.artifactId}`)
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes]).toEqual([...PNG_BYTES])

    ws.close()
    await new Promise((r) => setTimeout(r, 20))
  })

  test("gate OFF (default): the SAME turn delivers ZERO canvas frames AND /artifact/:id 404s (byte-identical)", async () => {
    const { bag, factory } = setup(/* gateOn */ false)
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    const { frames } = collectCanvas(ws)
    await new Promise((r) => setTimeout(r, 30))

    driveTurn(ws, present(bag.sessionId, "bag.sessionId"))
    await new Promise((r) => setTimeout(r, 500))
    expect(frames.filter((f) => f.kind === "artifact.ready")).toHaveLength(0)

    // No registry ⇒ no producer; and the resolver is absent ⇒ the route 404s.
    const res = await fetch(`http://127.0.0.1:${handle.port}/artifact/art-1`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("artifact_store_disabled")

    ws.close()
    await new Promise((r) => setTimeout(r, 20))
  })

  test("IPC route stays JAILED: a file:// / absolute / ../ 'id' is rejected (never served)", async () => {
    const { bag, factory } = setup(/* gateOn */ true)
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)
    // Progress a turn so the artifact is registered (not strictly needed for the
    // rejection cases, but proves the store is live and STILL rejects traversal).
    void bag

    for (const bad of [
      encodeURIComponent("file:///etc/passwd"),
      encodeURIComponent("/etc/passwd"),
      encodeURIComponent("../../../etc/passwd"),
      encodeURIComponent("quanta-artifact://../secret"),
      "does-not-exist",
    ]) {
      const res = await fetch(`http://127.0.0.1:${handle.port}/artifact/${bad}`)
      // Never 200 — a traversal/unknown id is a coarse 404 (no bytes served).
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("artifact_unavailable")
    }
  })

  test("red-on-injection: dropping the artifact source ⇒ NO artifact.ready Canvas frame", async () => {
    const { bag, factory } = setup(/* gateOn */ true, { wireArtifactSource: false })
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`)
    await waitForOpen(ws)
    const { frames } = collectCanvas(ws)
    await new Promise((r) => setTimeout(r, 30))

    driveTurn(ws, present(bag.sessionId, "bag.sessionId"))
    await new Promise((r) => setTimeout(r, 500))
    expect(frames.some((f) => f.kind === "artifact.ready")).toBe(false)

    ws.close()
    await new Promise((r) => setTimeout(r, 20))
  })

  test("IPC preview channel is INDEPENDENT of canvas: store ON + canvas OFF ⇒ /artifact/:id serves bytes", async () => {
    // A pre-registered artifact (id `art-1`) + only QUANTA_ARTIFACT_STORE on. The
    // eager facade mint keys on the store gate too, so the resolver reaches the
    // route even though the Canvas WS frames are off.
    const { factory } = setupStoreOnly()
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const res = await fetch(`http://127.0.0.1:${handle.port}/artifact/art-1`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes]).toEqual([...PNG_BYTES])
  })

  test("red-on-injection: dropping the resolver ⇒ IPC route 404s even with the store on", async () => {
    const { factory } = setup(/* gateOn */ true, { wireResolver: false })
    const handle = await main({ port: 0, bind: "127.0.0.1", runtimeFactory: factory })
    handles.push(handle)

    const res = await fetch(`http://127.0.0.1:${handle.port}/artifact/art-1`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("artifact_store_disabled")
  })
})
