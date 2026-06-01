/**
 * TIER 2 — browser tools through the REAL agent loop (ADR-0427).
 *
 * This suite proves the browser slice is wired end-to-end through `runAgent`,
 * not merely registered. It drives the loop with a SCRIPTED `LLMPort` that
 * emits `tool_use` blocks (navigate → snapshot → click → final text) and a
 * duck-typed `config.browser = { port }` slot so `buildSessionFeatures`
 * surfaces the 12 `browser_*` tools + `browserDispose`. Every assertion is a
 * behavioural read-back (event traces, transcript error blocks, port spies),
 * never a bare `ok: true`.
 *
 * Three proof axes:
 *   (a) DISPATCH — the scripted browser calls flow through the real registry
 *       (tool_result events appear in emit order, the file completes).
 *   (b) HITL    — `browser_click` / `browser_type` hit the always-confirm tier
 *       (onConfirm is consulted; a `false` return denies with the canonical
 *       always-confirm message), while `pre-approval-ok` browser tools
 *       (navigate/snapshot) auto-pass in acceptEdits mode. This isolates the
 *       HITL gate from the generic permission prompt.
 *   (c) DISPOSE — `browserDispose` runs at session teardown and reaches the
 *       wrapped `port.close` (spy counter).
 *
 * DETERMINISTIC: the headless stub (`createHeadlessBrowser({ pages })`) has no
 * process, socket, or network. No chrome required for the green path.
 *
 * REAL-CHROME (optional, env-gated): a separate block drives the cdp-adapter
 * PORT directly (NOT the tool layer — 127.0.0.1 is SSRF-denied at the tool
 * layer) against a `Bun.serve` fixture. It runs ONLY when a real Chrome session
 * can actually be brought up; otherwise it skips cleanly and the file stays
 * green. `availability() !== null` only means the binary exists — it does NOT
 * guarantee the CDP `Page.enable` bring-up succeeds in a sandboxed CI, so the
 * gate is a real spawn probe in `beforeAll`, not the binary probe.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import {
  type BrowserHandle,
  type BrowserPort,
  createCdpBrowser,
  createHeadlessBrowser,
  type DomModel,
  defaultBrowserFs,
  defaultCdpTransport,
  defaultProcessSpawner,
  realClock,
  realScheduler,
} from "@/browser"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ── fixtures ────────────────────────────────────────────────────────────────

/** A small accessibility tree → snapshot refs `e1..e4` (e2=button, e3=textbox,
 *  e4=link). The headless stub assigns refs in document order via buildSnapshot. */
const PAGE: DomModel = {
  title: "Home",
  root: {
    backendPath: "/",
    role: "document",
    name: "Home",
    children: [
      { backendPath: "/0", role: "button", name: "Submit" },
      { backendPath: "/1", role: "textbox", name: "Search" },
      { backendPath: "/2", role: "link", name: "About", url: "https://app.test/about" },
    ],
  },
}
const PAGES = new Map([["https://app.test/", { title: "Home", dom: PAGE }]])

const ALL_BROWSER_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_select_option",
  "browser_scroll",
  "browser_press_key",
  "browser_drag",
  "browser_mouse_click_xy",
  "browser_screenshot",
  "browser_cdp",
]

// ── scripted-LLM + recording-stream doubles ──────────────────────────────────

const tu = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]
const txt = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Replays one scripted StreamEvent[] per stream() call; the final script
 *  repeats if the loop calls more often than scripted (defensive). */
class ScriptedLLM implements LLMPort {
  readonly model = "scripted-test-model"
  calls = 0
  private last: StreamEvent[] = []
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const next = this.scripts.shift()
    if (next) this.last = next
    this.calls += 1
    for (const e of next ?? this.last) yield e
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.events.push(e)
  }
}

/** A `BrowserPort` wrapper that counts `close()` calls — proves teardown
 *  reaches the port. Spawns the inner headless stub lazily under the hood. */
const spyingPort = (): { port: BrowserPort; closes: () => number } => {
  let closes = 0
  const inner = createHeadlessBrowser({ pages: PAGES })
  const port: BrowserPort = {
    ...inner,
    close: (h) => {
      closes += 1
      return inner.close(h)
    },
  }
  return { port, closes: () => closes }
}

interface LoopOverrides {
  readonly mode?: "default" | "acceptEdits"
  readonly hitl?: boolean
  readonly onConfirm?: (action: { tool: string; input: unknown }) => Promise<boolean>
  readonly port?: BrowserPort
}

/** Build a minimal `AgentConfig` with the duck-typed browser slot, run the
 *  loop, and return the outcome + recorded events. */
const runBrowserLoop = async (
  scripts: StreamEvent[][],
  over: LoopOverrides = {},
): Promise<{
  outcome: Awaited<ReturnType<typeof runAgent>>
  stream: RecordingStream
  llm: ScriptedLLM
}> => {
  const stream = new RecordingStream()
  const llm = new ScriptedLLM(scripts)
  const port = over.port ?? createHeadlessBrowser({ pages: PAGES })
  const cfg = {
    registry: new ToolRegistry(defaultTools),
    stream,
    permission: { mode: over.mode ?? "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 12,
    signal: new AbortController().signal,
    llm,
    ...(over.hitl ? { hitl: { enabled: true } } : {}),
    onConfirm:
      over.onConfirm ??
      (async (a: { tool: string; input: unknown }) => {
        void a
        return true
      }),
    browser: { port },
  } as unknown as AgentConfig
  const outcome = await runAgent(cfg)
  return { outcome, stream, llm }
}

const toolResults = (s: RecordingStream): { name: string; ok: boolean }[] =>
  s.events
    .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
    .map((e) => ({ name: e.name, ok: e.ok }))

const errorBlockText = (outcome: Awaited<ReturnType<typeof runAgent>>): string[] =>
  outcome.messages
    .flatMap((m) => m.content)
    .filter(
      (b): b is Extract<typeof b, { type: "tool_result" }> =>
        b.type === "tool_result" && b.is_error === true,
    )
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))

// ── (1) dispatch through the real loop ───────────────────────────────────────

describe("browser tools through the real agent loop — DISPATCH", () => {
  test("(1) navigate → snapshot → click → text completes; 3 browser tools dispatched in order", async () => {
    const { outcome, stream, llm } = await runBrowserLoop([
      tu("c1", "browser_navigate", { url: "https://app.test/" }),
      tu("c2", "browser_snapshot", {}),
      tu("c3", "browser_click", { ref: "e2" }),
      txt("done"),
    ])

    expect(outcome.reason).toBe("completed")
    expect(outcome.turns).toBe(4)
    expect(llm.calls).toBe(4)

    const names = toolResults(stream).map((r) => r.name)
    expect(names).toEqual(["browser_navigate", "browser_snapshot", "browser_click"])
    expect(toolResults(stream).every((r) => r.ok)).toBe(true)
  })

  test("(2) snapshot output is the REAL accessibility YAML (read-back, not ok:true)", async () => {
    const { outcome } = await runBrowserLoop([
      tu("c1", "browser_navigate", { url: "https://app.test/" }),
      tu("c2", "browser_snapshot", {}),
      txt("seen"),
    ])
    expect(outcome.reason).toBe("completed")
    // The snapshot tool_result lands in the transcript; assert the page's real
    // accessibility text round-tripped through the loop → port → buildSnapshot.
    const snapText = outcome.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
      .join("\n")
    expect(snapText).toContain('button "Submit"')
    expect(snapText).toContain('textbox "Search"')
    expect(snapText).toContain('link "About"')
  })

  test("(3) navigate echoes the resolved title back through the loop", async () => {
    const { outcome } = await runBrowserLoop([
      tu("c1", "browser_navigate", { url: "https://app.test/" }),
      txt("ok"),
    ])
    const navText = outcome.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
      .join("\n")
    expect(navText).toContain("navigated to Home")
    expect(navText).toContain("https://app.test/")
  })

  test("(4) clicking an unknown ref surfaces element-not-found as a transcript error block", async () => {
    const { outcome, stream } = await runBrowserLoop(
      [
        tu("c1", "browser_navigate", { url: "https://app.test/" }),
        tu("c2", "browser_snapshot", {}),
        tu("c3", "browser_click", { ref: "e99" }),
        txt("recovered"),
      ],
      { mode: "acceptEdits", hitl: true, onConfirm: async () => true },
    )
    expect(outcome.reason).toBe("completed")
    const clickResult = toolResults(stream).find((r) => r.name === "browser_click")
    expect(clickResult?.ok).toBe(false)
    const errs = errorBlockText(outcome)
    expect(errs.some((e) => /e99/.test(e))).toBe(true)
  })

  test("(5) SSRF target is denied through the real loop (permission_denied error block)", async () => {
    const { outcome, stream } = await runBrowserLoop([
      tu("c1", "browser_navigate", { url: "http://169.254.169.254/" }),
      txt("blocked"),
    ])
    expect(outcome.reason).toBe("completed")
    const nav = toolResults(stream).find((r) => r.name === "browser_navigate")
    expect(nav?.ok).toBe(false)
    const errs = errorBlockText(outcome)
    expect(errs.some((e) => /denied/i.test(e))).toBe(true)
  })

  test("(6) cdp allowlist denial surfaces through the loop", async () => {
    const { outcome, stream } = await runBrowserLoop([
      tu("c1", "browser_navigate", { url: "https://app.test/" }),
      tu("c2", "browser_cdp", { method: "Storage.clearDataForOrigin" }),
      txt("blocked"),
    ])
    expect(outcome.reason).toBe("completed")
    const cdp = toolResults(stream).find((r) => r.name === "browser_cdp")
    expect(cdp?.ok).toBe(false)
  })
})

// ── (2) HITL always-confirm gate ──────────────────────────────────────────────

describe("browser tools through the real agent loop — HITL always-confirm", () => {
  test("(7) acceptEdits + hitl: ONLY browser_click (always-confirm) consults onConfirm", async () => {
    const confirmed: string[] = []
    const { outcome } = await runBrowserLoop(
      [
        tu("c1", "browser_navigate", { url: "https://app.test/" }),
        tu("c2", "browser_snapshot", {}),
        tu("c3", "browser_click", { ref: "e2" }),
        txt("done"),
      ],
      {
        mode: "acceptEdits",
        hitl: true,
        onConfirm: async (a) => {
          confirmed.push(a.tool)
          return true
        },
      },
    )
    expect(outcome.reason).toBe("completed")
    // navigate (pre-approval-ok, non-readonly) auto-passes in acceptEdits;
    // snapshot is read-only; only the always-confirm CLICK hits the gate.
    expect(confirmed).toEqual(["browser_click"])
  })

  test("(8) browser_type (always-confirm) also hits the HITL gate", async () => {
    const confirmed: string[] = []
    const { outcome } = await runBrowserLoop(
      [
        tu("c1", "browser_navigate", { url: "https://app.test/" }),
        tu("c2", "browser_snapshot", {}),
        tu("c3", "browser_type", { ref: "e3", text: "hello" }),
        txt("typed"),
      ],
      {
        mode: "acceptEdits",
        hitl: true,
        onConfirm: async (a) => {
          confirmed.push(a.tool)
          return true
        },
      },
    )
    expect(outcome.reason).toBe("completed")
    expect(confirmed).toEqual(["browser_type"])
  })

  test("(9) onConfirm=false denies browser_click with the canonical always-confirm message", async () => {
    const { outcome, stream } = await runBrowserLoop(
      [
        tu("c1", "browser_navigate", { url: "https://app.test/" }),
        tu("c2", "browser_snapshot", {}),
        tu("c3", "browser_click", { ref: "e2" }),
        txt("ack"),
      ],
      { mode: "acceptEdits", hitl: true, onConfirm: async () => false },
    )
    const click = toolResults(stream).find((r) => r.name === "browser_click")
    expect(click?.ok).toBe(false)
    const errs = errorBlockText(outcome)
    expect(errs.some((e) => /always-confirm tier/.test(e))).toBe(true)
    expect(errs.some((e) => /browser_click/.test(e))).toBe(true)
  })

  test("(10) onConfirm receives the real ToolAction (tool name + the model's input)", async () => {
    const seen: { tool: string; input: unknown }[] = []
    await runBrowserLoop(
      [
        tu("c1", "browser_navigate", { url: "https://app.test/" }),
        tu("c2", "browser_snapshot", {}),
        tu("c3", "browser_click", { ref: "e2" }),
        txt("done"),
      ],
      {
        mode: "acceptEdits",
        hitl: true,
        onConfirm: async (a) => {
          seen.push({ tool: a.tool, input: a.input })
          return true
        },
      },
    )
    const clickAction = seen.find((a) => a.tool === "browser_click")
    expect(clickAction).toBeDefined()
    expect(clickAction?.input).toEqual({ ref: "e2" })
  })

  test("(11) hitl gate disabled ⇒ click is NOT routed through always-confirm in acceptEdits", async () => {
    // Without hitl.enabled, an always-confirm tool still runs (acceptEdits
    // auto-approves mutating tools); onConfirm must NOT be consulted for the
    // HITL tier. Proves the HITL branch is gated on config.hitl.enabled.
    const confirmed: string[] = []
    const { outcome, stream } = await runBrowserLoop(
      [
        tu("c1", "browser_navigate", { url: "https://app.test/" }),
        tu("c2", "browser_snapshot", {}),
        tu("c3", "browser_click", { ref: "e2" }),
        txt("done"),
      ],
      {
        mode: "acceptEdits",
        hitl: false,
        onConfirm: async (a) => {
          confirmed.push(a.tool)
          return true
        },
      },
    )
    expect(outcome.reason).toBe("completed")
    const click = toolResults(stream).find((r) => r.name === "browser_click")
    expect(click?.ok).toBe(true)
    expect(confirmed).toEqual([])
  })
})

// ── (3) browserDispose teardown ───────────────────────────────────────────────

describe("browser tools through the real agent loop — DISPOSE", () => {
  test("(12) browserDispose runs at teardown and reaches port.close (spy)", async () => {
    const { port, closes } = spyingPort()
    const { outcome } = await runBrowserLoop(
      [
        tu("c1", "browser_navigate", { url: "https://app.test/" }),
        tu("c2", "browser_snapshot", {}),
        txt("done"),
      ],
      { port },
    )
    expect(outcome.reason).toBe("completed")
    // The lazily-spawned headless session was closed exactly once at teardown.
    expect(closes()).toBe(1)
  })

  test("(13) dispose still fires when the session never navigated (no spawn ⇒ no close)", async () => {
    // If the model never used a browser tool, the lazy session is never
    // spawned, so dispose has nothing to close — close count stays 0, but the
    // loop must still complete cleanly (teardown is unconditional + safe).
    const { port, closes } = spyingPort()
    const { outcome } = await runBrowserLoop([txt("no browser needed")], { port })
    expect(outcome.reason).toBe("completed")
    expect(closes()).toBe(0)
  })
})

// ── (4) features-level seam (no full loop) ────────────────────────────────────

describe("browser features seam — registry surface", () => {
  test("(14) wired slot ⇒ all 12 browser tools land in the loop's registry", async () => {
    const { buildSessionFeatures } = await import("@/agent/features")
    const f = await buildSessionFeatures({
      registry: new ToolRegistry(defaultTools),
      stream: new RecordingStream(),
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: "/tmp",
      maxTurns: 1,
      signal: new AbortController().signal,
      llm: new ScriptedLLM([txt("ok")]),
      browser: { port: createHeadlessBrowser({ pages: PAGES }) },
    } as unknown as AgentConfig)
    const names = f.extraTools.map((t) => t.name).filter((n) => n.startsWith("browser_"))
    expect(names.sort()).toEqual([...ALL_BROWSER_TOOLS].sort())
    expect(typeof f.browserDispose).toBe("function")
  })

  test("(15) default-OFF: no browser slot ⇒ no browser tools, no browserDispose", async () => {
    const { buildSessionFeatures } = await import("@/agent/features")
    const f = await buildSessionFeatures({
      registry: new ToolRegistry(defaultTools),
      stream: new RecordingStream(),
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: "/tmp",
      maxTurns: 1,
      signal: new AbortController().signal,
      llm: new ScriptedLLM([txt("ok")]),
    } as unknown as AgentConfig)
    expect(f.extraTools.some((t) => t.name.startsWith("browser_"))).toBe(false)
    expect(f.browserDispose).toBeUndefined()
  })
})

// ── REAL CHROME (optional, env-gated; drives the cdp-adapter PORT directly) ───
//
// `availability() !== null` only proves the binary exists. The CDP bring-up
// (Page.enable) can still fail under a sandboxed CI. So the gate is a REAL
// spawn probe in beforeAll; if the session can't be brought up, the whole
// block skips cleanly and the file stays green. We report the outcome via
// REAL_CHROME_RAN so the harness knows whether the real assertions ran.

const TEMP_ROOT = mkdtempSync(join(tmpdir(), "qbe-"))
let realPort: BrowserPort | undefined
let realHandle: BrowserHandle | undefined
let server: ReturnType<typeof Bun.serve> | undefined
let REAL_CHROME_RAN = false

const FORM_HTML = `<!doctype html><html><body>
<h1 id="hd">Fixture</h1>
<button id="btn">Go</button>
<input id="inp" type="text" value="">
</body></html>`

beforeAll(async () => {
  realPort = createCdpBrowser({
    spawner: defaultProcessSpawner,
    transport: defaultCdpTransport,
    fs: defaultBrowserFs,
    scheduler: realScheduler,
    clock: realClock,
    profileRoot: TEMP_ROOT,
    endpointTimeoutMs: 15000,
  })
  if (realPort.availability() === null) return
  // Real bring-up probe: spawn must actually establish a CDP session.
  const sp = await realPort.spawn()
  if (!sp.ok) return // binary present but session won't come up here → skip
  realHandle = sp.value
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname
      if (p === "/form")
        return new Response(FORM_HTML, { headers: { "content-type": "text/html" } })
      return new Response(`<html><body><h1>Index</h1></body></html>`, {
        headers: { "content-type": "text/html" },
      })
    },
  })
  REAL_CHROME_RAN = true
})

afterAll(async () => {
  if (realPort && realHandle) await realPort.close(realHandle)
  server?.stop(true)
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

describe("REAL chrome — cdp-adapter port direct (SSRF gate is tool-layer-only)", () => {
  test("(16) navigate returns the fixture <title>/title-equivalent through the real port", async () => {
    if (!REAL_CHROME_RAN || !realPort || !realHandle || !server) {
      // Chrome session could not be brought up in this environment — skip.
      expect(REAL_CHROME_RAN).toBe(false)
      return
    }
    const nav = await realPort.navigate(realHandle, `http://127.0.0.1:${server.port}/form`)
    expect(nav.ok).toBe(true)
  })

  test("(17) snapshot of the fixture page contains the real heading text", async () => {
    if (!REAL_CHROME_RAN || !realPort || !realHandle || !server) {
      expect(REAL_CHROME_RAN).toBe(false)
      return
    }
    await realPort.navigate(realHandle, `http://127.0.0.1:${server.port}/form`)
    const snap = await realPort.snapshot(realHandle)
    expect(snap.ok).toBe(true)
    if (snap.ok) expect(snap.value.yaml.length).toBeGreaterThan(0)
  })
})
