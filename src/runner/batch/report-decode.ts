/**
 * BFND-02 — the primitives every canonical-report decode is built from.
 *
 * This module exists for exactly one structural reason: the canonical envelope
 * (`report-envelope.ts`) and the Terminal branch (`report-terminal.ts`) both need
 * the SAME refusal type and the SAME field readers, and the envelope imports the
 * branch. Putting the shared pieces in the branch, or the branch's decode in the
 * envelope, would either create a runtime import CYCLE (the TDZ class this repo
 * has been bitten by) or grow one module into a god-module. So the graph is
 * one-way and boring:
 *
 *   report-decode.ts   (leaf: the error + the field readers)
 *     ← report-terminal.ts   (the terminal branch: types + its decode)
 *       ← report-envelope.ts (the union, the encoder, the ONE writer + mirror)
 *
 * Every reader here REFUSES rather than coerces. A decode that repaired a bad
 * value would put a flattering number on a dashboard with no one the wiser,
 * which is the failure mode the whole envelope exists to make impossible.
 */

/** Thrown when a report's identity or payload is missing, unknown, or
 *  self-contradictory. Fail-closed: never a silent default. */
export class CanonicalReportIdentityError extends Error {
  constructor(message: string) {
    super(`canonical report identity: ${message}`)
    this.name = "CanonicalReportIdentityError"
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const refuse = (what: string, why: string, got: unknown): never => {
  throw new CanonicalReportIdentityError(
    `${what} ${why} (got ${JSON.stringify(got) ?? "undefined"})`,
  )
}

export const asStringField = (value: unknown, what: string): string =>
  typeof value === "string" ? value : refuse(what, "must be a string", value)

export const asFiniteField = (value: unknown, what: string): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : refuse(what, "must be a finite number", value)

export const asBooleanField = (value: unknown, what: string): boolean =>
  typeof value === "boolean" ? value : refuse(what, "must be a boolean", value)

export const asRecordField = (value: unknown, what: string): Record<string, unknown> =>
  isRecord(value) ? value : refuse(what, "must be an object", value)

export const asArrayField = (value: unknown, what: string): readonly unknown[] =>
  Array.isArray(value) ? value : refuse(what, "must be an array", value)

export const asStringArrayField = (value: unknown, what: string): readonly string[] => {
  const rows = asArrayField(value, what)
  return rows.map((row, index) => asStringField(row, `${what}[${index}]`))
}

/** A nullable number channel: `null` means "the producer recorded none", which is
 *  a DIFFERENT fact from zero and must survive the round trip as itself. */
export const asFiniteOrNullField = (value: unknown, what: string): number | null =>
  value === null ? null : asFiniteField(value, what)

/** Spread-in an optional field ONLY when it has a value. Under
 *  `exactOptionalPropertyTypes` an absent key and an explicitly-`undefined` key
 *  are different things, and a decoded receipt must never gain the latter — it
 *  would break byte-level round-trip equality with the artifact it came from. */
export const put = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? ({} as { [P in K]?: V }) : ({ [key]: value } as { [P in K]?: V })
