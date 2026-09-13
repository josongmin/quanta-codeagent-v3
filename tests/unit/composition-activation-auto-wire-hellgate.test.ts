/**
 * ADR-0350 — Composition-root `cfg.activatePlugins` auto-wire hellgate.
 *
 * `autoWirePluginActivation` is the production wire that closes the
 * dangling value gap left by ADR-0346: with the loop hook in place but
 * no composition-root populating `cfg.activatePlugins`, the slot stays
 * undefined and the hook is permanently a no-op. The helper assembles
 * the registry + launcher + handler from minimal inputs (cwd + optional
 * fs port) and sets the slot so any same-process loop turn that calls
 * `prepareTurnContext` triggers real plugin activation.
 *
 * Invariants under test:
 *
 *   1. Caller-override-precedence — a pre-set `cfg.activatePlugins` is
 *      never overwritten.
 *   2. Empty-discovery short-circuit — zero discovered manifests leaves
 *      the slot undefined ⇒ loop hook degrades to legacy.
 *   3. Discovery throw — fs port that throws degrades to empty.
 *   4. Discovery success — manifests parse, `cfg.activatePlugins` is set
 *      and the closure is callable.
 *   5. Closure activation — calling the wired closure with a plugin
 *      mention returns a populated `AggregatedActivation` (handles list
 *      reflects the manifest's `mcpServers`).
 *   6. Non-plugin mentions — wired closure with skill-only mentions
 *      returns empty.
 *   7. NO-THROW on hostile cfg — frozen / sealed cfg degrades without
 *      throwing to the caller (the slot stays absent).
 *   8. Bench-like cfg (no cwd) — slot stays undefined.
 *   9. Per-call independence — autoWiring `cfgA` then `cfgB` produces
 *      INDEPENDENT registries (separate handle pools).
 *  10. Idempotent on already-wired — calling twice on the same cfg is
 *      a no-op (caller-override-precedence applies to the FIRST wire).
 *
 * Test surface = the helper directly. We inject a fake FilesystemPort
 * so no real fs access happens.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ParsedMention } from "@/agent/mention-injection"
import { autoWirePluginActivation } from "@/agent/plugin-activation-handler"
import type { FilesystemPort } from "@/agent/plugin-discovery"
import type { AgentConfig } from "@/agent/types"
import { folderDecisionsAuthority, installWorkspaceTrustAuthority } from "@/agent/workspace-trust"

// ─── Helpers ────────────────────────────────────────────────────────────

/** Build a minimal AgentConfig-shaped object that the helper reads
 *  (only `cwd` + `activatePlugins`). Cast as AgentConfig at the seam —
 *  the helper never reads any other field. */
const makeCfg = (overrides: Partial<AgentConfig> = {}): AgentConfig => {
  const base = { cwd: "/work" } as Partial<AgentConfig>
  return { ...base, ...overrides } as AgentConfig
}

/** Build a fake FilesystemPort that backs an in-memory directory tree.
 *  Keys in `files` are absolute paths; values are the file content.
 *  Subdirectory structure is inferred from the path prefixes. */
const makeFs = (files: Record<string, string>): FilesystemPort => {
  return {
    readDir(dir: string): readonly string[] {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`
      const children = new Set<string>()
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const next = rest.split("/")[0]
        if (next !== undefined && next.length > 0) children.add(next)
      }
      return Array.from(children)
    },
    readFile(path: string): string | null {
      return files[path] ?? null
    },
  }
}

const validManifest = (id: string, mcpName: string): string =>
  JSON.stringify({
    id,
    name: id,
    capabilities: ["Read"],
    mcpServers: {
      [mcpName]: { command: "echo", args: ["hi"] },
    },
  })

const pluginMention = (target: string): ParsedMention => ({
  kind: "plugin",
  target,
  span: { start: 0, end: target.length + 9 },
  raw: `plugin://${target}`,
})

const skillMention = (target: string): ParsedMention => ({
  kind: "skill",
  target,
  span: { start: 0, end: target.length + 1 },
  raw: `@${target}`,
})

// ─── Tests ──────────────────────────────────────────────────────────────

describe("ADR-0350 — autoWirePluginActivation hellgate", () => {
  // The fixture root `/work` stands for a folder the operator trusted: plugin manifests are
  // wired only in one (workspace-trust; the untrusted refusal is pinned in
  // tests/unit/cli/workspace-trust-hellgate.test.ts).
  let restoreTrust: () => void = () => {}
  beforeEach(() => {
    restoreTrust = installWorkspaceTrustAuthority(folderDecisionsAuthority([["/work", true]]))
  })
  afterEach(() => restoreTrust())

  test("1. caller-override-precedence — pre-set activator is preserved", () => {
    const preset: AgentConfig["activatePlugins"] = async () => ({
      handles: [],
      resolvedSkills: [],
    })
    const cfg = makeCfg({ activatePlugins: preset })
    autoWirePluginActivation(cfg, { fs: makeFs({}) })
    expect(cfg.activatePlugins).toBe(preset)
  })

  test("2. empty-discovery — zero manifests leaves slot undefined", () => {
    const cfg = makeCfg()
    autoWirePluginActivation(cfg, { fs: makeFs({}) })
    expect(cfg.activatePlugins).toBeUndefined()
  })

  test("3. discovery throw — fs that throws on readDir degrades to empty", () => {
    const cfg = makeCfg()
    const hostileFs: FilesystemPort = {
      readDir(): readonly string[] {
        throw new Error("boom")
      },
      readFile(): string | null {
        return null
      },
    }
    autoWirePluginActivation(cfg, { fs: hostileFs })
    expect(cfg.activatePlugins).toBeUndefined()
  })

  test("4. discovery success — slot is populated and callable", () => {
    const fs = makeFs({
      "/work/.quanta/plugins/github/.codex-plugin/plugin.json": validManifest("github", "gh-mcp"),
    })
    const cfg = makeCfg()
    autoWirePluginActivation(cfg, { fs })
    expect(cfg.activatePlugins).toBeDefined()
    expect(typeof cfg.activatePlugins).toBe("function")
  })

  test("5. closure activation — plugin mention triggers MCP launch (failed handle from echo spawn)", async () => {
    const fs = makeFs({
      "/work/.quanta/plugins/github/.codex-plugin/plugin.json": validManifest("github", "gh-mcp"),
    })
    const cfg = makeCfg()
    autoWirePluginActivation(cfg, { fs })
    expect(cfg.activatePlugins).toBeDefined()
    const result = await cfg.activatePlugins?.([pluginMention("github")], {
      turnId: "t0",
    })
    expect(result).toBeDefined()
    // The IsolatedMcpClient is real but `echo` is NOT an MCP server, so
    // start() fails and we get a `ready: false` handle. The point of the
    // assertion is that the WIRE worked end-to-end: 1 handle attempted.
    expect(result?.handles.length).toBe(1)
    expect(result?.handles[0]?.serverId).toBe("github::gh-mcp")
  }, 30_000)

  test("6. non-plugin mention — skill-only mentions yield empty aggregation", async () => {
    const fs = makeFs({
      "/work/.quanta/plugins/github/.codex-plugin/plugin.json": validManifest("github", "gh-mcp"),
    })
    const cfg = makeCfg()
    autoWirePluginActivation(cfg, { fs })
    expect(cfg.activatePlugins).toBeDefined()
    const result = await cfg.activatePlugins?.([skillMention("review")], {
      turnId: "t0",
    })
    expect(result?.handles.length).toBe(0)
    expect(result?.resolvedSkills.length).toBe(0)
  })

  test("7. hostile frozen cfg — degrades without throwing to caller", () => {
    const fs = makeFs({
      "/work/.quanta/plugins/github/.codex-plugin/plugin.json": validManifest("github", "gh-mcp"),
    })
    const cfg = Object.freeze(makeCfg()) as AgentConfig
    // Frozen cfg — assignment will throw in strict mode. The helper wraps
    // every step in try/catch so this must NOT propagate.
    expect(() => autoWirePluginActivation(cfg, { fs })).not.toThrow()
    expect(cfg.activatePlugins).toBeUndefined()
  })

  test("8. bench-like cfg (no cwd) — slot stays undefined", () => {
    const cfg = { cwd: "" } as unknown as AgentConfig
    autoWirePluginActivation(cfg, { fs: makeFs({}) })
    expect(cfg.activatePlugins).toBeUndefined()
  })

  test("9. per-call independence — wiring two cfgs yields distinct registries", async () => {
    const fs = makeFs({
      "/work/.quanta/plugins/github/.codex-plugin/plugin.json": validManifest("github", "gh-mcp"),
    })
    const cfgA = makeCfg()
    const cfgB = makeCfg()
    autoWirePluginActivation(cfgA, { fs })
    autoWirePluginActivation(cfgB, { fs })
    expect(cfgA.activatePlugins).toBeDefined()
    expect(cfgB.activatePlugins).toBeDefined()
    // Different function references — closed over independent state.
    expect(cfgA.activatePlugins).not.toBe(cfgB.activatePlugins)
  })

  test("10. idempotent on already-wired — second call is no-op", () => {
    const fs = makeFs({
      "/work/.quanta/plugins/github/.codex-plugin/plugin.json": validManifest("github", "gh-mcp"),
    })
    const cfg = makeCfg()
    autoWirePluginActivation(cfg, { fs })
    const first = cfg.activatePlugins
    expect(first).toBeDefined()
    // Second call: caller-override-precedence catches the now-set slot.
    autoWirePluginActivation(cfg, { fs })
    expect(cfg.activatePlugins).toBe(first)
  })

  test("11. custom plugin root — discovery anchored at deps.pluginRoot, not cwd default", () => {
    const fs = makeFs({
      "/custom/root/github/.codex-plugin/plugin.json": validManifest("github", "gh-mcp"),
    })
    const cfg = makeCfg()
    autoWirePluginActivation(cfg, { fs, pluginRoot: "/custom/root" })
    expect(cfg.activatePlugins).toBeDefined()
  })

  test("12. malformed manifest — skipped silently, slot stays undefined", () => {
    const fs = makeFs({
      "/work/.quanta/plugins/broken/.codex-plugin/plugin.json": "{ not valid json",
    })
    const cfg = makeCfg()
    autoWirePluginActivation(cfg, { fs })
    expect(cfg.activatePlugins).toBeUndefined()
  })
})
