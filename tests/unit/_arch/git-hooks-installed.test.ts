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
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
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

  test("BEHAVIOUR: the hook actually REFUSES a staged file biome rejects", () => {
    // The first version of this test asserted STRINGS — that the body contained
    // "biome", "--linter-enabled=false", an "exit 1". An audit defeated it three
    // ways that all stayed green: `exit 0` after `set -e`; pass 2 turned into
    // `if false; then`; and BIOME repointed at `biome-does-not-exist` (which is
    // still a superstring of the asserted "node_modules/.bin/biome"). A guard
    // that reads the hook cannot tell whether the hook WORKS. This one runs it.
    const sandbox = mkdtempSync(join(tmpdir(), "hook-behaviour-"))
    try {
      const git = (...args: readonly string[]) =>
        Bun.spawnSync({ cmd: ["git", ...args], cwd: sandbox, stdout: "pipe", stderr: "pipe" })
      git("init", "-q")
      git("config", "user.email", "t@t")
      git("config", "user.name", "t")
      // The real hook, and the real biome — reached the way the hook reaches it,
      // by a path relative to the sandbox root.
      mkdirSync(join(sandbox, ".githooks"))
      writeFileSync(join(sandbox, ".githooks", "pre-commit"), readFileSync(HOOK, "utf8"), {
        mode: 0o755,
      })
      symlinkSync(join(REPO_ROOT, "node_modules"), join(sandbox, "node_modules"))
      writeFileSync(join(sandbox, "biome.json"), readFileSync(join(REPO_ROOT, "biome.json")))
      // REQUIRED, and the paired control below is what caught its absence: the
      // repo's biome.json sets `vcs.useIgnoreFile`, so with no `.gitignore`
      // biome exits 1 on a CONFIGURATION error for every input. The refusal arm
      // would then have passed without biome ever reading the probe — a green
      // test over a config failure.
      writeFileSync(join(sandbox, ".gitignore"), "")
      git("config", "core.hooksPath", ".githooks")

      // A file the hook's MECHANICAL pass cannot repair. `--linter-enabled=false`
      // means pass 1 only formats and organises imports; a syntax error survives
      // it and pass 2 must refuse. (An unused import is deliberately NOT used
      // here: measured, this config reports it at WARN, exit 0 — the probe has to
      // be something biome actually errors on, or the arm proves nothing.)
      writeFileSync(join(sandbox, "probe.ts"), "export const x = = 1\n")
      git("add", "probe.ts")
      const refused = git("commit", "-m", "must not land")
      const head = git("rev-parse", "--verify", "HEAD")
      expect({
        commitExit: refused.exitCode === 0,
        repoHasCommit: head.exitCode === 0,
      }).toEqual({ commitExit: false, repoHasCommit: false })

      // PAIRED CONTROL — the same file without the unused import commits, and
      // the hook's mechanical pass fixes its formatting on the way through. Without
      // this arm a hook that refused EVERYTHING would satisfy the assertion above.
      writeFileSync(join(sandbox, "probe.ts"), "export const x   =    1\n")
      git("add", "probe.ts")
      const accepted = git("commit", "-m", "lands")
      expect(accepted.exitCode).toBe(0)
      expect(readFileSync(join(sandbox, "probe.ts"), "utf8")).toBe("export const x = 1\n")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  }, 60_000)

  test("the hook never re-stages beyond the paths that were already staged", () => {
    // Not behaviour-testable without a second concurrent writer, so it stays a
    // source assertion — but a NARROW one, and the reason is load-bearing:
    // `git add -u` would sweep in another session's in-flight edits.
    const body = readFileSync(HOOK, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n")
    expect(body.length).toBeGreaterThan(200)
    expect(body).not.toMatch(/git add\s+-u/)
    expect(body).toContain("--diff-filter=ACMR")
  })
})
