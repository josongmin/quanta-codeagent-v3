/**
 * Parity guard: every `SLICE_BOUNDARY_CONFIGS` key MUST have a matching
 * `tests/unit/<slice>-slice-boundary.test.ts` entrypoint, and vice-versa.
 *
 * Why this exists: a per-slice config is INERT unless an entrypoint file calls
 * `registerSliceBoundarySuite(getSliceBoundaryConfig(slice))`. A config that is
 * registered but never wired to an entrypoint is dead config — it silently
 * enforces nothing. This guard closes that failure mode: it checks not just that
 * the entrypoint FILE exists, but that its CONTENT actually wires the suite for
 * the matching slice. An empty / commented-out / wrong-slice entrypoint therefore
 * fails "no inert/dead config" rather than sneaking past a filename-only check.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { nth } from "../_helpers/expect-present"
import { SLICE_BOUNDARY_CONFIGS } from "./_arch/slice-boundary-configs"

const UNIT_DIR = dirname(fileURLToPath(import.meta.url))
const ENTRYPOINT_RE = /^([a-z0-9-]+)-slice-boundary\.test\.ts$/

/** Every file matching the `<slice>-slice-boundary.test.ts` name shape. */
const entrypointFileNames = (): ReadonlyArray<readonly [string, string]> => {
  const out: Array<[string, string]> = []
  for (const name of readdirSync(UNIT_DIR)) {
    const m = ENTRYPOINT_RE.exec(name)
    if (m) out.push([nth(m, 1, "entrypoint match groups"), name])
  }
  return out
}

const literalText = (node: ts.Node): string | null =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null

/**
 * True iff the source contains a REAL (AST, not commented/quoted) call
 * `registerSliceBoundarySuite(getSliceBoundaryConfig("<slice>"))`. Using the AST
 * — not a text/regex scan — is what defeats the inert-entrypoint failure mode:
 * a commented-out call is not a node, and the string `"...suite(...)"` is a
 * StringLiteral, not a CallExpression, so neither can masquerade as wired.
 */
const fileWiresSlice = (text: string, slice: string): boolean => {
  const sf = ts.createSourceFile("entry.ts", text, ts.ScriptTarget.Latest, true)
  let wired = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "registerSliceBoundarySuite"
    ) {
      const arg = node.arguments[0]
      if (
        arg !== undefined &&
        ts.isCallExpression(arg) &&
        ts.isIdentifier(arg.expression) &&
        arg.expression.text === "getSliceBoundaryConfig" &&
        arg.arguments[0] !== undefined &&
        literalText(arg.arguments[0]) === slice
      ) {
        wired = true
      }
    }
    if (!wired) ts.forEachChild(node, visit)
  }
  visit(sf)
  return wired
}

/** Slices whose entrypoint file exists AND actually wires the suite for itself. */
const wiredSlices = (): Set<string> => {
  const out = new Set<string>()
  for (const [slice, name] of entrypointFileNames()) {
    const text = readFileSync(join(UNIT_DIR, name), "utf8")
    if (fileWiresSlice(text, slice)) out.add(slice)
  }
  return out
}

describe("slice-boundary config <-> entrypoint parity", () => {
  test("every registered config has a WIRED entrypoint (no inert/dead config)", () => {
    const configs = new Set(Object.keys(SLICE_BOUNDARY_CONFIGS))
    const wired = wiredSlices()
    // A config whose entrypoint is missing OR exists-but-inert both land here.
    const configsWithoutWiredEntrypoint = [...configs].filter((s) => !wired.has(s)).sort()
    expect(configsWithoutWiredEntrypoint).toEqual([])
  })

  test("every entrypoint file maps to a registered config (no dangling entrypoint)", () => {
    const configs = new Set(Object.keys(SLICE_BOUNDARY_CONFIGS))
    const fileSlices = entrypointFileNames().map(([slice]) => slice)
    const entrypointsWithoutConfig = fileSlices.filter((s) => !configs.has(s)).sort()
    expect(entrypointsWithoutConfig).toEqual([])
  })
})
