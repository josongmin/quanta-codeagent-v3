/**
 * Receipt consumer: assert that named test FILES ran GREEN inside an existing
 * JUnit receipt, instead of executing them a second time.
 *
 * WHY. The prepush/CI gate set used to re-run `pm-dod-ratchet.test.ts` and the
 * preload-closure hellgate standalone even though the full-suite runner had
 * just executed both — every gate re-buying coverage the campaign already paid
 * for. The full runner's merged junit is the execution receipt; this script
 * derives the per-gate verdict from it.
 *
 * FAIL-CLOSED, NON-VACUOUS. A file that is absent from the receipt, has zero
 * testcases, is entirely skipped, or has any failure/error fails the gate —
 * "the receipt does not mention it" is never a pass.
 *
 * Usage: bun run tools/dev/junit-file-green.ts <junit.xml> <file.ts> [more...]
 */

import { readFileSync } from "node:fs"

const [xmlPath, ...files] = process.argv.slice(2)
if (xmlPath === undefined || files.length === 0) {
  console.error("usage: junit-file-green.ts <junit.xml> <test-file> [more test files...]")
  process.exit(1)
}

let xml: string
try {
  xml = readFileSync(xmlPath, "utf8")
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`junit-file-green: cannot read receipt ${xmlPath}: ${message}`)
  process.exit(1)
}

interface SuiteTotals {
  tests: number
  failures: number
  errors: number
  skipped: number
  suites: number
}

const attr = (tag: string, name: string): number => {
  const value = new RegExp(`\\b${name}="([0-9]+)"`).exec(tag)?.[1]
  return value === undefined ? 0 : Number.parseInt(value, 10)
}

const totalsFor = (file: string): SuiteTotals => {
  const totals: SuiteTotals = { tests: 0, failures: 0, errors: 0, skipped: 0, suites: 0 }
  for (const tag of xml.match(/<testsuite\b[^>]*>/g) ?? []) {
    const suiteFile = /\bfile="([^"]*)"/.exec(tag)?.[1]
    if (suiteFile !== file) continue
    totals.suites += 1
    totals.tests += attr(tag, "tests")
    totals.failures += attr(tag, "failures")
    totals.errors += attr(tag, "errors")
    totals.skipped += attr(tag, "skipped")
  }
  return totals
}

let failed = false
for (const file of files) {
  const totals = totalsFor(file)
  const executed = totals.tests - totals.skipped
  if (totals.suites === 0) {
    console.error(`junit-file-green: ${file} — NOT PRESENT in ${xmlPath}; refusing to pass`)
    failed = true
  } else if (totals.tests === 0 || executed <= 0) {
    console.error(
      `junit-file-green: ${file} — vacuous receipt (tests=${totals.tests} skipped=${totals.skipped})`,
    )
    failed = true
  } else if (totals.failures > 0 || totals.errors > 0) {
    console.error(
      `junit-file-green: ${file} — RED in receipt (failures=${totals.failures} errors=${totals.errors})`,
    )
    failed = true
  } else {
    console.log(
      `junit-file-green: ${file} — green in receipt (tests=${totals.tests} skipped=${totals.skipped})`,
    )
  }
}
process.exit(failed ? 1 : 0)
