/**
 * Hellgate — the sandboxed runner must actually contain a relative write.
 *
 * `tools/dev/sandboxed-test.ts` runs the suite from a throwaway working directory
 * so that a stray relative write lands somewhere disposable instead of in the repo
 * root. Its pure parts are pinned by `sandboxed-test-runner.test.ts`; what is NOT
 * pinned anywhere is the property the whole tool exists for.
 *
 * That gap matters more than it looks. The tool's own summary line reads
 * "clean — N sandbox(es) empty, 0 untracked repo path(s) before and after",
 * and a runner that silently executed at the repo root would print exactly the
 * same sentence: the sandbox it created would be empty because nothing ran in it,
 * and the repo would look unchanged because the guard compares before/after rather
 * than location. A self-report that reads identically in the success and the
 * failure case is not evidence.
 *
 * So this asserts BOTH sides of the containment, which is the only combination a
 * misconfigured runner cannot fake:
 *
 *   - the file appears in the SANDBOX (so the fixture really ran and really wrote)
 *   - the file does NOT appear in the REPO (so the write was contained)
 *
 * Either alone is satisfiable by an accident. Together they are not.
 *
 * ## Why this is a hellgate and not a unit test
 *
 * It drives the real runner as a subprocess against a real fixture. A pure test
 * over `walkRelative` would pass on a runner that never sets `cwd` at all —
 * `sandboxed-test-runner.test.ts` already covers the pure half, and it passed
 * throughout the period when nothing pointed at the tool.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/** A name nothing else in the repo uses, so a hit is unambiguous. */
const STRAY = "sandbox-containment-probe.txt"

describe("sandbox containment", () => {
  test("🔴 a relative write from a test lands in the sandbox, NOT in the repo", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "sbx-containment-"))
    const fixture = join(fixtureDir, "stray-writer.test.ts")
    const repoStray = join(REPO_ROOT, STRAY)

    // Guard: if this path already exists the assertion below would be meaningless.
    expect(
      existsSync(repoStray),
      `${STRAY} already exists at the repo root — a previous run leaked it`,
    ).toBe(false)

    writeFileSync(
      fixture,
      [
        `import { test, expect } from "bun:test"`,
        `import { writeFileSync } from "node:fs"`,
        `test("writes a bare relative path", () => {`,
        `  writeFileSync("${STRAY}", "contained")`,
        `  expect(1).toBe(1)`,
        `})`,
        "",
      ].join("\n"),
    )

    try {
      const run = Bun.spawnSync(
        ["bun", "run", join(REPO_ROOT, "tools", "dev", "sandboxed-test.ts"), fixture],
        { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
      )
      const output = `${run.stdout.toString()}${run.stderr.toString()}`

      // Anti-vacuity: the fixture must have RUN. Without this the containment
      // assertion below passes for free whenever the runner fails to start.
      expect(output, "the fixture did not run — containment is untested").toContain("1 pass")

      // The sandbox is removed by the runner on a clean run, so the evidence that
      // the write landed there is the runner's own leak report naming the file.
      expect(
        output,
        "the runner did not report the stray inside its sandbox — the write went somewhere else",
      ).toContain(STRAY)

      // And the half that actually protects the repo.
      expect(
        existsSync(repoStray),
        `${STRAY} reached the REPO ROOT — the runner did not contain the write`,
      ).toBe(false)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
      rmSync(repoStray, { force: true })
    }
  }, 120_000)
})
