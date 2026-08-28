/**
 * Hellgate — the bunfig preload must not drag production slices into every test.
 *
 * ## What this pins, and what it cost to learn
 *
 * `bunfig.toml` preloads `tests/setup.ts`, which runs before EVERY test file in
 * the repo. It exists to reset process-global state between cases, and it needs
 * four setters to do that. Reaching them through barrels pulled their whole
 * graphs along:
 *
 *   tests/setup.ts
 *     → @/agent/branch-search-runner → @/agent/loop → @/agent/session-resources
 *       → @/tool          (a 973-line barrel re-exporting all of src/tool)
 *     → @/agent/lsp-bridge → lsp-bridge/diagnostics → @/tool
 *
 * Measured before the cut: **1,259 files of `src/` loaded by the preload, 284 of
 * them under `src/tool` and 25 under `src/agent/loop`**. After importing the
 * leaves instead: **71 files, 0 and 0**.
 *
 * ## Why it is worth a gate rather than a comment
 *
 * It is not only start-up cost. It made a class of test infrastructure
 * impossible. `tools/dev/empty-mirror-check.ts` decides whether a guard would
 * notice its corpus vanishing by running it against a mirror with that corpus
 * emptied — and a mirror with `src/tool` emptied could not START, because the
 * preload died with `Cannot find module '@/tool'` before any guard ran. Two
 * attempts to work around it from outside failed identically: a static import
 * closure restored 281 of the 284, and an execution-driven fixpoint took 107
 * seconds to restore the same set. The corpus and the runtime have to be
 * separable, and that is a property of the preload, not of the tool.
 *
 * ## Why it inspects a REAL child process
 *
 * A static import walk is what produced the 2,301 figure that turned out to
 * count comments and type-only imports. The number that matters is what bun
 * actually loads, so this spawns a real `bun test` with the real bunfig and asks
 * the runtime which modules are resident. A guard about runtime behaviour that
 * measures source text is the same "clean vs I never looked" mistake one level
 * up.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")

/**
 * Run a probe under the REAL bunfig and report every `src/` module the runtime
 * ended up with.
 *
 * The probe is written into the repo's own `tests/` tree, not a temp directory,
 * so it is preloaded exactly like any other test file — a probe outside the tree
 * would not pick up `bunfig.toml` at all and would report a clean closure for
 * the wrong reason.
 */
const loadedSrcModules = (): readonly string[] => {
  const dir = mkdtempSync(join(REPO_ROOT, "tests", "zz-preload-probe-"))
  const probe = join(dir, "probe.test.ts")
  writeFileSync(
    probe,
    [
      `import { test } from "bun:test"`,
      `test("report the runtime module set", () => {`,
      `  const loaded = Object.keys(require.cache ?? {})`,
      `  process.stdout.write("MODULES:" + JSON.stringify(loaded) + "\\n")`,
      `})`,
      ``,
    ].join("\n"),
  )
  try {
    const proc = Bun.spawnSync(["bun", "test", probe], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    })
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`
    const line = /MODULES:(\[.*\])/.exec(out)
    if (line === null) return []
    return (JSON.parse(line[1] as string) as string[])
      .map((p) => (p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p))
      .filter((p) => p.startsWith("src/"))
      .sort()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("preload runtime closure", () => {
  const loaded = loadedSrcModules()

  test("anti-vacuity: the probe actually ran under the real preload", () => {
    // Without this every assertion below passes when the probe fails to start,
    // returns [], or is silently not preloaded — "no tools loaded" and "nothing
    // loaded at all" are the same empty array. `tests/setup.ts` itself must be
    // resident, and it pulls a handful of `src/shared` modules with it.
    expect(
      loaded.length,
      "the probe reported no src/ modules — it did not run preloaded",
    ).toBeGreaterThan(10)
  })

  test("🔴 the preload loads NOTHING under src/tool", () => {
    const tools = loaded.filter((p) => p.startsWith("src/tool/"))
    expect(
      tools,
      tools.length === 0
        ? ""
        : "the bunfig preload reaches src/tool again. It was 284 files, and it made a " +
            "mirror with src/tool emptied impossible to start — see the header. Import the " +
            `leaf that holds the symbol, not the barrel:\n  ${tools.slice(0, 10).join("\n  ")}`,
    ).toEqual([])
  })

  test("🔴 the preload loads NOTHING under src/agent/loop", () => {
    const loop = loaded.filter((p) => p.startsWith("src/agent/loop"))
    expect(
      loop,
      loop.length === 0
        ? ""
        : `the preload reaches the agent loop again:\n  ${loop.slice(0, 10).join("\n  ")}`,
    ).toEqual([])
  })

  test("the total stays under a one-directional ceiling", () => {
    // 71 measured after the cut, from 1,259 before. The ceiling is headroom for
    // ordinary drift, not for a barrel: a single re-added barrel import is worth
    // hundreds and blows straight through it.
    expect(loaded.length).toBeLessThanOrEqual(120)
  })

  test("🔴 the override cell is a leaf — no value imports", () => {
    // The property the preload depends on. `run-agent-override.ts` may reference
    // `runAgent` for its type and nothing else; a value import there silently
    // reopens the whole graph, and the assertions above would only catch it
    // after the fact.
    const src = readFileSyncSafe(
      join(REPO_ROOT, "src", "agent", "branch-search-runner", "run-agent-override.ts"),
    )
    expect(src.length, "the leaf is missing — it is what setup.ts imports").toBeGreaterThan(200)
    const valueImports = src
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l))
    expect(
      valueImports,
      valueImports.length === 0
        ? ""
        : `the override leaf gained a value import:\n  ${valueImports.join("\n  ")}`,
    ).toEqual([])
  })
})

function readFileSyncSafe(path: string): string {
  try {
    return require("node:fs").readFileSync(path, "utf8") as string
  } catch {
    return ""
  }
}
