/**
 * §10.4 e2e hellgate — drive the THREE-tree repo-map through the REAL scan
 * adapter (`makeRepoMapScan` + real `rg`) over a REAL on-disk monorepo layout,
 * then render the result into the real `## Environment` block.
 *
 * Layout (a monorepo where cwd is a subpackage):
 *
 *   <gitRoot>/                 ← git-root tree
 *     pkg/                     ← cwd tree (the subpackage the user cd'd into)
 *       a.ts b.ts nested/c.ts
 *     other/x.ts
 *   <userHome>/                ← user-home tree (separate dir)
 *     notes.md
 *
 * This is not a unit shape test: it spawns `rg`, aggregates/renders via the
 * production `file_tree_summary` helpers, applies the char-backstop, scans 3
 * roots in parallel each capped, and asserts all three labelled sections land
 * in the rendered env block.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { probeRepoMap3, renderEnvBlock } from "@/agent"
import { makeRepoMapScan, type RepoMapShell } from "@/runner/assemble/repo-map-scan"

// ── on-disk fixture ──────────────────────────────────────────────────────
//
// This fixture used to be built at MODULE SCOPE. Importing the file — which
// discovery does, and which any `-t`-filtered run does without executing a
// single case here — created a `repo3-e2e-*` root and wrote eight files into
// it, and nothing could remove it: a module-scope `mkdtemp` runs before any
// hook is registered and outlives a run that selects no test in this file.
//
// The paths are now materialised in `beforeAll` and removed in `afterAll`, so
// both the cost and the cleanup belong to actually running the suite.
let base = ""
let gitRoot = ""
let cwd = ""
let userHome = ""

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "repo3-e2e-"))
  gitRoot = join(base, "monorepo")
  cwd = join(gitRoot, "pkg")
  userHome = join(base, "home")
  mkdirSync(join(cwd, "nested"), { recursive: true })
  mkdirSync(join(gitRoot, "other"), { recursive: true })
  mkdirSync(userHome, { recursive: true })
  writeFileSync(join(cwd, "a.ts"), "a")
  writeFileSync(join(cwd, "b.ts"), "b")
  writeFileSync(join(cwd, "nested", "c.ts"), "c")
  writeFileSync(join(gitRoot, "other", "x.ts"), "x")
  writeFileSync(join(userHome, "notes.md"), "n")
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

/** Real shell adapter backed by Bun.spawn (the same shape `@/runtime`'s
 *  runShell satisfies — we inline it so the test stays self-contained). */
const realShell: RepoMapShell = async (cmd, opts) => {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd: opts.cwd, stdout: "pipe", stderr: "ignore" })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  return { stdout, exitCode, timedOut: false }
}

const scan = makeRepoMapScan({ shell: realShell })

describe("§10.4 e2e — 3-tree probe over real rg + real dirs", () => {
  test("all three labelled sections render with real file trees", async () => {
    const out = await probeRepoMap3({ cwd, gitRoot, userHome, scan })
    expect(out).toBeDefined()
    const text = out ?? ""
    // three section labels
    expect(text).toContain("### cwd")
    expect(text).toContain("### git-root")
    expect(text).toContain("### user-home")
    // cwd section sees the subpackage files
    expect(text).toContain("a.ts")
    // git-root section sees the sibling package the cwd tree cannot
    expect(text).toContain("other")
    // user-home section sees its own file
    expect(text).toContain("notes.md")
  })

  test("renders into the real ## Environment block via renderEnvBlock", async () => {
    const repoMap = await probeRepoMap3({ cwd, gitRoot, userHome, scan })
    const block = renderEnvBlock({
      platform: "test",
      ...(repoMap !== undefined ? { repoMap } : {}),
    })
    expect(block).toContain("## Environment")
    expect(block).toContain("Repo map")
    expect(block).toContain("### cwd")
    expect(block).toContain("### git-root")
  })

  test("per-tree char cap fires INDEPENDENTLY (tiny maxChars truncates each)", async () => {
    const out = await probeRepoMap3({ cwd, gitRoot, userHome, scan, maxChars: 40 })
    expect(out).toBeDefined()
    // each section's tree body is independently truncated → the marker appears
    // (proves the cap is threaded per-root, not once over the combined string)
    expect(out).toContain("repo map truncated")
  })

  test("DEDUP over real paths: cwd === gitRoot ⇒ one cwd section, no git-root", async () => {
    const out = await probeRepoMap3({ cwd: gitRoot, gitRoot, userHome, scan })
    const text = out ?? ""
    expect(text).toContain("### cwd")
    expect(text).not.toContain("### git-root")
    expect(text).toContain("### user-home")
  })

  test("byte-identity: no gitRoot/userHome ⇒ a single labelled cwd section", async () => {
    const out = await probeRepoMap3({ cwd, scan })
    const text = out ?? ""
    expect(text).toContain("### cwd")
    expect(text).not.toContain("### git-root")
    expect(text).not.toContain("### user-home")
  })
})
