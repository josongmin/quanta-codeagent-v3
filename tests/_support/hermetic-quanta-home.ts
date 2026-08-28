/**
 * Hermetic Quanta home for tests (aug-28).
 *
 * WHY THIS EXISTS — measured, not hypothetical. `quantaHomeDirFrom(env)` resolves
 * `QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`, so an injected `env` bag of
 * `{}` — which reads like "no configuration, fully isolated" — resolves to the
 * DEVELOPER'S REAL HOME. Measured on this machine:
 *
 *   stickyModelFilePath({})            → /Users/<me>/.quanta/sticky-model.json
 *   resolveStickyModelBoot({env: {}})  → adopts whatever pick is in that file
 *
 * Once the interactive surface began PERSISTING `/model` picks there, three
 * suites that compose the real surface wires with `{}` (or with `process.env`)
 * started reading a file the developer's own `/model` writes: a local pick could
 * change their outcome, and a suite that dispatches a set could write to it. That
 * is a test that passes or fails based on the machine it runs on.
 *
 * Use this for ANY test that builds a composition root taking an env bag. It
 * returns a bag rooted at a fresh scratch dir; call {@link cleanupHermeticQuantaHomes}
 * from `afterEach`/`afterAll` (a leaked `mkdtemp` per case is its own measured
 * hazard here — `/tmp` growth has taken `ls /tmp`-shaped tests over their timeout).
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const created: string[] = []

/** A fresh scratch Quanta home. Returns the directory; register cleanup below. */
export const hermeticQuantaHomeDir = (label = "quanta-home"): string => {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`))
  created.push(dir)
  return dir
}

/**
 * An env bag whose Quanta home is a fresh scratch dir. `base` is spread FIRST so
 * a caller's own keys survive, but `QUANTA_CONFIG_DIR` is applied AFTER on
 * purpose: a caller passing `process.env` must not be able to re-point the home
 * at the real one by accident (which is exactly how the defect above shipped).
 */
export const hermeticQuantaHomeEnv = (
  base: NodeJS.ProcessEnv = {},
  label = "quanta-home",
): NodeJS.ProcessEnv => ({ ...base, QUANTA_CONFIG_DIR: hermeticQuantaHomeDir(label) })

/** Remove every scratch home this module handed out. Idempotent. */
export const cleanupHermeticQuantaHomes = (): void => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
}
