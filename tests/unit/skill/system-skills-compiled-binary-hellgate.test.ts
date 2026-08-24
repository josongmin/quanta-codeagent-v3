/**
 * HELLGATE — the shipped CLI must actually carry its bundled system skills.
 *
 * `systemSkillsDir()` derives its path from `import.meta.url` and
 * `discoverSystemSkills()` then `readdir`s it. From source that resolves to
 * `src/skill/system-skills` and finds every bundled skill. The shipped artifact
 * is a single-file `bun build --compile` binary, where `import.meta.url` is
 * `/$bunfs/root/…` — a directory that does not exist.
 *
 * Measured before this fix, on a compiled binary run outside the repo:
 *
 *     systemSkillsDir() -> /$bunfs/root      (does not exist)
 *     discoverSystemSkills() -> []           (source: 22 skills)
 *
 * So the shipping CLI silently offered ZERO bundled system skills — no
 * `progress-audit`, no `debug-error`, no `review-and-ship` — while every unit
 * test passed, because they run from source. The module's own doc conceded the
 * shape ("the SKILL.md files must be shipped alongside the binary") but a
 * single-file binary has no alongside.
 *
 * This is the third instance of one class: a slice that resolves a runtime asset
 * from its own on-disk location works in dev and dies when compiled. The other
 * two were the shell security authority and the retrieval code-parser.
 *
 * The test compiles a real binary and runs it FROM OUTSIDE THE REPO. Both halves
 * are load-bearing: `import.meta.url`-derived paths and `createRequire` both
 * fall back to the current working directory inside a compiled binary, so a
 * probe run from the repo root passes even when the artifact is broken.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = new URL("../../../", import.meta.url).pathname

/** The skills on disk — the number the compiled binary has to match. */
const skillDirsOnDisk = (): string[] =>
  readdirSync(join(REPO_ROOT, "src/skill/system-skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

describe("system skills survive `bun build --compile`", () => {
  test(
    "a compiled binary run outside the repo discovers every bundled skill",
    async () => {
      const expectedNames = skillDirsOnDisk()
      expect(expectedNames.length).toBeGreaterThan(0)

      // The probe entry must live INSIDE the repo so bare specifiers (`@/…`)
      // resolve at build time.
      const entry = join(REPO_ROOT, `__compiled-skills-probe-${process.pid}.ts`)
      const out = mkdtempSync(join(tmpdir(), "compiled-skills-"))
      const bin = join(out, "probe")
      try {
        writeFileSync(
          entry,
          [
            `import { discoverSystemSkills } from "@/skill/system-skills"`,
            `const s = await discoverSystemSkills()`,
            `console.log(JSON.stringify({ names: s.map((x) => x.name).sort() }))`,
          ].join("\n"),
          "utf8",
        )
        const build = Bun.spawnSync({
          cmd: ["bun", "build", "--compile", entry, "--outfile", bin],
          cwd: REPO_ROOT,
        })
        expect(build.exitCode).toBe(0)

        // cwd OUTSIDE the repo: inside it, the bundled-path fallbacks hide the bug.
        const run = Bun.spawnSync({ cmd: [bin], cwd: out })
        const stdout = new TextDecoder().decode(run.stdout).trim()
        const parsed = JSON.parse(stdout.split("\n").at(-1) ?? "{}") as { names?: string[] }
        expect(parsed.names ?? []).toEqual(expectedNames)
      } finally {
        rmSync(entry, { force: true })
        rmSync(out, { recursive: true, force: true })
      }
    },
    { timeout: 180_000 },
  )

  test("PAIRED CONTROL — the same discovery from source is unchanged", async () => {
    const { discoverSystemSkills } = await import("@/skill/system-skills")
    const names = (await discoverSystemSkills()).map((s) => s.name).sort()
    // Whatever the compiled binary must produce, source already produces. A fix
    // that broke the dev path to satisfy the compiled one would pass the test
    // above and destroy every developer's session.
    expect(names).toEqual(skillDirsOnDisk())
  })

  test("DRIFT GUARD — the generated manifest matches the tree", async () => {
    // The manifest is what the bundler can see. If a skill is added to the tree
    // and the manifest is not regenerated, the skill works in dev and is ABSENT
    // from the shipped binary — silently, which is the exact failure this whole
    // change removes. Regenerate in-memory and compare rather than trusting the
    // committed file.
    const { renderManifest, systemSkillNames } = await import(
      "../../../tools/dev/gen-system-skills-manifest"
    )
    const expected = renderManifest(systemSkillNames())
    const actual = await Bun.file(
      join(REPO_ROOT, "src/skill/system-skills/manifest.generated.ts"),
    ).text()
    expect(actual).toBe(expected)
  })

  test("the manifest is not vacuous — it names every skill on disk", async () => {
    const { SYSTEM_SKILL_ASSETS } = await import("@/skill/system-skills/manifest.generated")
    expect([...SYSTEM_SKILL_ASSETS].map((a) => a.name).sort()).toEqual(skillDirsOnDisk())
  })
})
