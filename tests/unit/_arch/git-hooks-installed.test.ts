/**
 * A hook nobody installed is a hook that does not exist.
 *
 * `.githooks/pre-commit` is tracked, but git only runs it when `core.hooksPath`
 * points there — and `core.hooksPath` lives in `.git/config`, which is NOT
 * tracked. So the hook can be present, reviewed, and completely inert, and the
 * only symptom is the thing it was meant to prevent quietly continuing to
 * happen. That is the exact "a guard nobody's command can reach" shape this
 * repo keeps rediscovering (`lint:debt` lived only as a package script for
 * months; the PTY suite ran in no workflow and rotted unseen).
 *
 * `postinstall` wires it on every `bun install`, and `bun run hooks:install`
 * does it on demand — this test is what makes a missing wire LOUD instead of
 * silent, and names the one command that fixes it.
 *
 * It also pins WHAT the hook does, because a hook that stopped calling biome
 * would keep passing an existence check while enforcing nothing.
 */

import { describe, expect, test } from "bun:test"
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const HOOK = join(REPO_ROOT, ".githooks", "pre-commit")

const gitConfig = (key: string): string => {
  const r = Bun.spawnSync({ cmd: ["git", "config", "--get", key], cwd: REPO_ROOT })
  return new TextDecoder().decode(r.stdout).trim()
}

describe("git pre-commit hook is installed and does what it claims", () => {
  test("the hook file exists and is executable", () => {
    // A non-executable hook is skipped by git SILENTLY — no warning, no error.
    expect(statSync(HOOK).isFile()).toBe(true)
    expect(() => accessSync(HOOK, constants.X_OK)).not.toThrow()
  })

  test("core.hooksPath points at it (else the hook is inert)", () => {
    expect({
      hooksPath: gitConfig("core.hooksPath"),
      fix: "bun run hooks:install",
    }).toEqual({ hooksPath: ".githooks", fix: "bun run hooks:install" })
  })

  test("the hook still enforces through biome, and re-stages only staged paths", () => {
    const raw = readFileSync(HOOK, "utf8")
    // CODE ONLY. The first draft of this test matched `git add -u` inside the
    // hook's own comment explaining why it must never do that — a scanner that
    // reads prose as code, which is the failure mode the repo's comment-stripper
    // ratchet exists for.
    const body = raw
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n")
    expect(body.length).toBeGreaterThan(200) // anti-vacuity: comments are not the whole file
    // The enforcement itself.
    expect(body).toContain("node_modules/.bin/biome")
    expect(body).toContain("--diff-filter=ACMR")
    // The write pass must stay MECHANICAL — a `--write` with the linter enabled
    // would delete an unused import (a semantic edit) behind the committer.
    expect(body).toContain("--linter-enabled=false")
    // Never `git add -u`: that sweeps in a concurrent session's in-flight edits.
    expect(body).not.toMatch(/git add\s+-u/)
    // And it must be able to FAIL, or it is decoration.
    expect(body).toContain("exit 1")
  })
})
