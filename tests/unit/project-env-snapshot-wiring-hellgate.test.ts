/**
 * ★ P0 INTEGRATION HELLGATE — build-env materialization is WIRED into the
 * candidate-capture snapshot path (`withGitSnapshot`), not just defined.
 *
 * The unit hellgate (`project-env-sandbox-hellgate`) proves the materialize /
 * revert primitives are correct in isolation. This proves they actually ENGAGE
 * in the real bench capture flow: `withGitSnapshot(repo)` must
 *   1. materialize `[tool.uv.extra-build-dependencies]` into pyproject.toml AFTER
 *      the base checkout and BEFORE the agent body runs (so the repo can build),
 *   2. surgically REVERT the env-only block BEFORE the diff is captured (so it
 *      NEVER leaks into the submitted patch) — while a genuine agent edit to the
 *      SAME and OTHER files survives.
 *
 * red-on-injection: passing `repo=undefined` (the legacy path) must leave the
 * block out entirely AND, were the revert severed, the `repo="astropy/astropy"`
 * capture would carry the block — pinned by asserting the diff is block-free yet
 * the body OBSERVED the block (so prep genuinely ran, the assertion is not vacuous).
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withGitSnapshot } from "@/runner/batch/eval/snapshot"

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0

const git = (cwd: string, args: readonly string[]): string =>
  spawnSync(
    "git",
    ["-c", "user.email=b@b", "-c", "user.name=b", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  ).stdout ?? ""

const initRepo = (): { dir: string; base: string } => {
  const dir = mkdtempSync(join(tmpdir(), "pe-snap-"))
  writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "astropy"\n')
  writeFileSync(join(dir, "mod.py"), "x = 1\n")
  git(dir, ["init", "-q"])
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "base"])
  const base = git(dir, ["rev-parse", "HEAD"]).trim()
  return { dir, base }
}

const BLOCK_MARK = "extra-build-dependencies"

describe("withGitSnapshot — P0 build-env materialization wiring [gated on git]", () => {
  test.if(hasGit)(
    "repo set ⇒ block materialized during body, reverted before capture, agent edit survives",
    async () => {
      const { dir, base } = initRepo()
      try {
        let observedDuringBody = false
        const diff = await withGitSnapshot(
          dir,
          30_000,
          base,
          async () => {
            // PREP must have run AFTER checkout, BEFORE body: the table is present.
            observedDuringBody = readFileSync(join(dir, "pyproject.toml"), "utf8").includes(
              BLOCK_MARK,
            )
            // A genuine agent edit to a source file (must survive in the captured diff).
            writeFileSync(join(dir, "mod.py"), "x = 2  # AGENT-FIX\n")
          },
          "astropy/astropy",
        )
        // PREP engaged (assertion is non-vacuous — the block really was injected).
        expect(observedDuringBody).toBe(true)
        // REVERT engaged: the env-only block is absent from the captured patch.
        expect(diff).not.toContain(BLOCK_MARK)
        expect(diff).not.toContain("extension-helpers")
        // The genuine agent edit survives.
        expect(diff).toContain("x = 2  # AGENT-FIX")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  test.if(hasGit)("repo undefined ⇒ legacy path, no block ever appears (default-OFF)", async () => {
    const { dir, base } = initRepo()
    try {
      let observedDuringBody = true
      const diff = await withGitSnapshot(
        dir,
        30_000,
        base,
        async () => {
          observedDuringBody = readFileSync(join(dir, "pyproject.toml"), "utf8").includes(
            BLOCK_MARK,
          )
          writeFileSync(join(dir, "mod.py"), "x = 3  # AGENT-FIX\n")
        },
        // no repo
      )
      expect(observedDuringBody).toBe(false)
      expect(diff).not.toContain(BLOCK_MARK)
      expect(diff).toContain("x = 3  # AGENT-FIX")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.if(hasGit)("non-build-dep repo (django) ⇒ no materialization (override-gated)", async () => {
    const { dir, base } = initRepo()
    try {
      let observedDuringBody = true
      await withGitSnapshot(
        dir,
        30_000,
        base,
        async () => {
          observedDuringBody = readFileSync(join(dir, "pyproject.toml"), "utf8").includes(
            BLOCK_MARK,
          )
        },
        "django/django",
      )
      expect(observedDuringBody).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
