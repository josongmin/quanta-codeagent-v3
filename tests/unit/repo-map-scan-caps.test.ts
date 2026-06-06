import { describe, expect, test } from "bun:test"
import {
  makeRepoMapScan,
  REPO_MAP_TRUNCATION_MARKER,
  type RepoMapShell,
  truncateRepoMap,
} from "@/runner/assemble/repo-map-scan"

/**
 * RFC jun-6 §6.1 — the THREE token-budget caps fire (depth / file-count /
 * char-backstop). The scan adapter reuses `file_tree_summary`'s pure
 * aggregate/render and applies the char backstop; the rg call is injected so
 * tests pass canned stdout (fully deterministic, no shell).
 */

/** Build an injected shell returning a fixed `rg --files` stdout. */
const shellWith = (stdout: string, exitCode = 0): RepoMapShell => {
  return async () => ({ stdout, exitCode, timedOut: false })
}

describe("repo-map scan — char-backstop (cap 3, shape-independent)", () => {
  test("truncateRepoMap cuts on a line boundary + appends the marker", () => {
    const rendered = "line-one\nline-two\nline-three-is-long"
    const out = truncateRepoMap(rendered, 12)
    expect(out.endsWith(REPO_MAP_TRUNCATION_MARKER)).toBe(true)
    expect(out).toContain("line-one")
    // No partial line survives the cut.
    expect(out).not.toContain("line-three-is-long")
  })

  test("truncateRepoMap is a no-op when the string already fits", () => {
    const rendered = "short\ntree"
    expect(truncateRepoMap(rendered, 10_000)).toBe(rendered)
  })

  test("adversarial: many distinct files ⇒ output ≤ ~maxChars (char-cap fires)", async () => {
    // 5000 distinct filenames at depth 1, file-cap raised high so the CHAR cap
    // is the binding constraint — the shape-independent backstop.
    const files = Array.from({ length: 5000 }, (_, i) => `file${i}.ts`).join("\n")
    const scan = makeRepoMapScan({ shell: shellWith(files) })
    const out = await scan({ cwd: "/r", maxDepth: 2, maxFiles: 10_000, maxChars: 6000 })
    expect(out).toBeDefined()
    // The body is bounded by maxChars; the marker is a fixed tail.
    expect((out as string).length).toBeLessThanOrEqual(6000 + REPO_MAP_TRUNCATION_MARKER.length + 2)
    expect(out as string).toContain(REPO_MAP_TRUNCATION_MARKER)
  })
})

describe("repo-map scan — file-count cap (cap 1) + depth rollup (cap 2)", () => {
  test("file-count cap fires ⇒ file-cap marker present", async () => {
    // 400 files in one dir, capped at 50 ⇒ aggregate truncates + marks it.
    const files = Array.from({ length: 400 }, (_, i) => `src/f${i}.ts`).join("\n")
    const scan = makeRepoMapScan({ shell: shellWith(files) })
    const out = await scan({ cwd: "/r", maxDepth: 3, maxFiles: 50, maxChars: 100_000 })
    expect(out).toContain("file cap 50 reached")
  })

  test("depth cap fires ⇒ deep subtree rolls up into a +N marker", async () => {
    const files = ["a/b.ts", "a/deep/c/d/e.ts", "a/deep/c/d/f.ts"].join("\n")
    const scan = makeRepoMapScan({ shell: shellWith(files) })
    const out = await scan({ cwd: "/r", maxDepth: 2, maxFiles: 200, maxChars: 100_000 })
    expect(out).toContain("deeper")
  })
})

describe("repo-map scan — failure / empty paths", () => {
  test("rg exit > 1 ⇒ undefined", async () => {
    const scan = makeRepoMapScan({ shell: shellWith("", 2) })
    expect(await scan({ cwd: "/r", maxDepth: 2, maxFiles: 200, maxChars: 6000 })).toBeUndefined()
  })

  test("rg exit 1 (no matches / empty repo) ⇒ undefined", async () => {
    const scan = makeRepoMapScan({ shell: shellWith("", 1) })
    expect(await scan({ cwd: "/r", maxDepth: 2, maxFiles: 200, maxChars: 6000 })).toBeUndefined()
  })

  test("timed-out shell ⇒ undefined", async () => {
    const scan = makeRepoMapScan({
      shell: async () => ({ stdout: "src/a.ts", exitCode: 0, timedOut: true }),
    })
    expect(await scan({ cwd: "/r", maxDepth: 2, maxFiles: 200, maxChars: 6000 })).toBeUndefined()
  })

  test("happy path ⇒ a real bounded alpha-sorted tree", async () => {
    const scan = makeRepoMapScan({ shell: shellWith("src/b.ts\nsrc/a.ts\nREADME.md") })
    const out = (await scan({ cwd: "/r", maxDepth: 2, maxFiles: 200, maxChars: 6000 })) as string
    expect(out).toContain("src/")
    // alpha order within dir: a.ts before b.ts.
    expect(out.indexOf("a.ts")).toBeLessThan(out.indexOf("b.ts"))
  })
})
