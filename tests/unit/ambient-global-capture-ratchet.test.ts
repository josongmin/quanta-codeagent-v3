/**
 * ★ RATCHET — production code must not CAPTURE a mutable process global at
 * module load.
 *
 * WHAT WENT WRONG. `bench/run-config.ts` held `const ambientEnv = process.env`
 * at module scope and compared against it to refuse writes into the ambient env
 * — the in-process authority channel that module exists to abolish. `process.env`
 * is a BINDING, and replacing it (`process.env = { ...saved }`, which ten test
 * files in this repo do in `afterEach` and call "restore") swaps the binding
 * without touching the object. The capture is then left pointing at a dead
 * object, the identity comparison is false forever, and the rail silently stops
 * refusing. Measured with a paired control against the pre-fix code, it did not
 * merely stop throwing — it WROTE the dataset family straight into the live
 * ambient env.
 *
 * WHY A RATCHET AND NOT JUST THE FIX. Per-file isolation hides this class
 * completely: under `--isolate` every file gets a fresh global, so a stale
 * capture is unreachable and no test can go red. That one instance surfaced only
 * because a full 2,948-file corpus was run in a SHARED process, once, by hand.
 * Nothing about the normal suite would have found it, and nothing about the
 * normal suite would find the next one.
 *
 * WHAT IS NOT A HIT. `env: NodeJS.ProcessEnv = process.env` as a DEFAULT
 * PARAMETER is the sanctioned shape and is evaluated at call time — 42 sites in
 * `src/` use it, and `wireRuntimePorts` documents the reason at
 * `context-binding/base.ts`. Reading a VALUE (`process.env.FOO`) is fine too:
 * the hazard is retaining the container, not consulting it.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { assertScanPopulation } from "./_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")

/**
 * Sanctioned module-load captures, each with the reason it cannot go stale.
 * Empty, and a new entry needs a justification here — not a bumped count.
 */
const ALLOWED_MODULE_SCOPE_CAPTURES = new Set<string>()

/** The mutable process globals whose CONTAINER must not be retained. */
const CAPTURED_GLOBAL = /=\s*(process\.(?:env|argv)|globalThis)\s*(?:as[^=]*)?$/

/**
 * A module-scope binding starts at column 0 — anything indented is inside a
 * function or a class and is therefore re-evaluated per call.
 */
const MODULE_SCOPE_DECLARATION = /^(?:export\s+)?(?:const|let|var)\s/

/**
 * The discriminator against a default PARAMETER. `const f = (env = process.env)`
 * opens a parameter list before the assignment; a capture never does.
 */
export const isModuleScopeGlobalCapture = (line: string): boolean => {
  const withoutComment = line.replace(/\/\/.*$/, "").trimEnd()
  if (!MODULE_SCOPE_DECLARATION.test(withoutComment)) return false
  const match = CAPTURED_GLOBAL.exec(withoutComment)
  if (!match) return false
  return !withoutComment.slice(0, match.index).includes("(")
}

const walkTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walkTsFiles(path))
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(path)
  }
  return out
}

const collectCaptures = (): { relPath: string; line: number; text: string }[] => {
  const hits: { relPath: string; line: number; text: string }[] = []
  for (const path of walkTsFiles(SRC_DIR)) {
    const lines = readFileSync(path, "utf8").split("\n")
    lines.forEach((text, index) => {
      if (isModuleScopeGlobalCapture(text))
        hits.push({ relPath: relative(SRC_DIR, path), line: index + 1, text: text.trim() })
    })
  }
  return hits
}

describe("the detector itself — a scan nobody has tested is not evidence", () => {
  test("the ORIGINAL defect is a hit", () => {
    expect(isModuleScopeGlobalCapture("const ambientEnv: NodeJS.ProcessEnv = process.env")).toBe(
      true,
    )
    expect(isModuleScopeGlobalCapture("export const a = process.argv")).toBe(true)
    expect(isModuleScopeGlobalCapture("let g = globalThis")).toBe(true)
  })

  test("PAIRED CONTROL — the sanctioned shapes are NOT hits", () => {
    // A default parameter: evaluated per call, which is the whole point.
    expect(
      isModuleScopeGlobalCapture(
        "export const repoUrl = (env: NodeJS.ProcessEnv = process.env): string => {",
      ),
    ).toBe(false)
    // Indented — inside a function body, so re-read on every call.
    expect(isModuleScopeGlobalCapture("  const env = process.env")).toBe(false)
    // A VALUE read retains nothing.
    expect(isModuleScopeGlobalCapture("const home = process.env.HOME")).toBe(false)
    // Commented out.
    expect(isModuleScopeGlobalCapture("// const ambientEnv = process.env")).toBe(false)
  })
})

describe("src/ holds no module-load capture of a mutable process global", () => {
  test("ANTI-VACUITY — the scan actually reached src/", () => {
    // Zero hits over a tree that was never read is indistinguishable from zero
    // over a clean one.
    assertScanPopulation(walkTsFiles(SRC_DIR), SRC_DIR, {
      id: "tests/unit/ambient-global-capture-ratchet.test.ts#SRC-DIR",
    })
  })

  test("no module-scope capture of process.env / process.argv / globalThis", () => {
    const unexpected = collectCaptures().filter(
      (hit) => !ALLOWED_MODULE_SCOPE_CAPTURES.has(hit.relPath),
    )

    expect(
      unexpected.map((hit) => `${hit.relPath}:${hit.line}  ${hit.text}`),
      "A module-load capture goes stale the moment something replaces the " +
        "binding, and per-file isolation hides that permanently. Take the global " +
        "at CALL time (a default parameter is the repo's shape), or add an entry " +
        "to ALLOWED_MODULE_SCOPE_CAPTURES saying why this one cannot go stale.",
    ).toEqual([])
  })
})
