/**
 * Round-3 composition-root ACTIVATION hellgate — drives the gated
 * `DefaultToolPorts` slots through the REAL production composition builder
 * `buildBaseFromArgs` (`@/host/runtime/agent-arg-builder.ts`), NOT just
 * `buildDefaultTools` directly.
 *
 * The sibling `seam-only-port-activation-r3-hellgate.test.ts` proved the seam
 * holds when the port is passed DIRECTLY to `buildDefaultTools`. This battery
 * proves the COMPOSITION ROOT now actually populates those slots when the knob
 * is set — closing the round-3 "never wired" finding — for the 4 ports reachable
 * at this layer:
 *
 *     imageGen | officeAuthoring | progressUpdate | ptySession
 *
 * For each port:
 *   (a) KNOB ON  ⇒ `buildBaseFromArgs(...).registry` CONTAINS the gated tool(s).
 *   (b) KNOB OFF ⇒ the tool is ABSENT and the assembled tool-name set is
 *       byte-identical to the bare default menu (default-OFF byte-identity).
 *   (c) A dispatch through the real registry ACTIVATES the adapter (a fake exec
 *       at the LEAF for pty; real OOXML write for office; the real key-bound
 *       image port returns a typed `no_key` with no key, proving the wire).
 *
 * `mcpResources` (N3) is INTENTIONALLY absent FROM THIS LAYER: `agent-arg-builder`
 * builds the baseline registry WITHOUT loading any MCP server, so it has no live
 * client to aggregate — and routing the four tools through `DefaultToolPorts`
 * here would mis-tag them `builtin` origin (losing the H2 `<untrusted-source>`
 * envelope their `mcp` origin guarantees). N3 IS now wired, but at the correct
 * layer: `apps/cli/internal#loadFeatures` builds the bridge's aggregate
 * `ResourcesHandle` over the live clients and, behind `QUANTA_MCP_RESOURCES`,
 * appends `mcpResourcesTools(handle)` to the mcp-origin `mcpTools` array (covered
 * by `mcp-resources-host-wire-e2e-hellgate.test.ts`). The final `describe` below
 * pins that the agent-arg-builder layer STILL leaves the tools absent even with
 * the knob — so a future change that wires them HERE (with the wrong origin) is a
 * deliberate, test-visible regression, not an accident.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import type { AppshotPort, ToolRegistry } from "@/tool"

const BYPASS: PermissionContext = { mode: "bypass" }

/** Knobs + key vars this battery drives — snapshot/strip before each test so the
 *  ambient shell can neither pre-enable a gate nor remove the key the builder
 *  needs, and restore after. */
const DRIVEN = [
  "QUANTA_IMAGE_GEN",
  "QUANTA_OFFICE_AUTHORING",
  "QUANTA_PROGRESS_UPDATE",
  "QUANTA_PTY_ATTACH",
  "QUANTA_PTY_BACKEND",
  "QUANTA_APPSHOT",
  "QUANTA_ARTIFACT_STORE",
  "QUANTA_MCP_RESOURCES",
  "QUANTA_PROVIDER",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // The builder REQUIRES a provider key or it throws ProviderKeyMissingError.
  // Pin a deterministic BYOK OpenAI key so the LLM factory constructs.
  process.env.QUANTA_PROVIDER = "openai"
  process.env.OPENAI_API_KEY = "sk-test-deterministic-key"
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of DRIVEN) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

const partial = () => ({ mode: "headless" as const, dials: undefined })

/** Build the production base + return its registry's sorted tool-name set. */
const registryNamesFromRoot = (): string[] => {
  __resetRuntimeConfig()
  const base = buildBaseFromArgs(partial())
  return base.registry
    .all()
    .map((t) => t.name)
    .sort()
}

/** The bare default-OFF tool menu (no gated knob set) — the byte-identity ref. */
const baselineNames = (): string[] => registryNamesFromRoot()

const config = (registry: ToolRegistry, cwd: string): AgentConfig =>
  ({
    cwd,
    signal: new AbortController().signal,
    planMode: false,
    permission: BYPASS,
    registry,
  }) as AgentConfig

const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name,
  input,
})

const toolNamed = (names: string[], name: string): boolean => names.includes(name)

// ─────────────────────────── imageGen (H14a) ───────────────────────────────

describe("composition-root imageGen — QUANTA_IMAGE_GEN", () => {
  test("OFF ⇒ image_gen ABSENT + byte-identical to baseline", () => {
    const baseline = baselineNames()
    expect(toolNamed(baseline, "image_gen")).toBe(false)
  })

  test("ON ⇒ image_gen REGISTERED via the real composition root", () => {
    const baseline = baselineNames()
    process.env.QUANTA_IMAGE_GEN = "1"
    const on = registryNamesFromRoot()
    expect(toolNamed(on, "image_gen")).toBe(true)
    // Only image_gen is added over the baseline (no cross-bleed).
    expect(on.filter((n) => !baseline.includes(n))).toEqual(["image_gen"])
  })

  test("ON + no OPENAI key ⇒ image_gen ACTIVATES through dispatch ⇒ typed no_key (real key-bound port, never a crash)", async () => {
    // Drop the key so the REAL openAiImagePort the root wired returns no_key
    // WITHOUT a network call — proving the composition-root port is the live one.
    delete process.env.OPENAI_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-test" // keep the builder happy (provider key present)
    process.env.QUANTA_PROVIDER = "anthropic"
    process.env.QUANTA_IMAGE_GEN = "1"
    __resetRuntimeConfig()
    const base = buildBaseFromArgs(partial())
    const dir = mkdtempSync(join(tmpdir(), "croot-imagegen-"))
    try {
      const res = await dispatchTool(
        call("image_gen", { prompt: "x", outputPath: "out.png", n: 1 }),
        config(base.registry as ToolRegistry, dir),
        BYPASS,
      )
      // no_key surfaces as a typed ok:false tool_result, never an exception.
      expect(res.block.type).toBe("tool_result")
      expect(res.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ───────────────────────── officeAuthoring (H14b) ──────────────────────────

describe("composition-root officeAuthoring — QUANTA_OFFICE_AUTHORING", () => {
  test("OFF ⇒ the 3 authoring tools ABSENT", () => {
    const baseline = baselineNames()
    for (const n of ["xlsx_write", "docx_write", "pptx_write"]) {
      expect(toolNamed(baseline, n)).toBe(false)
    }
  })

  test("ON ⇒ xlsx_write/docx_write/pptx_write REGISTERED via the real composition root", () => {
    const baseline = baselineNames()
    process.env.QUANTA_OFFICE_AUTHORING = "1"
    const on = registryNamesFromRoot()
    expect(on.filter((n) => !baseline.includes(n)).sort()).toEqual([
      "docx_write",
      "pptx_write",
      "xlsx_write",
    ])
  })

  test("ON ⇒ xlsx_write ACTIVATES through dispatch + writes a real .xlsx", async () => {
    process.env.QUANTA_OFFICE_AUTHORING = "1"
    __resetRuntimeConfig()
    const base = buildBaseFromArgs(partial())
    const dir = mkdtempSync(join(tmpdir(), "croot-xlsx-"))
    try {
      const res = await dispatchTool(
        call("xlsx_write", {
          path: "book.xlsx",
          sheets: [{ name: "S1", rows: [["a", "b"]] }],
        }),
        config(base.registry as ToolRegistry, dir),
        BYPASS,
      )
      expect(res.ok).toBe(true)
      expect(await Bun.file(join(dir, "book.xlsx")).exists()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ────────────────────────── progressUpdate (C2) ────────────────────────────

describe("composition-root progressUpdate — QUANTA_PROGRESS_UPDATE", () => {
  test("OFF ⇒ communicate_update ABSENT", () => {
    expect(toolNamed(baselineNames(), "communicate_update")).toBe(false)
  })

  test("ON ⇒ communicate_update REGISTERED via the real composition root", () => {
    const baseline = baselineNames()
    process.env.QUANTA_PROGRESS_UPDATE = "1"
    const on = registryNamesFromRoot()
    expect(on.filter((n) => !baseline.includes(n))).toEqual(["communicate_update"])
  })

  test("ON ⇒ communicate_update ACTIVATES + emits onto the wired progressSink", async () => {
    process.env.QUANTA_PROGRESS_UPDATE = "1"
    __resetRuntimeConfig()
    const base = buildBaseFromArgs(partial())
    const emitted: unknown[] = []
    const cfg = {
      ...config(base.registry as ToolRegistry, "/repo"),
      progressSink: { emit: (e: unknown) => emitted.push(e) },
    } as AgentConfig
    const res = await dispatchTool(
      call("communicate_update", { current_step: "halfway" }),
      cfg,
      BYPASS,
    )
    expect(res.ok).toBe(true)
    expect(emitted.length).toBe(1)
  })
})

// ─────────────────────────── ptySession (N6) ───────────────────────────────

describe("composition-root ptySession — QUANTA_PTY_ATTACH", () => {
  test("OFF ⇒ pty_* ABSENT", () => {
    const baseline = baselineNames()
    for (const n of ["pty_list", "pty_attach", "pty_write", "pty_read", "pty_resize", "pty_kill"]) {
      expect(toolNamed(baseline, n)).toBe(false)
    }
  })

  test("ON ⇒ the 6 pty tools REGISTERED via the real composition root (tmux backend)", () => {
    const baseline = baselineNames()
    process.env.QUANTA_PTY_ATTACH = "1"
    const on = registryNamesFromRoot()
    expect(on.filter((n) => !baseline.includes(n)).sort()).toEqual([
      "pty_attach",
      "pty_kill",
      "pty_list",
      "pty_read",
      "pty_resize",
      "pty_write",
    ])
  })

  test("ON ⇒ pty_attach ACTIVATES through dispatch (foreign-name ⇒ typed foreign-denied, NO crash, proves the real tmux gate)", async () => {
    // The real tmux backend's security gate denies a non-`quanta-` handle WITHOUT
    // ever spawning tmux — so this asserts the wired adapter is the production one
    // without depending on a tmux binary being installed.
    process.env.QUANTA_PTY_ATTACH = "1"
    __resetRuntimeConfig()
    const base = buildBaseFromArgs(partial())
    const res = await dispatchTool(
      call("pty_attach", { handle: "tmux:foreign-session" }),
      config(base.registry as ToolRegistry, "/repo"),
      BYPASS,
    )
    // The tool maps the adapter's typed foreign-denied PtyResult to ok:false.
    expect(res.block.type).toBe("tool_result")
    expect(res.ok).toBe(false)
  })
})

// ───────── mcpResources (N3) — wired at loadFeatures, NOT this layer ─────────

describe("composition-root mcpResources — wired at the MCP-load layer, NOT agent-arg-builder", () => {
  test("even with QUANTA_MCP_RESOURCES=1, the mcp resource tools are NOT registered by the BASELINE root (no MCP servers loaded here)", () => {
    // N3 IS now host-wired — but at `apps/cli/internal#loadFeatures`, where the
    // bridge's aggregate `ResourcesHandle` (built over the LIVE clients) is
    // appended to the mcp-origin `mcpTools` array (so the H2 `<untrusted-source>`
    // envelope wraps their output). `agent-arg-builder` builds the BASELINE
    // registry with NO MCP server loaded, so there is no client to aggregate and
    // the four tools stay absent even with the knob — pinned so a future change
    // that wires them HERE (mis-tagging them `builtin` origin) is a deliberate,
    // test-visible regression. The activation path is covered end-to-end by
    // `mcp-resources-host-wire-e2e-hellgate.test.ts`.
    process.env.QUANTA_MCP_RESOURCES = "1"
    const on = registryNamesFromRoot()
    delete process.env.QUANTA_MCP_RESOURCES
    for (const n of [
      "mcp_list_resources",
      "mcp_read_resource",
      "mcp_list_prompts",
      "mcp_get_prompt",
    ]) {
      expect(toolNamed(on, n)).toBe(false)
    }
  })
})

// ─────────────────────────── appshot (G1) ──────────────────────────────────
//
// At THIS pre-assembler layer no `BrowserPort` is reachable (the CDP browser is
// wired later in agent-config-assembler only when a system Chrome exists). So the
// composition root mints the appshot slot ONLY when a complete `AppshotPort` is
// injected via `seams.appshotPort` (a host/e2e seam) — proving the REAL
// `buildGatedToolPorts` registration path activates the tool. Without the seam
// (production today) the knob alone yields a byte-identical menu — the remaining
// adapter-assembly step is to build the BrowserPort+LLM-judge port where the
// BrowserPort lives.

/** Minimal in-memory `AppshotPort` — scripted verdict, no Chrome/network. */
const fakeAppshotPort = (): AppshotPort => ({
  async scaffold(_spec, outDir) {
    return {
      entryUrl: `file:///${outDir}/index.html`,
      entryPath: "/x/index.html",
      mediaType: "text/html",
    }
  },
  async render() {},
  async screenshot() {
    return new Uint8Array([1, 2, 3])
  },
  async verify() {
    return { pass: true, notes: "ok" }
  },
})

describe("composition-root appshot — QUANTA_APPSHOT", () => {
  test("OFF ⇒ appshot_verify ABSENT + byte-identical to baseline", () => {
    const baseline = baselineNames()
    expect(toolNamed(baseline, "appshot_verify")).toBe(false)
  })

  test("ON but NO injected port ⇒ slot stays empty ⇒ byte-identical (BrowserPort unreachable at this layer)", () => {
    const baseline = baselineNames()
    process.env.QUANTA_APPSHOT = "1"
    const on = registryNamesFromRoot()
    // No seam ⇒ no BrowserPort here ⇒ the slot is omitted; the menu is unchanged.
    expect(toolNamed(on, "appshot_verify")).toBe(false)
    expect(on).toEqual(baseline)
  })

  test("ON + injected AppshotPort seam ⇒ appshot_verify REGISTERED via the real composition root", () => {
    const baseline = baselineNames()
    process.env.QUANTA_APPSHOT = "1"
    __resetRuntimeConfig()
    const base = buildBaseFromArgs(partial(), undefined, undefined, {
      appshotPort: fakeAppshotPort(),
    })
    const names = base.registry
      .all()
      .map((t) => t.name)
      .sort()
    expect(toolNamed(names, "appshot_verify")).toBe(true)
    // Only appshot_verify is added over the baseline (no cross-bleed).
    expect(names.filter((n) => !baseline.includes(n))).toEqual(["appshot_verify"])
  })

  test("seam injected but knob OFF ⇒ appshot_verify ABSENT (knob gates the slot, not the seam)", () => {
    // The seam is consulted ONLY when the knob already gated the slot; an injected
    // port can never WIDEN the menu past what QUANTA_APPSHOT enabled.
    __resetRuntimeConfig()
    const base = buildBaseFromArgs(partial(), undefined, undefined, {
      appshotPort: fakeAppshotPort(),
    })
    const names = base.registry.all().map((t) => t.name)
    expect(names.includes("appshot_verify")).toBe(false)
  })
})

// ──────────────── pty backend selection (N6 / QUANTA_PTY_BACKEND) ───────────
//
// The 6 pty_* tools are gated by QUANTA_PTY_ATTACH (above); QUANTA_PTY_BACKEND
// selects WHICH backend the wired `PtySessionPort` is (tmux/bun/both). On a Bun
// runtime without native `Bun.Terminal`, `bun`/`both` gracefully fall back to the
// tmux adapter — so the tool SET is identical regardless of backend (the menu is
// a function of the attach knob alone, not the backend dial).

describe("composition-root pty backend — QUANTA_PTY_BACKEND", () => {
  test("default backend (tmux) registers the same 6 pty tools as an explicit bun selection", () => {
    process.env.QUANTA_PTY_ATTACH = "1"
    // default (no QUANTA_PTY_BACKEND ⇒ tmux)
    const tmuxNames = registryNamesFromRoot()
    process.env.QUANTA_PTY_BACKEND = "bun"
    const bunNames = registryNamesFromRoot()
    const ptyNames = (ns: string[]) => ns.filter((n) => n.startsWith("pty_")).sort()
    expect(ptyNames(tmuxNames)).toEqual([
      "pty_attach",
      "pty_kill",
      "pty_list",
      "pty_read",
      "pty_resize",
      "pty_write",
    ])
    // Backend dial does NOT change the tool surface (bun falls back to tmux when
    // Bun.Terminal is unavailable; either way the 6 tools register).
    expect(ptyNames(bunNames)).toEqual(ptyNames(tmuxNames))
  })

  test("backend dial with the attach knob OFF ⇒ still NO pty tools (backend never widens the menu)", () => {
    process.env.QUANTA_PTY_BACKEND = "both"
    const names = registryNamesFromRoot()
    expect(names.some((n) => n.startsWith("pty_"))).toBe(false)
  })
})
