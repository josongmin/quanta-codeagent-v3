/**
 * `tools/test-resilience/quarantine` — what a quarantine entry has to PROVE.
 *
 * # The ledger as it was
 *
 * ```jsonc
 * { "file": "...", "name": "...", "resourceClass": "timing", "reason": "..." }
 * ```
 *
 * Four fields, none of them checked against anything outside the file. The
 * consequences, in the order they bite:
 *
 *   - **No owner, no issue.** An entry is a promise that someone will fix the
 *     test. With nobody named, the promise is to nobody.
 *   - **No expiry.** The single live entry has been quarantined since
 *     2026-06-16. Nothing in the repository would ever have noticed.
 *   - **No first-seen SHA and no fingerprint.** So "is this still the same
 *     flake?" is unanswerable: the test can start failing for a completely
 *     different reason and stay quarantined under the old excuse.
 *   - **No existence check.** `name` is matched as a substring of whatever
 *     failed. A renamed or deleted test leaves an entry that matches nothing —
 *     and an entry that matches nothing is indistinguishable, from inside the
 *     ledger, from one that is doing its job.
 *
 * # What is validated here
 *
 * Every field is required, and three of them are checked against the WORLD
 * rather than against the schema: `expiresAt` against the clock, the
 * `(file, name)` pair against the test names actually declared in that file,
 * and `criticality` against the deny-list in `verification-first-failure`.
 *
 * A name that matches MORE than one live test is a violation too. Substring
 * matching is how `-t` works, so an ambiguous entry silently quarantines tests
 * nobody reviewed — the expansion is invisible precisely because it needs no
 * edit to happen.
 */

import ts from "typescript"
import { mayQuarantine } from "../dev/verification-first-failure"
import type { QuarantineEntry, QuarantineLedger } from "./parse"

export interface QuarantineEntryV2 extends QuarantineEntry {
  /** Who owes the fix. Never empty. */
  readonly owner: string
  /** Ticket / issue id that tracks the fix. */
  readonly issue: string
  /** 40-hex sha at which the flake was first recorded. */
  readonly firstSeenSha: string
  /** Failure fingerprint the quarantine covers (see failure-artifact.ts). */
  readonly fingerprint: string
  /** What the test claims it needs to run — the contention hypothesis. */
  readonly resourceClaim: string
  /** ISO-8601 date. On or after it, the entry is RED. */
  readonly expiresAt: string
  readonly criticality: "blocking" | "non-blocking"
}

export interface QuarantineLedgerV2 extends QuarantineLedger {
  readonly entries: readonly QuarantineEntryV2[]
}

export type QuarantineViolationKind =
  | "ratchet-breach"
  | "missing-field"
  | "expired"
  | "unknown-test"
  | "ambiguous-test"
  | "critical-test"
  | "duplicate"

export interface QuarantineViolation {
  readonly kind: QuarantineViolationKind
  readonly entry: string
  readonly detail: string
}

/**
 * Every test name DECLARED in a source file.
 *
 * AST, not regex, for the same reason the determinism scanner is: this
 * repository's test titles routinely quote other test titles, and a guard test
 * that says `test("no fixture is drawn from Math.random()")` must not be read
 * as declaring a test called `Math.random()`. Only the first argument of a
 * `test`/`it` call counts, and only when it is a literal — a computed name
 * cannot be matched against a ledger entry anyway.
 */
export const declaredTestNames = (file: string, text: string): readonly string[] => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names: string[] = []
  const calleeRoot = (node: ts.Expression): string => {
    let cursor: ts.Node = node
    while (ts.isPropertyAccessExpression(cursor) || ts.isCallExpression(cursor)) {
      cursor = ts.isCallExpression(cursor) ? cursor.expression : cursor.expression
    }
    return ts.isIdentifier(cursor) ? cursor.text : ""
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = calleeRoot(node.expression)
      if (root === "test" || root === "it") {
        const first = node.arguments[0]
        if (first !== undefined && ts.isStringLiteralLike(first)) names.push(first.text)
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return names
}

export interface QuarantineWorld {
  readonly nowMs: number
  /** Source of the entry's file, or `undefined` when the file is gone. */
  readonly readTestSource: (file: string) => string | undefined
}

const REQUIRED_TEXT: readonly (keyof QuarantineEntryV2)[] = [
  "file",
  "name",
  "owner",
  "issue",
  "resourceClaim",
  "reason",
]

const fieldViolations = (
  entry: QuarantineEntryV2,
  label: string,
): readonly QuarantineViolation[] => {
  const out: QuarantineViolation[] = []
  for (const field of REQUIRED_TEXT) {
    const value = entry[field]
    if (typeof value !== "string" || value.trim() === "") {
      out.push({ kind: "missing-field", entry: label, detail: `${field} is required` })
    }
  }
  if (!/^[a-f0-9]{40}$/.test(entry.firstSeenSha ?? "")) {
    out.push({ kind: "missing-field", entry: label, detail: "firstSeenSha must be a 40-hex sha" })
  }
  if (!/^[a-f0-9]{64}$/.test(entry.fingerprint ?? "")) {
    out.push({
      kind: "missing-field",
      entry: label,
      detail: "fingerprint must be a 64-hex failure fingerprint",
    })
  }
  if (entry.criticality !== "blocking" && entry.criticality !== "non-blocking") {
    out.push({
      kind: "missing-field",
      entry: label,
      detail: "criticality must be 'blocking' or 'non-blocking'",
    })
  }
  if (Number.isNaN(Date.parse(entry.expiresAt ?? ""))) {
    out.push({ kind: "missing-field", entry: label, detail: "expiresAt must be an ISO-8601 date" })
  }
  return out
}

const existenceViolations = (
  entry: QuarantineEntryV2,
  label: string,
  world: QuarantineWorld,
): readonly QuarantineViolation[] => {
  const source = world.readTestSource(entry.file)
  if (source === undefined) {
    return [{ kind: "unknown-test", entry: label, detail: `${entry.file} does not exist` }]
  }
  const matches = declaredTestNames(entry.file, source).filter((name) => name.includes(entry.name))
  if (matches.length === 0) {
    return [
      {
        kind: "unknown-test",
        entry: label,
        detail: `no test in ${entry.file} contains "${entry.name}" — renamed or deleted`,
      },
    ]
  }
  if (matches.length > 1) {
    return [
      {
        kind: "ambiguous-test",
        entry: label,
        detail: `"${entry.name}" matches ${matches.length} tests (${matches.join(" | ")}) — an entry must name ONE`,
      },
    ]
  }
  return []
}

export const validateQuarantineLedger = (
  ledger: QuarantineLedgerV2,
  world: QuarantineWorld,
): readonly QuarantineViolation[] => {
  const out: QuarantineViolation[] = []
  if (ledger.entries.length > ledger.maxCount) {
    out.push({
      kind: "ratchet-breach",
      entry: "<ledger>",
      detail: `${ledger.entries.length} entries > maxCount ${ledger.maxCount}`,
    })
  }
  const seen = new Set<string>()
  for (const entry of ledger.entries) {
    const label = `${entry.file}::${entry.name}`
    if (seen.has(label)) {
      out.push({ kind: "duplicate", entry: label, detail: "duplicate (file, name) entry" })
    }
    seen.add(label)
    out.push(...fieldViolations(entry, label))
    if (!mayQuarantine(entry.file)) {
      out.push({
        kind: "critical-test",
        entry: label,
        detail: "this test is on the critical deny-list and can never be quarantined",
      })
    }
    const expiry = Date.parse(entry.expiresAt ?? "")
    if (!Number.isNaN(expiry) && expiry <= world.nowMs) {
      out.push({
        kind: "expired",
        entry: label,
        detail: `expired at ${entry.expiresAt} — fix the test or re-justify the entry`,
      })
    }
    out.push(...existenceViolations(entry, label, world))
  }
  return out
}
