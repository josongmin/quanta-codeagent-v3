/**
 * ★ RATCHET — no test may compose a real surface against the DEVELOPER'S HOME
 * (aug-28).
 *
 * THE DEFECT, MEASURED. `quantaHomeDirFrom(env)` resolves
 * `QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`. So an injected env bag of `{}`
 * — which reads like "no config at all, fully isolated" — resolves to the real
 * home. On this machine:
 *
 *   stickyModelFilePath({})           → /Users/<me>/.quanta/sticky-model.json
 *   resolveStickyModelBoot({env:{}})  → adopts the pick stored in that file
 *
 * That was harmless while nothing on the composed surface touched the home. It
 * stopped being harmless the moment `/model` picks began PERSISTING there: three
 * suites composing the real surface wires with `{}` (or `process.env`) began
 * reading a file the developer's own `/model` writes — a test whose outcome
 * depends on the machine — and a suite that dispatched a set could write to it.
 *
 * WHY A RATCHET AND NOT JUST THE THREE FIXES. The hazard is structural: the
 * dangerous spelling (`{}`) is shorter than the safe one and looks MORE hermetic,
 * so the next author reaches for it. This enumerates every test that builds one of
 * the real composition roots and requires it to root the Quanta home at a scratch
 * dir. `expected` is an explicit allowlist so ADDING an exposed suite fails HERE,
 * with the reason, rather than silently touching a developer's config.
 *
 * RED-on-injection: revert any of the three suites to `env` / `process.env` and
 * this reds naming that file.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { Glob } from "bun"

const ROOT = resolve(import.meta.dir, "../../..")

/** Composition roots that take an env bag AND resolve the Quanta home from it. */
const ROOT_CALLS = ["composeSurfaceWires(", "buildSurfaceCoreState(", "createWebModelSwitch("]

/** Any spelling that provably re-points the home away from `~/.quanta`. A
 *  file-local `mkdtemp` + `QUANTA_CONFIG_DIR` counts (several suites predate the
 *  shared helper and are hermetic by hand — the requirement is the isolation, not
 *  one import). */
const HERMETIC_MARKERS = ["QUANTA_CONFIG_DIR", "QUANTA_HOME", "hermeticQuantaHomeEnv"]

const testFiles = (): readonly string[] => {
  const out: string[] = []
  for (const dir of ["tests", "src"]) {
    for (const rel of new Glob("**/*.test.ts").scanSync(join(ROOT, dir))) {
      out.push(relative(ROOT, join(ROOT, dir, rel)))
    }
  }
  return out.sort()
}

/** Files that CALL a composition root (not merely mention one in prose). A
 *  docblock naming `composeSurfaceWires` is not an exposure, so the scan requires
 *  the call form and ignores comment-only lines. */
const composingFiles = (): readonly string[] =>
  testFiles().filter((file) => {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n")
    return lines.some((line) => {
      const code = line.trimStart()
      if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return false
      return ROOT_CALLS.some((call) => code.includes(call))
    })
  })

describe("no test composes a real surface against the developer's ~/.quanta", () => {
  test("the scan is non-degenerate (a rename fails loud, not vacuously)", () => {
    // If the composition roots are renamed this list empties and the parity
    // assertion below would trivially pass — so pin that it cannot be empty.
    expect(composingFiles().length).toBeGreaterThan(2)
  })

  // BUDGET, not decoration. Measured on a full `bun test tests/unit tests/meta
  // tests/adversarial` run (39,118 arms, 3,034 files): this arm took 5,973ms
  // against bun's 5,000ms default and FAILED — reporting a guard violation
  // when the truth was that a repo-wide scan did not finish in time. Exactly
  // four arms in the whole suite exceed 2,500ms, and all four are repo-wide
  // source scans; unloaded this one passes in well under a second. A false
  // accusation is worse than a slow test: it trains the reader to discount the
  // gate, and it cost a real misattribution on 2026-08-28 before the four were
  // re-run serially and all passed. A genuine hang is still bounded by the
  // outer `timeout` on the suite command.
  test("every composing test roots the Quanta home at a scratch dir", () => {
    const exposed = composingFiles().filter((file) => {
      const source = readFileSync(join(ROOT, file), "utf8")
      return !HERMETIC_MARKERS.some((marker) => source.includes(marker))
    })
    // Adding a suite here is not a lint nit: it means `bun test` can read — and
    // on a dispatched set, WRITE — the config of whoever runs it.
    expect(exposed).toEqual([])
  }, 60_000)
})
