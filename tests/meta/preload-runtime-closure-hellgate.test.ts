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
 * Measured before the cut: **1,202 files of `src/` loaded by the preload, 270 of
 * them under `src/tool` and 27 under `src/agent/loop`**. After importing the
 * leaves instead: **67 files, 0 and 0**. (An earlier commit message said
 * 1,259/284/25 → 71; those came from a static import walk that counted comments
 * and type-only edges. These are from the runtime, re-measured three times.)
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

import { beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  loadOrProducePreloadClosureArtifact,
  type PreloadClosureArtifact,
} from "../../tools/dev/preload-closure-probe"

const REPO_ROOT = join(import.meta.dir, "..", "..")

/**
 * ## Why the child processes moved out of this file (TVH-11)
 *
 * `describe` callbacks run at MODULE LOAD under bun:test, so
 * `describe("...", () => { const loaded = loadedSrcModules() })` started a
 * nested `bun test` DURING DISCOVERY — importing this file spawned a bun
 * process and wrote a directory into the repo. A second test then started a
 * separate `bun run`. Neither is wrong to do; both were wrong to do at import,
 * inside an ordinary meta suite.
 *
 * `tools/dev/preload-closure-probe.ts` is the `meta-runtime` producer: ONE
 * invocation, both probes, one small artifact. A runner that produces the
 * artifact up front (`QUANTA_PRELOAD_CLOSURE_ARTIFACT`) makes this file
 * spawn-free entirely; without one, `beforeAll` produces it once — still after
 * discovery, and once for the whole file rather than twice.
 */
describe("preload runtime closure", () => {
  let artifact: PreloadClosureArtifact
  let loaded: readonly string[]

  beforeAll(() => {
    artifact = loadOrProducePreloadClosureArtifact(REPO_ROOT)
    loaded = artifact.loadedSrcModules
  }, 120_000)

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
    // 47 measured after moving the remaining observability/shared imports to
    // leaves, from 1,202 before. The ceiling is headroom for
    // ordinary drift, not for a barrel: a single re-added barrel import is worth
    // hundreds and blows straight through it.
    expect(loaded.length).toBeLessThanOrEqual(60)
  })

  test("global hot reload stays disabled while the interactive dev command opts in", () => {
    const bunfig = readFileSyncSafe(join(REPO_ROOT, "bunfig.toml"))
    const pkg = JSON.parse(readFileSyncSafe(join(REPO_ROOT, "package.json"))) as {
      scripts?: Record<string, string>
    }
    expect(bunfig).not.toMatch(/\[run\][\s\S]*?\bhot\s*=\s*true/)
    expect(pkg.scripts?.dev).toContain("--hot")
  })

  test("source cleanup uses Dirent metadata and exposes the managed-runner skip contract", () => {
    const preload = readFileSyncSafe(join(REPO_ROOT, "tests", "preload-clean-source-js.ts"))
    expect(preload.length).toBeGreaterThan(500)
    expect(preload).toMatch(/readdirSync\([^)]*\{\s*withFileTypes:\s*true\s*\}\)/)
    expect(preload).toMatch(/entry\.isDirectory\s*\(\s*\)/)
    expect(preload).not.toContain("lstatSync")
    expect(preload).toContain("SOURCE_JS_CLEANED_ROOT_ENV")
    expect(preload).toMatch(
      /process\.env\[SOURCE_JS_CLEANED_ROOT_ENV\][^\n]+cleanStaleSourceJs\s*\(/,
    )
  })

  test("🔴 the preload still DOES its job — the reset hooks are wired and effective", () => {
    // A ceiling on module count makes the cheapest way to go greener "delete the
    // hooks". Measured: removing both setter imports AND both reset calls from
    // `tests/setup.ts` left this gate at 5 pass — a gate that rewards gutting the
    // thing it guards. So the hooks are asserted present, by name.
    const setup = readFileSyncSafe(join(REPO_ROOT, "tests", "setup.ts"))
    expect(setup.length, "tests/setup.ts is missing — it IS the preload").toBeGreaterThan(500)
    for (const hook of [
      "__setBranchRunAgentForTest",
      "__setLspAvailabilityOverrideForTest",
      "__resetSpanSink",
      "__resetRuntimeConfig",
    ]) {
      expect(setup.includes(hook), `tests/setup.ts no longer calls ${hook}`).toBe(true)
    }
  })

  test("🔴 the moved cell still resets — a silent no-op setter passes everything else", () => {
    // The wiring proof the relocation shipped without. Making the setter ignore
    // `null` — exactly what a careless refactor across the new module boundary
    // produces — left this gate AND all four branch-search suites green. Nothing
    // in the repo noticed that the preload's `afterEach(… (null))` had stopped
    // clearing the slot.
    //
    // Still driven through the same import path `tests/setup.ts` uses, in a REAL
    // child process, so a re-export that silently becomes a different binding
    // fails here too — the probe just lives in the producer now (TVH-11).
    expect(
      artifact.overrideRoundTrip.ok,
      `the override cell does not round-trip set→clear:\n${artifact.overrideRoundTrip.output}`,
    ).toBe(true)
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
