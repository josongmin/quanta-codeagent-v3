import { describe, expect, test } from "bun:test"
import {
  type AgentConfig,
  probeRepoMap,
  REPO_MAP_DEFAULT_MAX_CHARS,
  REPO_MAP_DEFAULT_MAX_DEPTH,
  REPO_MAP_DEFAULT_MAX_FILES,
  renderEnvBlock,
  type TurnEnvContext,
} from "@/agent"
import { repoMapKnob } from "@/runner/knobs/knobs/repo-map"

/**
 * RFC jun-6 §6.1 — repo-map turn-0 injection hellgate (TDD red→green).
 *
 * A bounded directory tree is rendered into the `## Environment` block on turn 1
 * only, behind `QUANTA_REPO_MAP`. The renderer stays PURE (replay-deterministic);
 * the live scan lives in `probeRepoMap`'s injected `scan` adapter. Three caps
 * (depth / file-count / char-backstop) bound turn-0. Default-OFF byte-identical.
 */

describe("repo-map — renderEnvBlock injection + byte-identity", () => {
  const baseEnv: TurnEnvContext = {
    platform: "darwin arm64 24.6.0",
    shell: "/bin/zsh",
    gitStatus: "M 5",
    pkgMgr: "bun",
  }

  test("repoMap absent ⇒ env block byte-identical to no-map path (default-OFF)", () => {
    const withoutField = renderEnvBlock(baseEnv)
    // An explicit `undefined` repoMap (exactOptionalPropertyTypes-safe via a
    // built record) must render byte-identically to the field being absent.
    const withUndefined = renderEnvBlock({ ...baseEnv, ...({ repoMap: undefined } as object) })
    expect(withUndefined).toBe(withoutField)
    // And it is exactly the pre-feature four-line block (no repo-map header).
    expect(withoutField).toBe(
      "## Environment\nPlatform: darwin arm64 24.6.0\nShell: /bin/zsh\nGit: M 5\nPackage manager: bun",
    )
    expect(withoutField).not.toContain("Repo map")
  })

  test("repoMap present ⇒ stale-tolerant header + tree appended after pkg manager", () => {
    const tree = "src/ (2)\n  index.ts\n  app.ts"
    const out = renderEnvBlock({ ...baseEnv, repoMap: tree })
    expect(out).toContain("Repo map (bounded, may be incomplete or out of date")
    expect(out).toContain("do not repeat back unless relevant")
    expect(out).toContain(tree)
    // Order: the repo map rides AFTER the package-manager line.
    const idxPkg = (out as string).indexOf("Package manager:")
    const idxMap = (out as string).indexOf("Repo map")
    expect(idxMap).toBeGreaterThan(idxPkg)
  })

  test("renderer is PURE / replay-deterministic — same input ⇒ identical bytes", () => {
    const env = { ...baseEnv, repoMap: "a/ (1)\n  x.ts" }
    expect(renderEnvBlock(env)).toBe(renderEnvBlock(env))
  })

  test("ONLY repoMap set (no other field) ⇒ block still renders the map", () => {
    const out = renderEnvBlock({ repoMap: "src/ (1)\n  a.ts" })
    expect(out).toContain("## Environment")
    expect(out).toContain("Repo map")
    expect(out).toContain("src/ (1)")
  })

  test("fully empty env (no repoMap, no fields) ⇒ undefined (zero bytes)", () => {
    expect(renderEnvBlock({})).toBeUndefined()
  })

  test("no memory / CLAUDE.md body duplication — only paths, never contents", () => {
    // The repoMap is a STRUCTURE string (paths + counts). A CLAUDE.md sentinel
    // body never appears: the map lists the filename, never the file contents.
    const tree = "./ (2)\n  CLAUDE.md\n  README.md"
    const out = renderEnvBlock({ ...baseEnv, repoMap: tree }) as string
    expect(out).toContain("CLAUDE.md") // the NAME is in the tree
    expect(out).not.toContain("SENTINEL_MEMORY_BODY_DO_NOT_LEAK") // no body text
  })
})

describe("repo-map — probeRepoMap (injected scan, no-throw, caps threaded)", () => {
  test("scan returns a tree ⇒ probe returns it; defaults threaded", async () => {
    let seen: { maxDepth: number; maxFiles: number; maxChars: number } | undefined
    const out = await probeRepoMap({
      cwd: "/repo",
      scan: async (o) => {
        seen = { maxDepth: o.maxDepth, maxFiles: o.maxFiles, maxChars: o.maxChars }
        return "src/ (1)\n  a.ts"
      },
    })
    expect(out).toBe("src/ (1)\n  a.ts")
    expect(seen).toEqual({
      maxDepth: REPO_MAP_DEFAULT_MAX_DEPTH,
      maxFiles: REPO_MAP_DEFAULT_MAX_FILES,
      maxChars: REPO_MAP_DEFAULT_MAX_CHARS,
    })
  })

  test("explicit caps override the defaults", async () => {
    let seen: { maxDepth: number; maxFiles: number; maxChars: number } | undefined
    await probeRepoMap({
      cwd: "/repo",
      maxDepth: 5,
      maxFiles: 10,
      maxChars: 99,
      scan: async (o) => {
        seen = { maxDepth: o.maxDepth, maxFiles: o.maxFiles, maxChars: o.maxChars }
        return "x"
      },
    })
    expect(seen).toEqual({ maxDepth: 5, maxFiles: 10, maxChars: 99 })
  })

  test("scan throws ⇒ probe returns undefined (no-throw contract)", async () => {
    const out = await probeRepoMap({
      cwd: "/repo",
      scan: async () => {
        throw new Error("rg blew up")
      },
    })
    expect(out).toBeUndefined()
  })

  test("scan returns undefined / empty / whitespace ⇒ undefined", async () => {
    expect(await probeRepoMap({ cwd: "/r", scan: async () => undefined })).toBeUndefined()
    expect(await probeRepoMap({ cwd: "/r", scan: async () => "" })).toBeUndefined()
    expect(await probeRepoMap({ cwd: "/r", scan: async () => "   \n  " })).toBeUndefined()
  })
})

describe("repo-map — bench surface now in SURFACES", () => {
  test("HELL-bench: applyRepoMap applies when surface='bench' and env is set", () => {
    // Red-on-injection: if 'bench' is removed from SURFACES in repo-map.ts,
    // this test turns red — proves the wiring is real, not vacuous.
    const knob = repoMapKnob
    const parsed = knob.parse("1")
    expect(parsed).not.toBeUndefined()
    // Inert partial config: applyRepoMap only reads/writes the repoMap slot, so
    // the empty llm/registry stubs are cast (through unknown) to the real shape.
    const baseCfg = { llm: {}, registry: {} } as unknown as AgentConfig
    const ctx = { surface: "bench" as const }
    const result = knob.apply(baseCfg, parsed!, ctx)
    expect(result.repoMap).toBeDefined()
    expect(result.repoMap?.maxDepth).toBeGreaterThan(0)
    expect(result.repoMap?.maxFiles).toBeGreaterThan(0)
  })

  test("HELL-bench-off: bench surface WITHOUT QUANTA_REPO_MAP=1 ⇒ no repoMap", () => {
    const knob = repoMapKnob
    const parsed = knob.parse(undefined) // not set
    expect(parsed).toBeUndefined()
  })
})
