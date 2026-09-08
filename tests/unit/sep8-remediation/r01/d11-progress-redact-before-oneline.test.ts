/**
 * SEP7-D-11.4 — progress free-text must call redactStr THEN oneLine on the
 * same expression. Bare `redactStr` identifiers (import/comment) do not count.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const STDOUT = join(import.meta.dir, "../../../../src/stream/adapters/stdout.ts")

const extractSite = (src: string, startNeedle: string, endNeedle: string): string | undefined => {
  const start = src.indexOf(startNeedle)
  if (start < 0) return undefined
  const end = src.indexOf(endNeedle, start + startNeedle.length)
  if (end < 0) return undefined
  return src.slice(start, end)
}

const ONELINE_CALL = /oneLine\s*\(/g
const REDACT_THEN_ONELINE = /oneLine\s*\(\s*redactStr\s*\(/
const ONELINE_WITHOUT_REDACT_CALL = /oneLine\s*\(\s*(?!redactStr\s*\()/

type ProgressCheck = {
  readonly sites: number
  readonly failures: readonly string[]
}

export const checkProgressRedactsBeforeOneLine = (src: string): ProgressCheck => {
  const sites = [
    extractSite(src, 'case "tool_progress":', "break"),
    extractSite(src, "const renderInProgress", "const formatTokenCount"),
  ].filter((s): s is string => typeof s === "string" && s.length > 0)
  const failures: string[] = []
  if (sites.length < 2) {
    failures.push(`anti-vacuum: expected ≥2 progress sites, found ${sites.length}`)
  }
  for (const [i, site] of sites.entries()) {
    const oneLineCalls = site.match(ONELINE_CALL) ?? []
    if (oneLineCalls.length === 0) {
      failures.push(`site ${i} has no oneLine( call`)
      continue
    }
    if (!REDACT_THEN_ONELINE.test(site)) {
      failures.push(`site ${i} missing oneLine(redactStr( call`)
    }
    if (ONELINE_WITHOUT_REDACT_CALL.test(site)) {
      failures.push(`site ${i} has oneLine( without a preceding redactStr( on that expression`)
    }
  }
  return { sites: sites.length, failures }
}

const asGreenClone = (src: string): string =>
  src.replace(/oneLine\(event\.message\)/g, "oneLine(redactStr(event.message))")

describe("SEP7-D-11.4 progress redactStr-then-oneLine ratchet", () => {
  const src = readFileSync(STDOUT, "utf8")

  test("anti-vacuum: both progress sites exist and call oneLine(", () => {
    const check = checkProgressRedactsBeforeOneLine(src)
    expect(check.sites).toBeGreaterThanOrEqual(2)
  })

  test("both progress sites redactStr then oneLine on the same expression", () => {
    const check = checkProgressRedactsBeforeOneLine(src)
    expect(check.failures).toEqual([])
  })

  test("red-on-injection: dropping redactStr from one site fails the checker", () => {
    const green = asGreenClone(src)
    expect(checkProgressRedactsBeforeOneLine(green).failures).toEqual([])
    const mutated = green.replace(
      /oneLine\s*\(\s*redactStr\s*\(\s*event\.message\s*\)\s*\)/,
      "oneLine(event.message)",
    )
    expect(mutated).not.toBe(green)
    const check = checkProgressRedactsBeforeOneLine(mutated)
    expect(check.failures.length).toBeGreaterThan(0)
  })

  test("red-on-injection: a bare redactStr identifier does not satisfy the call pattern", () => {
    const green = asGreenClone(src)
    const mutated = green.replace(
      /oneLine\s*\(\s*redactStr\s*\(\s*event\.message\s*\)\s*\)/,
      "oneLine(event.message) /* redactStr */",
    )
    expect(mutated.includes("/* redactStr */")).toBe(true)
    const check = checkProgressRedactsBeforeOneLine(mutated)
    expect(check.failures.length).toBeGreaterThan(0)
  })
})
