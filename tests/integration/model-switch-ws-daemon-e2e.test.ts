/**
 * ★ E2E — a `set_model` controlRequest over a REAL WebSocket into a REAL
 * `startWebDaemon` actually CHANGES THE MODEL (aug-27).
 *
 * The sibling `control-request-surface-ws-daemon-e2e.test.ts` pins the transport
 * boundary for `set_permission_mode` — and documents that the model axis was
 * observe-only ("no live model-swap cell on the daemon"). That was true: a
 * client could send `set_model`, see it echoed, and keep talking to the old
 * model. This file pins the closed loop for the MODEL axis at the same real
 * boundary:
 *
 *   real `new WebSocket` frame → Bun `websocket.message()` → the daemon's real
 *   `ws-handlers` → `consumeControlRequestFrame` → `peekControlRequest` → the
 *   REAL `WebControlRequestPortHandle.enqueue` → `drainControlRequests` (the
 *   byte-identical call the loop's `pollControlRequests` makes) → the REAL
 *   `web-model-switch` applier PERSISTS the pick → the LOOP's own
 *   `readStickyModelForMode` reads it back and `resolveSkillTurnOverride`
 *   resolves it to THAT model's port.
 *
 * Same honest caveat as the sibling: we stand up no LLM-driven agent loop (the
 * daemon session is the hermetic stub), so the drain is invoked explicitly — one
 * hop short of the loop's own poll tick, which the unit hellgate covers with the
 * real per-turn base slots.
 *
 * HERMETIC: `QUANTA_CONFIG_DIR` → a scratch dir (the sticky file never lands in
 * the developer's `~/.quanta`), `QUANTA_WEB_DB=off`, no network (the catalog is a
 * stub `listModels` on the boot port — the real provider probe is covered by the
 * live-CLI measurement, not by an offline test).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { type ControlEffect, drainControlRequests } from "@/agent/control-request"
import { readStickyModelForMode, resolveSkillTurnOverride } from "@/agent/loop/skill-gate"
import { startWebDaemon, type WebDaemonServerConfig } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import {
  createWebControlRequestPort,
  type WebControlRequestPortHandle,
} from "@/apps/web-daemon/web-control-request-port"
import { createWebModelSwitch } from "@/apps/web-daemon/web-model-switch"
import type { LLMPort, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import { supported } from "@/protocol/session"
import { createStubRuntimeFactory } from "../unit/apps/web-daemon/fixture"

const handles: WebDaemonHandle[] = []
const sockets: WebSocket[] = []

const prevWebDb = process.env.QUANTA_WEB_DB
beforeAll(() => {
  process.env.QUANTA_WEB_DB = "off"
})
afterAll(() => {
  if (prevWebDb === undefined) delete process.env.QUANTA_WEB_DB
  else process.env.QUANTA_WEB_DB = prevWebDb
})

let priorConfigDir: string | undefined
let home = ""
beforeEach(() => {
  priorConfigDir = process.env.QUANTA_CONFIG_DIR
  home = mkdtempSync(join(tmpdir(), "web-model-e2e-"))
  process.env.QUANTA_CONFIG_DIR = home
})

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

afterEach(async () => {
  // Remove this case's scratch home (a leaked dir per case is a measured hazard).
  if (home.length > 0) rmSync(home, { recursive: true, force: true })
  while (sockets.length > 0) {
    const s = sockets.pop()
    try {
      s?.close()
    } catch {
      // already closed
    }
  }
  while (handles.length > 0) {
    const h = handles.pop()
    if (h !== undefined) await withTimeout(h.stop(), 5000, "daemon.stop").catch(() => undefined)
  }
  if (priorConfigDir === undefined) delete process.env.QUANTA_CONFIG_DIR
  else process.env.QUANTA_CONFIG_DIR = priorConfigDir
})

const liveProxy = (): PermissionContext => {
  let mode: PermissionContext["mode"] = "default"
  return {
    get mode() {
      return mode
    },
    set mode(next) {
      mode = next
    },
  }
}

/** The daemon's boot port with a STUB provider catalog (offline). */
const bootPort = (): LLMPort => ({
  model: "boot-model",
  listModels: async () => ["boot-model", "gpt-4o"],
  stream: async function* (): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

const boot = async (extra: Partial<WebDaemonServerConfig>): Promise<WebDaemonHandle> => {
  const { factory } = createStubRuntimeFactory()
  const handle = await startWebDaemon({
    port: 0,
    bind: "127.0.0.1",
    authToken: undefined,
    runtimeFactory: factory,
    sessionConfig: {},
    supportedReadModels: {
      session: supported("session.v1"),
      agentState: { status: "unsupported" },
      canvas: { status: "unsupported" },
      observability: { status: "unsupported" },
    },
    ...extra,
  })
  handles.push(handle)
  return handle
}

const connect = (handle: WebDaemonHandle): { ws: WebSocket; open: Promise<void> } => {
  const ws = new WebSocket(`ws://${handle.hostname}:${handle.port}/`)
  sockets.push(ws)
  const open = new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true })
  })
  return { ws, open }
}

const controlFrame = (request: unknown): string =>
  JSON.stringify({ kind: "controlRequest", request })

const until = async (
  pred: () => boolean,
  { timeoutMs = 2000, stepMs = 10 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return pred()
}

const yieldLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

/** Poll the LOOP's own read (`readStickyModelForMode`) until it reports `expected`
 *  or the deadline lapses — the applier is sync + fire-and-forget by contract, so
 *  the observable effect is what a test may wait on (never a fixed sleep). */
const untilSticky = async (
  cfg: AgentConfig,
  expected: string,
  timeoutMs = 3000,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs
  let seen = await readStickyModelForMode(cfg)
  while (seen !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
    seen = await readStickyModelForMode(cfg)
  }
  return seen
}

/** The production wiring: the REAL model switch behind the REAL port. */
const wireSwitch = async () => {
  const llm = bootPort()
  const modelSwitch = createWebModelSwitch({
    env: { ...process.env, OPENAI_API_KEY: "sk-test-not-used" } as Record<
      string,
      string | undefined
    >,
    provider: "openai",
    llm,
  })
  // The `/model` readout's lazy probe — done here so the candidate set (and thus
  // the live allowlist) holds the switchable model before the client asks.
  await modelSwitch.refresh()
  const handle = createWebControlRequestPort({
    permission: liveProxy(),
    applyModel: modelSwitch.applyModel,
    modelAllowlist: () => modelSwitch.ids(),
  })
  /** The per-turn `AgentConfig` slice the daemon's base carries. */
  const cfg = {
    llm,
    // Mirrors the daemon base: the slot carries the PROVIDER half of the key.
    stickyModelStore: { store: modelSwitch.store, provider: modelSwitch.provider },
    modelCandidates: modelSwitch.candidates,
  } as unknown as AgentConfig
  return { llm, modelSwitch, handle, cfg }
}

const drain = (handle: WebControlRequestPortHandle): ControlEffect[] =>
  drainControlRequests(handle.port, handle.context, handle.applier)

describe("web daemon set_model over a REAL socket changes the model the loop runs", () => {
  test("frame → enqueue → drain ⇒ the pick is PERSISTED and resolves to that model's PORT", async () => {
    const w = await wireSwitch()
    const daemon = await boot({ controlRequestPorts: { handle: w.handle } })
    const { ws, open } = connect(daemon)
    await open
    await yieldLoop()

    ws.send(controlFrame({ kind: "set_model", model: "gpt-4o" }))
    expect(await until(() => w.handle.pendingCount() > 0)).toBe(true)

    const effects = drain(w.handle)
    expect(effects).toEqual([{ kind: "model-set", model: "gpt-4o" }])

    // The write is fire-and-forget, so poll the thing the LOOP actually reads (the
    // session cell) rather than sleeping — and only then assert the durable file,
    // which the write-through store updates FIRST (cell second, so that a rejected
    // write never leaves a phantom pick behind).
    expect(await untilSticky(w.cfg, "gpt-4o")).toBe("gpt-4o")
    expect(readFileSync(join(home, "sticky-model.json"), "utf8")).toContain("gpt-4o")
    const resolved = resolveSkillTurnOverride(w.cfg, undefined, "gpt-4o")
    expect(resolved.llm).not.toBe(w.llm)
    expect(resolved.llm.model).toBe("gpt-4o")
  })

  test("CONTROL — an off-catalog model is rejected at the planner: nothing is persisted", async () => {
    const w = await wireSwitch()
    const daemon = await boot({ controlRequestPorts: { handle: w.handle } })
    const { ws, open } = connect(daemon)
    await open
    await yieldLoop()

    ws.send(controlFrame({ kind: "set_model", model: "not-in-the-catalog" }))
    expect(await until(() => w.handle.pendingCount() > 0)).toBe(true)
    expect(drain(w.handle)[0]?.kind).toBe("rejected")
    await yieldLoop()
    expect(await readStickyModelForMode(w.cfg)).toBeUndefined()
  })

  test("CONTROL — no control-request ports wired ⇒ the frame never reaches the port (byte-identical)", async () => {
    const w = await wireSwitch()
    const daemon = await boot({})
    const { ws, open } = connect(daemon)
    await open
    await yieldLoop()

    ws.send(controlFrame({ kind: "set_model", model: "gpt-4o" }))
    await yieldLoop()
    expect(w.handle.pendingCount()).toBe(0)
    expect(drain(w.handle)).toEqual([])
    expect(await readStickyModelForMode(w.cfg)).toBeUndefined()
  })
})
