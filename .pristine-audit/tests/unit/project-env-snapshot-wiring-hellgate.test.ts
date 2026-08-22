/**
 * ★ P0 INTEGRATION HELLGATE — build-env materialization is WIRED into the
 * candidate-capture snapshot path (`withGitSnapshot`), not just defined.
 *
 * The unit hellgate (`project-env-sandbox-hellgate`) proves the materialize /
 * revert primitives are correct in isolation. This proves they actually ENGAGE
 * in the real bench capture flow: `withGitSnapshot(repo)` must
 *   1. materialize the astropy env-only pyproject block AND source shim AFTER
 *      the base checkout and BEFORE the agent body runs (so the repo can build),
 *   2. surgically REVERT them BEFORE the diff is captured (so they NEVER leak
 *      into the submitted patch) — while a genuine agent edit survives.
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
import {
  PROJECT_ENV_SANDBOX_BEGIN,
  PROJECT_ENV_SOURCE_SHIM_BEGIN,
} from "@/runner/batch/corpus/project-env"
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
  writeFileSync(join(dir, "setup.py"), "from setuptools import setup\n")
  writeFileSync(
    join(dir, "setup_package.py"),
    "from setuptools.dep_util import newer_group\nVALUE = newer_group\n",
  )
  writeFileSync(join(dir, "mod.py"), "x = 1\n")
  git(dir, ["init", "-q"])
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "base"])
  const base = git(dir, ["rev-parse", "HEAD"]).trim()
  return { dir, base }
}

describe("withGitSnapshot — P0 build-env materialization wiring [gated on git]", () => {
  test.if(hasGit)(
    "repo set ⇒ pyproject block + source shim materialized during body, reverted before capture, agent edit survives",
    async () => {
      const { dir, base } = initRepo()
      try {
        let observedPyprojectDuringBody = false
        let observedSourceShimDuringBody = false
        const diff = await withGitSnapshot(
          dir,
          30_000,
          base,
          async () => {
            observedPyprojectDuringBody = readFileSync(
              join(dir, "pyproject.toml"),
              "utf8",
            ).includes(PROJECT_ENV_SANDBOX_BEGIN)
            observedSourceShimDuringBody = readFileSync(
              join(dir, "setup_package.py"),
              "utf8",
            ).includes(PROJECT_ENV_SOURCE_SHIM_BEGIN)
            // A genuine agent edit to a source file (must survive in the captured diff).
            writeFileSync(join(dir, "mod.py"), "x = 2  # AGENT-FIX\n")
          },
          "astropy/astropy",
        )
        expect(observedPyprojectDuringBody).toBe(true)
        expect(observedSourceShimDuringBody).toBe(true)
        expect(diff).not.toContain("extension-helpers")
        expect(diff).not.toContain("distutils.dep_util")
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
            PROJECT_ENV_SANDBOX_BEGIN,
          )
          writeFileSync(join(dir, "mod.py"), "x = 3  # AGENT-FIX\n")
        },
        // no repo
      )
      expect(observedDuringBody).toBe(false)
      expect(diff).not.toContain("extra-build-dependencies")
      expect(diff).not.toContain("distutils.dep_util")
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
            PROJECT_ENV_SANDBOX_BEGIN,
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
