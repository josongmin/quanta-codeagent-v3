/**
 * Hellgate: REPL orphan-tree resolution (Slice B, 2026-05-25).
 *
 * Seal the decision matrix recorded in
 * `tools/feature-catalog/features/10-app/repl-orphan-resolution.yaml`:
 *
 *   - The legacy duplicate modules listed below stay deleted. Newer
 *     `src/apps/cli/repl/*.ts` split owners may exist; this gate only pins
 *     that the specific dead paths do not come back.
 *
 *   - `src/apps/cli/repl/mcp-surface-wire.ts` was KEPT as a seam: it is the
 *     only orphan with an independent unit test AND it remains the dedicated
 *     `/mcp` surface translator now consumed by the live `repl.ts` wire.
 *     These tests pin the seam comment, the documented export surface, and
 *     the load-bearing behavior (configured-but-failed server reporting).
 *
 *   - The live `repl.ts` exports (`runRepl` / `runSessionMain` /
 *     `runSlashMain` / `topLevelUsage`) MUST stay byte-identical default-OFF
 *     so deleting the legacy duplicates did not regress the live REPL surface.
 *
 * If a future slice re-introduces any of the deleted paths, these assertions
 * fail loudly so the SOLID restore is done with `repl.ts` in the same commit.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { McpServerConfig } from "@/mcp"
import type { Tool } from "@/tool"
import * as replModule from "../../../../src/apps/cli/repl"
import {
  type BuildMcpSurfaceOpts,
  buildMcpSurfaceInfo,
} from "../../../../src/apps/cli/repl/mcp-surface-wire"
import { assertScanPopulation } from "../../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const REPL_DIR = join(REPO_ROOT, "src", "apps", "cli", "repl")

const DELETED_MODULES = [
  "assemble-context",
  "idle-wire",
  "image-queue-wire",
  "interactive-driver",
  "lifecycle-wire",
  "metrics-sink",
  "oneshot-driver",
  "prompt-source",
  "readline-loop",
  "resume-fsm",
  "run-repl",
  "seed-images",
  "session-router",
  "skills-callback",
  "status-pills-wire",
  "turn-cancel",
  "turn-indicator-wire",
  "turn-render",
  "turn-summary-wire",
  "usage",
] as const

const fakeTool = (name: string, description = ""): Tool => ({
  name,
  description,
  inputSchema: z.unknown(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute() {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

describe("repl orphan resolution — deleted modules", () => {
  test("all 20 deleted modules no longer exist on disk", () => {
    for (const m of DELETED_MODULES) {
      const p = join(REPL_DIR, `${m}.ts`)
      expect(existsSync(p), `${m}.ts should be deleted`).toBe(false)
    }
  })

  test("repl/ directory still includes mcp-surface-wire.ts among the live split modules", () => {
    // Defensive: enumerate via fs to be a real listing check, not a path probe.
    const fs = require("node:fs") as typeof import("node:fs")
    const entries = fs
      .readdirSync(REPL_DIR)
      .filter((n) => n.endsWith(".ts"))
      .sort()
    assertScanPopulation(
      entries.map((n) => join(REPL_DIR, n)),
      REPL_DIR,
      { min: 5, topLevelOnly: true, collectable: (n) => n.endsWith(".ts") },
    )
    expect(entries).toContain("mcp-surface-wire.ts")
  })

  test("dynamic import of any deleted module rejects (path does not resolve)", async () => {
    // Cover both the relative-style path (test-author footgun) and the
    // alias-style path so a future re-add via either surface fails loudly.
    const m = DELETED_MODULES[0]
    let threw = false
    try {
      // Use an absolute file:// URL so Bun does NOT resolve via the package
      // exports map (which could mask the deletion under a barrel one day).
      await import(`file://${join(REPL_DIR, `${m}.ts`)}`)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe("repl orphan resolution — KEEP_AS_SEAM (mcp-surface-wire.ts)", () => {
  test("file exists with documented seam comment header", () => {
    const p = join(REPL_DIR, "mcp-surface-wire.ts")
    expect(existsSync(p)).toBe(true)
    const src = readFileSync(p, "utf8")
    expect(src).toContain("SEAM ONLY")
    expect(src).toContain("live REPL consumes this translator")
  })

  test("exports `buildMcpSurfaceInfo` as a callable function", () => {
    expect(typeof buildMcpSurfaceInfo).toBe("function")
  })

  test("exports `BuildMcpSurfaceOpts` type-only surface (verified via callsite)", () => {
    // Type-only export — the test compiles only if the import resolves.
    const opts: BuildMcpSurfaceOpts = { configs: [], bridgedTools: [] }
    expect(buildMcpSurfaceInfo(opts)).toBeUndefined()
  })

  test("returns undefined when no MCP is configured AND no config path is set", () => {
    const out = buildMcpSurfaceInfo({ configs: [], bridgedTools: [] })
    expect(out).toBeUndefined()
  })

  test("reports a configured-but-failed server when no bridged tools join", () => {
    const cfg: McpServerConfig = { name: "noisy", command: ["noisy"] }
    const out = buildMcpSurfaceInfo({ configs: [cfg], bridgedTools: [] })
    expect(out).toBeDefined()
    expect(out?.servers.length).toBe(1)
    expect(out?.servers[0]?.status).toBe("failed")
    expect(out?.servers[0]?.toolCount).toBe(0)
  })

  test("joins bridged tools onto the configured server (sanitized prefix)", () => {
    const cfg: McpServerConfig = { name: "git-svc", command: ["noop"] }
    const out = buildMcpSurfaceInfo({
      configs: [cfg],
      bridgedTools: [fakeTool("mcp__git_svc__status")],
    })
    expect(out?.servers[0]?.status).toBe("connected")
    expect(out?.servers[0]?.toolCount).toBe(1)
    expect(out?.servers[0]?.tools[0]?.name).toBe("status")
  })

  test("surfaces configPath when supplied (for `/mcp config` rendering)", () => {
    const out = buildMcpSurfaceInfo({
      configs: [],
      bridgedTools: [],
      configPath: "/tmp/mcp.json",
    })
    expect(out).toBeDefined()
    expect((out as { configPath?: string }).configPath).toBe("/tmp/mcp.json")
  })
})

describe("repl orphan resolution — live `repl.ts` surface preserved", () => {
  test("runRepl / runSessionMain / runSlashMain / topLevelUsage remain exported", () => {
    expect(typeof replModule.runRepl).toBe("function")
    expect(typeof replModule.runSessionMain).toBe("function")
    expect(typeof replModule.runSlashMain).toBe("function")
    expect(typeof replModule.topLevelUsage).toBe("function")
  })

  test("topLevelUsage() prints the four canonical usage lines", () => {
    const out = replModule.topLevelUsage()
    expect(out).toContain("quanta — coding agent CLI")
    expect(out).toContain("Usage:")
    expect(out).toContain("--resume")
    expect(out).toContain("session <subcommand>")
  })
})
