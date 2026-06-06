/**
 * ★ E2E REACHABILITY — G1 appshot verify-loop, composition-root closeout
 * (RFC jun-6-appgen-appshot, the "CONFIG-REACHABLE" step).
 *
 * Proves the LIVE production wire that was the remaining gap: the appshot
 * `AppshotPort` is assembled at the ONE layer where the `BrowserPort` lives —
 * `agent-config-assembler.ts#maybeWireAppshot` — over a real browser
 * (render/screenshot), a judge `LLMPort` (verify), and the jailed scaffold
 * writer. The pre-assembler `agent-arg-builder` cannot mint it (no BrowserPort
 * there); this battery drives `assembleAgentConfig` instead.
 *
 * Seals (fake BrowserPort + fake judge LLM injected at the assembler — NO Chrome,
 * NO network, deterministic):
 *   A. knob-on + browser + judge ⇒ `cfg.appshot` is a wired slot ⇒
 *      `buildAppshotBlock` exposes `appshot_verify`; a DISPATCH runs the bounded
 *      loop (scaffold→render→screenshot→judge→iterate) and registers the artifact.
 *   B. knob-OFF ⇒ slot unset ⇒ tool ABSENT (byte-identical default-OFF).
 *   C. knob-on but NO browser ⇒ slot unset ⇒ tool ABSENT (render unreachable).
 *   D. caller-override-precedence: a pre-set `cfg.appshot` is preserved.
 *   E. the wired judge actually drives the verdict (FAIL judge ⇒ the loop
 *      iterates + the model-visible output carries the critique).
 *   F. artifactSink off (Canvas store absent) ⇒ no artifact id (byte-identical),
 *      loop still completes.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildAppshotBlock } from "@/agent/tier1"
import type { BrowserError, BrowserHandle, BrowserPort } from "@/browser"
import { type AssembleRequest, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import type { LLMPort, StreamEvent, ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { err, ok, type Result } from "@/shared"
import { type AppshotArtifactSink, type AppshotSlot, type Tool, ToolRegistry } from "@/tool"

const BYPASS: PermissionContext = { mode: "bypass" }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

/* ---------------------------------------------------------------- */
/* fakes                                                            */
/* ---------------------------------------------------------------- */

/** Scripted BrowserPort — spawns a handle, navigates ok, returns a fixed PNG.
 *  Records calls so the test can assert the loop drove the real arrows. */
const fakeBrowser = (): BrowserPort & { calls: { navigate: number; screenshot: number } } => {
  const calls = { navigate: 0, screenshot: 0 }
  const handle: BrowserHandle = { id: "h1", backend: "fake" }
  return {
    calls,
    availability: () => "fake",
    isLive: () => true,
    async spawn(): Promise<Result<BrowserHandle, BrowserError>> {
      return ok(handle)
    },
    async navigate(): Promise<Result<{ readonly title: string }, BrowserError>> {
      calls.navigate++
      return ok({ title: "scaffold" })
    },
    async screenshot(): Promise<Result<Uint8Array, BrowserError>> {
      calls.screenshot++
      return ok(PNG)
    },
    async close(): Promise<Result<void, BrowserError>> {
      return ok(undefined)
    },
    // unused arrows — never called by the appshot port.
    snapshot: async () => err({ kind: "closed" }),
    click: async () => err({ kind: "closed" }),
    type: async () => err({ kind: "closed" }),
    fill: async () => err({ kind: "closed" }),
    selectOption: async () => err({ kind: "closed" }),
    scroll: async () => err({ kind: "closed" }),
    pressKey: async () => err({ kind: "closed" }),
    drag: async () => err({ kind: "closed" }),
    mouseClickXY: async () => err({ kind: "closed" }),
    consoleMessages: async () => err({ kind: "closed" }),
    wait: async () => err({ kind: "closed" }),
    read: async () => err({ kind: "closed" }),
    cdp: async () => err({ kind: "closed" }),
  } as BrowserPort & { calls: { navigate: number; screenshot: number } }
}

/** Scripted judge — streams a single text line that the verdict parser reads.
 *  The first call returns `firstVerdict`, every later call returns `thenVerdict`
 *  (so a FAIL→PASS script exercises the iterate-then-pass path). */
const fakeJudge = (firstVerdict: string, thenVerdict = firstVerdict): LLMPort => {
  let n = 0
  return {
    model: "judge-fake",
    async *stream(): AsyncIterable<StreamEvent> {
      const line = n === 0 ? firstVerdict : thenVerdict
      n++
      yield { type: "text_delta", delta: line }
      yield { type: "message_stop", stop_reason: "end_turn" }
    },
  }
}

/** Build an assemble base whose llm IS the judge + with a pre-wired fake browser
 *  slot. `maybeWireBrowser` (QUANTA_BROWSER_TOOL off) leaves a pre-set browser
 *  untouched (caller-override-precedence), so the fake survives to maybeWireAppshot. */
const baseWithBrowser = (
  cwd: string,
  judge: LLMPort,
  browser: BrowserPort,
  artifactRegistry?: AppshotArtifactSink,
): AssembleRequest["base"] =>
  ({
    llm: judge as unknown as AgentConfig["llm"],
    registry: new ToolRegistry([]) as unknown as AgentConfig["registry"],
    stream: { emit: () => undefined },
    permission: { mode: "default" },
    messages: [],
    system: "test",
    cwd,
    maxTurns: 1,
    signal: new AbortController().signal,
    sessionId: "appshot-reach",
    browser: { port: browser },
    ...(artifactRegistry !== undefined ? { artifactRegistry } : {}),
  }) as unknown as AssembleRequest["base"]

const assemble = (base: AssembleRequest["base"], env: Record<string, string | undefined>) =>
  assembleAgentConfig({ mode: "interactive", base }, env)

const cfgForDispatch = (cfg: AgentConfig, extraTools: Tool[]): AgentConfig =>
  ({
    cwd: cfg.cwd,
    signal: new AbortController().signal,
    planMode: false,
    permission: BYPASS,
    registry: new ToolRegistry(extraTools),
  }) as unknown as AgentConfig

const call = (input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name: "appshot_verify",
  input,
})

/** Per-test jail root under OS temp — appshot scaffold must NOT litter the repo. */
const tmpRoots: string[] = []

const tmpCwd = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-appshot-"))
  tmpRoots.push(dir)
  return dir
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------- */
/* A — full reachability: assemble → block → dispatch → artifact     */
/* ---------------------------------------------------------------- */

describe("A — appshot reachability via the assembler (knob-on + browser + judge)", () => {
  test("A1 — QUANTA_APPSHOT=1 + browser + judge ⇒ cfg.appshot is a wired slot", () => {
    const browser = fakeBrowser()
    const cfg = assemble(baseWithBrowser(tmpCwd(), fakeJudge("PASS great"), browser), {
      QUANTA_APPSHOT: "1",
    })
    const slot = (cfg as AgentConfig & { appshot?: AppshotSlot }).appshot
    expect(slot).toBeDefined()
    expect(typeof slot?.port.scaffold).toBe("function")
    expect(typeof slot?.now).toBe("function")
  })

  test("A2 — buildAppshotBlock exposes exactly appshot_verify", () => {
    const cfg = assemble(baseWithBrowser(tmpCwd(), fakeJudge("PASS ok"), fakeBrowser()), {
      QUANTA_APPSHOT: "1",
    })
    const block = buildAppshotBlock(cfg)
    expect(block.tools.map((t) => t.name)).toEqual(["appshot_verify"])
  })

  test("A3 — a dispatch runs the bounded loop (scaffold→render→screenshot→judge) + registers the artifact", async () => {
    const browser = fakeBrowser()
    const registered: Array<{ path: string; mediaType: string }> = []
    const sink: AppshotArtifactSink = {
      register: (spec) => {
        registered.push({ path: spec.path, mediaType: spec.mediaType })
        return { id: "art-1" }
      },
    }
    const cfg = assemble(baseWithBrowser(tmpCwd(), fakeJudge("PASS looks right"), browser, sink), {
      QUANTA_APPSHOT: "1",
    })
    const block = buildAppshotBlock(cfg)
    const res = await dispatchTool(
      call({ prompt: "a hello-world page", out_dir: "reach", max_iterations: 3 }),
      cfgForDispatch(cfg, block.tools),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    // The real browser arrows were driven by the loop.
    expect(browser.calls.navigate).toBeGreaterThanOrEqual(1)
    expect(browser.calls.screenshot).toBeGreaterThanOrEqual(1)
    // The final scaffold was registered into the wired artifact sink.
    expect(registered.length).toBe(1)
    expect(registered[0]?.mediaType).toBe("text/html")
    // Model-visible output names the artifact + a PASS verdict.
    const out = (res.block as { content?: string }).content ?? ""
    expect(out).toContain("artifact: art-1")
    expect(out).toContain("PASS")
    await block.dispose()
  })
})

/* ---------------------------------------------------------------- */
/* B/C — default-OFF byte-identity (knob off OR no browser)          */
/* ---------------------------------------------------------------- */

describe("B/C — default-OFF: no slot ⇒ tool ABSENT (byte-identical)", () => {
  test("B1 — knob OFF ⇒ cfg.appshot unset ⇒ buildAppshotBlock empty", () => {
    const cfg = assemble(baseWithBrowser(tmpCwd(), fakeJudge("PASS"), fakeBrowser()), {})
    expect((cfg as AgentConfig & { appshot?: AppshotSlot }).appshot).toBeUndefined()
    expect(buildAppshotBlock(cfg).tools).toEqual([])
  })

  test("B2 — knob set to a non-'1' value ⇒ slot unset (strict opt-in)", () => {
    for (const raw of ["0", "on", "true", "", "yes"]) {
      const cfg = assemble(baseWithBrowser(tmpCwd(), fakeJudge("PASS"), fakeBrowser()), {
        QUANTA_APPSHOT: raw,
      })
      expect((cfg as AgentConfig & { appshot?: AppshotSlot }).appshot).toBeUndefined()
    }
  })

  test("C1 — knob ON but NO browser wired ⇒ slot unset (render unreachable ⇒ no tool)", () => {
    const base = {
      llm: fakeJudge("PASS") as unknown as AgentConfig["llm"],
      registry: new ToolRegistry([]) as unknown as AgentConfig["registry"],
      stream: { emit: () => undefined },
      permission: { mode: "default" },
      messages: [],
      system: "test",
      cwd: tmpCwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "no-browser",
    } as unknown as AssembleRequest["base"]
    const cfg = assemble(base, { QUANTA_APPSHOT: "1" })
    expect((cfg as AgentConfig & { appshot?: AppshotSlot }).appshot).toBeUndefined()
    expect(buildAppshotBlock(cfg).tools).toEqual([])
  })
})

/* ---------------------------------------------------------------- */
/* D — caller-override-precedence                                   */
/* ---------------------------------------------------------------- */

describe("D — caller-supplied appshot slot is preserved", () => {
  test("D1 — a pre-set cfg.appshot is NOT overwritten by maybeWireAppshot", () => {
    const sentinel: AppshotSlot = {
      port: {
        scaffold: async () => ({ entryUrl: "x", entryPath: "x", mediaType: "text/html" }),
        render: async () => {},
        screenshot: async () => PNG,
        verify: async () => ({ pass: true, notes: "sentinel" }),
      },
      now: () => 0,
    }
    const base = {
      ...baseWithBrowser(tmpCwd(), fakeJudge("PASS"), fakeBrowser()),
      appshot: sentinel,
    } as unknown as AssembleRequest["base"]
    const cfg = assemble(base, { QUANTA_APPSHOT: "1" })
    expect((cfg as AgentConfig & { appshot?: AppshotSlot }).appshot).toBe(sentinel)
  })
})

/* ---------------------------------------------------------------- */
/* E — the wired judge drives the verdict (FAIL ⇒ iterate)          */
/* ---------------------------------------------------------------- */

describe("E — the assembler-wired judge LLM drives the loop verdict", () => {
  test("E1 — a FAIL→PASS judge ⇒ loop iterates then passes; critique surfaced", async () => {
    const browser = fakeBrowser()
    const cfg = assemble(
      baseWithBrowser(
        tmpCwd(),
        fakeJudge("FAIL the heading is missing", "PASS now correct"),
        browser,
      ),
      { QUANTA_APPSHOT: "1" },
    )
    const block = buildAppshotBlock(cfg)
    const res = await dispatchTool(
      call({ prompt: "page with an H1", out_dir: "verify-e", max_iterations: 3 }),
      cfgForDispatch(cfg, block.tools),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    // FAIL on iter 0 then PASS on iter 1 ⇒ the browser was driven twice.
    expect(browser.calls.screenshot).toBe(2)
    const out = (res.block as { content?: string }).content ?? ""
    expect(out).toContain("PASS")
    expect(out).toContain("now correct")
    await block.dispose()
  })
})

/* ---------------------------------------------------------------- */
/* F — artifactSink absent ⇒ no id (byte-identical), loop completes   */
/* ---------------------------------------------------------------- */

describe("F — Canvas store off ⇒ no artifact registration (byte-identical)", () => {
  test("F1 — no artifactRegistry on base ⇒ slot has no artifactSink ⇒ output omits artifact", async () => {
    const cfg = assemble(baseWithBrowser(tmpCwd(), fakeJudge("PASS clean"), fakeBrowser()), {
      QUANTA_APPSHOT: "1",
    })
    const slot = (cfg as AgentConfig & { appshot?: AppshotSlot }).appshot
    expect(slot?.artifactSink).toBeUndefined()
    const block = buildAppshotBlock(cfg)
    const res = await dispatchTool(
      call({ prompt: "any page", out_dir: "verify-f", max_iterations: 2 }),
      cfgForDispatch(cfg, block.tools),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    const out = (res.block as { content?: string }).content ?? ""
    expect(out).not.toContain("artifact:")
    await block.dispose()
  })
})
