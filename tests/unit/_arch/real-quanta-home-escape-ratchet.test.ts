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
import { stripComments } from "../_shared/strip-comments"

const ROOT = resolve(import.meta.dir, "../../..")

/** Composition roots that take an env bag AND resolve the Quanta home from it
 *  UNCONDITIONALLY — calling one at all reads the home. */
const ROOT_CALLS = ["composeSurfaceWires(", "buildSurfaceCoreState(", "createWebModelSwitch("]

/** The headless root (`buildBaseFromArgs`) reads the sticky file only when the
 *  caller asks for the FS-BACKED store; with the in-memory default it peeks an
 *  empty map and never touches disk. So it is exposed only in COMBINATION — which
 *  is exactly the trap worth ratcheting: measured when this was written, zero bare
 *  callers enable the fs store, and the next one to do so would start reading the
 *  config of whoever runs the suite. `CompositionSeams.stickyModelPath` is the seam
 *  for the case where `QUANTA_CONFIG_DIR` cannot be moved (it is embedded in the
 *  rendered system prompt, so moving it shifts a byte-identical fingerprint). */
const CONDITIONAL_ROOT_CALLS = ["buildBaseFromArgs("]
const FS_STORE_MARKERS = ["stickyModel: true", '"--sticky-model"', "stickyModel:true"]

/** Any spelling that provably re-points the home away from `~/.quanta`. A
 *  file-local `mkdtemp` + `QUANTA_CONFIG_DIR` counts (several suites predate the
 *  shared helper and are hermetic by hand — the requirement is the isolation, not
 *  one import). */
const HERMETIC_MARKERS = [
  "QUANTA_CONFIG_DIR",
  "QUANTA_HOME",
  "hermeticQuantaHomeEnv",
  "stickyModelPath",
]

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
/** Does `file` CONTAIN one of `needles` in CODE (not in a comment)?
 *
 *  Through the SHARED stripper (`tests/unit/_shared/strip-comments`), per this
 *  repo's own burn-down ratchet: a guard that rolls its own comment scan is the
 *  documented way guards get defeated, and the line-prefix version this had
 *  first would also mis-read a trailing `// composeSurfaceWires(` as a call. */
const codeOf = (file: string): string => stripComments(readFileSync(join(ROOT, file), "utf8"))

const containsAny = (file: string, needles: readonly string[]): boolean => {
  const code = codeOf(file)
  return needles.some((needle) => code.includes(needle))
}

const composingFiles = (): readonly string[] =>
  testFiles().filter((file) => containsAny(file, ROOT_CALLS))

/** Files that drive the headless root WITH the fs-backed store — exposed only in
 *  that combination (see {@link CONDITIONAL_ROOT_CALLS}). */
const fsStoreRootFiles = (): readonly string[] =>
  testFiles().filter(
    // BOTH probes skip comment-only lines: a docblock that merely NAMES the root
    // or explains why the suite avoids the fs store is not an exposure, and a
    // ratchet that reds on prose gets edited around instead of obeyed.
    (file) => containsAny(file, CONDITIONAL_ROOT_CALLS) && containsAny(file, FS_STORE_MARKERS),
  )

const unhermetic = (files: readonly string[]): readonly string[] =>
  files.filter((file) => !containsAny(file, HERMETIC_MARKERS))

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
    // Adding a suite here is not a lint nit: it means `bun test` can read — and
    // on a dispatched set, WRITE — the config of whoever runs it.
    expect(unhermetic(composingFiles())).toEqual([])
  }, 60_000)

  test("the headless root + the FS-backed store is hermetic too (the latent combination)", () => {
    expect(unhermetic(fsStoreRootFiles())).toEqual([])
  }, 60_000)
})
