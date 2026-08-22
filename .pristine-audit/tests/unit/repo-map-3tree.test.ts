/**
 * §10.4 — file-tree 3-TREE probe (`probeRepoMap3`).
 *
 * Codex orients the model with THREE bounded directory trees at session start:
 * the cwd tree, the git-root tree (monorepo awareness — the cwd may be a
 * subpackage), and the user-home tree. quanta previously probed cwd ONLY
 * (`probeRepoMap`, turn-1). `probeRepoMap3` scans up to 3 roots IN PARALLEL,
 * EACH independently capped, DEDUPED (identical roots are scanned once), and
 * combines the results into a single labelled block.
 *
 * The single-tree `probeRepoMap` stays untouched (byte-identical for every
 * existing caller); `probeRepoMap3` is an additive superset.
 */
import { describe, expect, test } from "bun:test"
import {
  probeRepoMap,
  probeRepoMap3,
  REPO_MAP_DEFAULT_MAX_CHARS,
  REPO_MAP_DEFAULT_MAX_DEPTH,
  REPO_MAP_DEFAULT_MAX_FILES,
} from "@/agent"

describe("§10.4 probeRepoMap3 — three parallel capped scans", () => {
  test("scans cwd + gitRoot + userHome and labels each section", async () => {
    const seen: string[] = []
    const out = await probeRepoMap3({
      cwd: "/repo/pkg",
      gitRoot: "/repo",
      userHome: "/home/me",
      scan: async (o) => {
        seen.push(o.cwd)
        return `tree(${o.cwd})`
      },
    })
    expect(seen.sort()).toEqual(["/home/me", "/repo", "/repo/pkg"])
    expect(out).toContain("tree(/repo/pkg)")
    expect(out).toContain("tree(/repo)")
    expect(out).toContain("tree(/home/me)")
    // each section carries a human label so the model knows which root is which
    expect(out).toContain("cwd")
    expect(out?.toLowerCase()).toContain("git")
    expect(out?.toLowerCase()).toContain("home")
  })

  test("each root is capped INDEPENDENTLY (caps threaded per-scan)", async () => {
    const caps: Array<{ maxDepth: number; maxFiles: number; maxChars: number }> = []
    await probeRepoMap3({
      cwd: "/a",
      gitRoot: "/b",
      userHome: "/c",
      maxDepth: 4,
      maxFiles: 7,
      maxChars: 50,
      scan: async (o) => {
        caps.push({ maxDepth: o.maxDepth, maxFiles: o.maxFiles, maxChars: o.maxChars })
        return o.cwd
      },
    })
    expect(caps).toHaveLength(3)
    for (const c of caps) {
      expect(c).toEqual({ maxDepth: 4, maxFiles: 7, maxChars: 50 })
    }
  })

  test("defaults are threaded when caps omitted", async () => {
    let seen: { maxDepth: number; maxFiles: number; maxChars: number } | undefined
    await probeRepoMap3({
      cwd: "/only",
      scan: async (o) => {
        seen = { maxDepth: o.maxDepth, maxFiles: o.maxFiles, maxChars: o.maxChars }
        return o.cwd
      },
    })
    expect(seen).toEqual({
      maxDepth: REPO_MAP_DEFAULT_MAX_DEPTH,
      maxFiles: REPO_MAP_DEFAULT_MAX_FILES,
      maxChars: REPO_MAP_DEFAULT_MAX_CHARS,
    })
  })

  test("DEDUP: gitRoot === cwd ⇒ scanned ONCE (no duplicate section)", async () => {
    const seen: string[] = []
    const out = await probeRepoMap3({
      cwd: "/repo",
      gitRoot: "/repo",
      userHome: "/home/me",
      scan: async (o) => {
        seen.push(o.cwd)
        return `T(${o.cwd})`
      },
    })
    expect(seen.sort()).toEqual(["/home/me", "/repo"])
    // only ONE /repo section, even though it is both cwd and gitRoot
    expect(out?.match(/T\(\/repo\)/g)).toHaveLength(1)
  })

  test("DEDUP: userHome === cwd ⇒ scanned once", async () => {
    const seen: string[] = []
    await probeRepoMap3({
      cwd: "/home/me",
      userHome: "/home/me",
      scan: async (o) => {
        seen.push(o.cwd)
        return o.cwd
      },
    })
    expect(seen).toEqual(["/home/me"])
  })

  test("absent gitRoot + userHome ⇒ behaves like a single cwd scan", async () => {
    const seen: string[] = []
    const out = await probeRepoMap3({
      cwd: "/solo",
      scan: async (o) => {
        seen.push(o.cwd)
        return "treeBody"
      },
    })
    expect(seen).toEqual(["/solo"])
    expect(out).toContain("treeBody")
  })

  test("a root whose scan returns undefined is OMITTED (not a blank section)", async () => {
    const out = await probeRepoMap3({
      cwd: "/a",
      gitRoot: "/b",
      userHome: "/c",
      scan: async (o) => (o.cwd === "/b" ? undefined : `T(${o.cwd})`),
    })
    expect(out).toContain("T(/a)")
    expect(out).toContain("T(/c)")
    expect(out).not.toContain("/b")
  })

  test("ALL scans empty/undefined ⇒ probe returns undefined", async () => {
    expect(
      await probeRepoMap3({
        cwd: "/a",
        gitRoot: "/b",
        userHome: "/c",
        scan: async () => undefined,
      }),
    ).toBeUndefined()
  })

  test("NO-THROW: a throwing scan for one root does NOT sink the others", async () => {
    const out = await probeRepoMap3({
      cwd: "/a",
      gitRoot: "/b",
      userHome: "/c",
      scan: async (o) => {
        if (o.cwd === "/b") throw new Error("rg blew up")
        return `T(${o.cwd})`
      },
    })
    expect(out).toContain("T(/a)")
    expect(out).toContain("T(/c)")
    expect(out).not.toContain("/b")
  })

  test("NO-THROW: an all-throwing scan ⇒ undefined (never rejects)", async () => {
    const out = await probeRepoMap3({
      cwd: "/a",
      gitRoot: "/b",
      scan: async () => {
        throw new Error("boom")
      },
    })
    expect(out).toBeUndefined()
  })
})

describe("§10.4 byte-identity — single-tree probe is unchanged", () => {
  test("probeRepoMap (cwd-only) still returns the bare tree string", async () => {
    const out = await probeRepoMap({ cwd: "/repo", scan: async () => "src/\n  a.ts" })
    // No labels, no sections — the legacy single-tree contract is intact.
    expect(out).toBe("src/\n  a.ts")
  })
})
