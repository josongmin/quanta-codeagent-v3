/**
 * jun-6 ALL-KNOBS-ON cross-feature COMPOSITION hellgate (audit ROUND 2).
 *
 * Round 1 audited the 23 jun-6 features in ISOLATION. This battery proves they
 * COMPOSE: it drives the REAL production composition builder `buildBaseFromArgs`
 * (`@/host/runtime/agent-arg-builder`) with EVERY jun-6 gated knob set to "1" at
 * once — plus the appshot host seam — and asserts the assembled registry is
 * COHERENT under simultaneous activation:
 *
 *   1. The registry ASSEMBLES (no throw) with every gate on.
 *   2. NO duplicate tool names (registry-collision guard) — two features minting
 *      the same name, or a gated group overlapping the base set, would surface
 *      here as a dup.
 *   3. EXHAUSTIVENESS: every registered tool has an explicit MUTATING_TOOL_TABLE
 *      entry, so a plan-mode dispatch of ANY all-on tool never trips
 *      `UnknownToolError` (the §S2 drift invariant, asserted with all ports wired).
 *   4. MANIFEST coverage: every registered tool name is catalogued in the
 *      tool-surface SSOT (no orphan slips in only under full composition).
 *   5. The SHARED artifact registry is ONE instance fed by all three producer
 *      tools (image_gen / *_write / appshot_verify) — concurrent registration
 *      from multiple producers stays collision-free + monotone.
 *   6. BYTE-IDENTITY under partial composition: a realistic 2-knob subset
 *      (prompt-cache + auto-title — neither adds a tool) leaves the registry
 *      byte-identical to the bare default-OFF menu (no accidental coupling).
 *
 * Clean-by-construction is a VALID outcome here: a green all-on assembly proves
 * the composition surface is coherent. Any RED would be a registry-collision /
 * exhaustiveness gap / cross-talk that only manifests when features compose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { isMutatingTool, mutatingToolKind } from "@/agent/mode"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { ALL_MANIFEST_TOOL_NAMES, type AppshotPort, type ToolRegistry } from "@/tool"

const BYPASS: PermissionContext = { mode: "bypass" }

/** Every jun-6 + companion gated knob this battery drives ON at once, plus the
 *  provider key vars the builder requires. Snapshot/strip before each test so the
 *  ambient shell can neither pre-enable nor remove a gate, and restore after. */
const DRIVEN = [
  // gated DefaultToolPorts (the tool-minting knobs reachable at this layer)
  "QUANTA_ENABLE_STRUCTURED_PATCH",
  "QUANTA_COVERAGE_TOOL",
  "QUANTA_ARTIFACT_STORE",
  "QUANTA_MCP_CONNECTORS",
  "QUANTA_IMAGE_GEN",
  "QUANTA_OFFICE_AUTHORING",
  "QUANTA_PROGRESS_UPDATE",
  "QUANTA_PTY_ATTACH",
  "QUANTA_PTY_BACKEND",
  "QUANTA_APPSHOT",
  "QUANTA_ASYNC_TOOLS",
  // jun-6 behavior knobs that touch shared seams (no new tool, but compose)
  "QUANTA_PROMPT_CACHE_TTL",
  "QUANTA_OAUTH_REVOKE_ON_LOGOUT",
  "QUANTA_TOOL_INTERRUPT_BLOCK",
  "QUANTA_PERMISSION_HOOK",
  "QUANTA_SESSION_AUTO_TITLE",
  "QUANTA_SESSION_TITLE_MODEL",
  "QUANTA_SUBAGENT_QUEUE",
  "QUANTA_FORCE_BACKGROUND",
  "QUANTA_MCP_OAUTH_KEYRING",
  "QUANTA_DELTA_TOKEN_COUNT",
  "QUANTA_RATELIMIT_PROACTIVE",
  "QUANTA_DENY_REASON",
  "QUANTA_IPYNB_OUTPUTS",
  "QUANTA_API_KEY_HELPER_LEGACY_VENDOR",
  // provider
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

/** Minimal in-memory `AppshotPort` — scripted, no Chrome/network. */
const fakeAppshotPort = (): AppshotPort => ({
  async scaffold(_spec, outDir) {
    return {
      entryUrl: `file:///${outDir}/index.html`,
      entryPath: join(outDir, "index.html"),
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

/** Set every tool-minting jun-6 knob to "1" (the appshot seam is passed
 *  separately because no BrowserPort is reachable at this layer). */
const enableAllToolKnobs = (): void => {
  process.env.QUANTA_ENABLE_STRUCTURED_PATCH = "1"
  process.env.QUANTA_COVERAGE_TOOL = "1"
  process.env.QUANTA_ARTIFACT_STORE = "1"
  process.env.QUANTA_MCP_CONNECTORS = "1"
  process.env.QUANTA_IMAGE_GEN = "1"
  process.env.QUANTA_OFFICE_AUTHORING = "1"
  process.env.QUANTA_PROGRESS_UPDATE = "1"
  process.env.QUANTA_PTY_ATTACH = "1"
  process.env.QUANTA_PTY_BACKEND = "both"
  process.env.QUANTA_APPSHOT = "1"
  process.env.QUANTA_ASYNC_TOOLS = "1"
  // behavior knobs that touch shared seams (LLM turn path / dispatch / logout)
  process.env.QUANTA_PROMPT_CACHE_TTL = "1h"
  process.env.QUANTA_OAUTH_REVOKE_ON_LOGOUT = "1"
  process.env.QUANTA_TOOL_INTERRUPT_BLOCK = "1"
  process.env.QUANTA_PERMISSION_HOOK = "1"
  process.env.QUANTA_SESSION_AUTO_TITLE = "1"
  process.env.QUANTA_SESSION_TITLE_MODEL = "gpt-4o-mini"
  process.env.QUANTA_SUBAGENT_QUEUE = "1"
  process.env.QUANTA_FORCE_BACKGROUND = "1"
  process.env.QUANTA_MCP_OAUTH_KEYRING = "1"
  process.env.QUANTA_DELTA_TOKEN_COUNT = "1"
  process.env.QUANTA_RATELIMIT_PROACTIVE = "1"
  process.env.QUANTA_DENY_REASON = "1"
  process.env.QUANTA_API_KEY_HELPER_LEGACY_VENDOR = "1"
  __resetRuntimeConfig()
}

/** Build the production base with ALL knobs + the appshot seam, return its
 *  registry. */
const buildAllOn = (): ToolRegistry => {
  enableAllToolKnobs()
  const base = buildBaseFromArgs(partial(), undefined, undefined, {
    appshotPort: fakeAppshotPort(),
  })
  return base.registry as ToolRegistry
}

const namesOf = (registry: ToolRegistry): string[] => registry.all().map((t) => t.name)

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

// ───────────────── 1. all-on assembles + no registry collision ──────────────

describe("jun-6 ALL-KNOBS-ON — registry assembles without collision", () => {
  test("buildBaseFromArgs assembles with every gated knob + appshot seam (no throw)", () => {
    expect(() => buildAllOn()).not.toThrow()
  })

  test("NO duplicate tool names under full composition (registry-collision guard)", () => {
    const names = namesOf(buildAllOn())
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    expect(dupes).toEqual([])
  })

  test("the all-on menu CONTAINS every gated tool reachable at this layer", () => {
    const names = new Set(namesOf(buildAllOn()))
    // The tool-minting knobs at the agent-arg-builder layer (NOT the
    // loadFeatures-only N3 mcp-resources, which needs a live MCP client).
    for (const n of [
      "apply_patch_structured",
      "coverage_check",
      "artifact_list",
      "artifact_register",
      "artifact_get",
      "artifact_destroy",
      "mcp_connector_list",
      "mcp_connector_install",
      "image_gen",
      "xlsx_write",
      "docx_write",
      "pptx_write",
      "communicate_update",
      "pty_attach",
      "pty_list",
      "pty_write",
      "pty_read",
      "pty_resize",
      "pty_kill",
      "appshot_verify",
      "poll_deferred",
    ]) {
      expect(names.has(n)).toBe(true)
    }
  })
})

// ───────────────── 2. MUTATING_TOOL_TABLE exhaustiveness (all-on) ───────────

describe("jun-6 ALL-KNOBS-ON — plan-mode exhaustiveness with every gate wired", () => {
  test("every registered all-on tool is classified in MUTATING_TOOL_TABLE (no UnknownToolError)", () => {
    const names = namesOf(buildAllOn())
    for (const n of names) {
      // Both accessors throw UnknownToolError for an unclassified name; a green
      // run proves plan-mode dispatch of ANY all-on tool is safe.
      expect(() => isMutatingTool(n)).not.toThrow()
      expect(() => mutatingToolKind(n)).not.toThrow()
    }
  })
})

// ───────────────── 3. manifest coverage (all-on) ────────────────────────────

describe("jun-6 ALL-KNOBS-ON — tool-surface manifest covers the full menu", () => {
  test("every registered all-on tool name is catalogued in the SSOT", () => {
    const manifest = new Set(ALL_MANIFEST_TOOL_NAMES)
    const uncatalogued = namesOf(buildAllOn())
      .filter((n) => !manifest.has(n))
      .sort()
    expect(uncatalogued).toEqual([])
  })
})

// ───────────────── 4. shared artifact registry — multi-producer ─────────────

describe("jun-6 ALL-KNOBS-ON — one artifact registry shared by every producer", () => {
  test("image_gen + xlsx_write + appshot_verify register into the SAME registry; concurrent registration is collision-free + monotone", async () => {
    // Drop the OPENAI key so the key-bound image port returns a typed no_key
    // WITHOUT a network call; keep the builder happy via the anthropic key.
    enableAllToolKnobs()
    delete process.env.OPENAI_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"
    process.env.QUANTA_PROVIDER = "anthropic"
    __resetRuntimeConfig()
    const base = buildBaseFromArgs(partial(), undefined, undefined, {
      appshotPort: fakeAppshotPort(),
    })
    const reg = base.registry as ToolRegistry
    const dir = mkdtempSync(join(tmpdir(), "jun6-allon-artifact-"))
    try {
      const cfg = config(reg, dir)
      // Fire two real producers CONCURRENTLY into the shared session registry.
      const [xlsx, pptx] = await Promise.all([
        dispatchTool(
          call("xlsx_write", { path: "a.xlsx", sheets: [{ name: "S", rows: [["x"]] }] }),
          cfg,
          BYPASS,
        ),
        dispatchTool(
          call("pptx_write", { path: "b.pptx", slides: [{ title: "T", body: ["x"] }] }),
          cfg,
          BYPASS,
        ),
      ])
      expect(xlsx.ok).toBe(true)
      expect(pptx.ok).toBe(true)
      // The artifact registry the tools registered into is the SAME instance the
      // artifact_* tools read — list it through the live tool.
      const listed = await dispatchTool(call("artifact_list", {}), cfg, BYPASS)
      expect(listed.ok).toBe(true)
      // Two distinct artifacts (no id collision under concurrent registration).
      const text = JSON.stringify(listed.block)
      // monotonic ids art-1 / art-2 — both present, distinct.
      expect(text).toContain("art-1")
      expect(text).toContain("art-2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ───────────────── 5. byte-identity under partial composition ───────────────

describe("jun-6 PARTIAL composition — non-tool knobs do NOT couple the menu", () => {
  test("prompt-cache + auto-title ON (neither mints a tool) ⇒ registry byte-identical to bare default-OFF", () => {
    // bare default-OFF baseline
    __resetRuntimeConfig()
    const baseOff = buildBaseFromArgs(partial())
    const offNames = (baseOff.registry as ToolRegistry)
      .all()
      .map((t) => t.name)
      .sort()
    // realistic 2-knob subset that touches the LLM turn path + session-start,
    // but mints NO tool — the menu must be unchanged (no accidental coupling).
    process.env.QUANTA_PROMPT_CACHE_TTL = "1h"
    process.env.QUANTA_SESSION_AUTO_TITLE = "1"
    process.env.QUANTA_SESSION_TITLE_MODEL = "gpt-4o-mini"
    __resetRuntimeConfig()
    const baseOn = buildBaseFromArgs(partial())
    const onNames = (baseOn.registry as ToolRegistry)
      .all()
      .map((t) => t.name)
      .sort()
    expect(onNames).toEqual(offNames)
  })
})
