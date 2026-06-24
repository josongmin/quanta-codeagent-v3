/**
 * NO TIME-BOMB AUTH FIXTURES (regression guard, jun-24).
 *
 * RCA: a single hard-coded `expires_at: "2026-06-24T..."` in bench auth fixtures —
 * a date that silently became "now" — flipped ~60 bench/pool tests RED in one day
 * once `assertRemoteAccessTokenFreshEnough` started rejecting expired tokens. The
 * fixtures were not testing expiry; they were meant to be PERPETUALLY FRESH but
 * used a near-future literal that aged into the past.
 *
 * STRUCTURAL FENCE: a test `expires_at` literal must be UNAMBIGUOUS about intent:
 *   - PERPETUALLY-FRESH fixture ⇒ FAR future (year >= {@link FAR_FUTURE_YEAR}, the
 *     `2099` convention) so it can never age into expiry; OR
 *   - INTENTIONALLY-EXPIRED fixture (refresh/expiry tests) ⇒ a date in the PAST.
 * A date in the DANGER ZONE — currently in the future but before
 * {@link FAR_FUTURE_YEAR} — is a latent time-bomb: it reads as "fresh" today but
 * will silently expire on a future date and break the suite with no code change.
 * Such a literal fails this guard.
 *
 * Red-on-injection: re-introduce `expires_at: "2030-01-01..."` (or any
 * near-future literal) and this turns RED, naming the file:line. Use `2099-...`
 * for a fresh fixture, or a past date for an expiry test.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/** A perpetually-fresh fixture must be at/after this year — far enough out that it
 *  never realistically ages into expiry during the project's lifetime. */
const FAR_FUTURE_YEAR = 2090

const EXPIRES_AT = /expires_at:\s*["'](\d{4}-\d{2}-\d{2}[^"']*)["']/g

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (entry.endsWith(".ts")) yield p
  }
}

interface DangerHit {
  readonly file: string
  readonly line: number
  readonly date: string
}

/** This guard file is excluded: its docstring/red-on-injection cases intentionally
 *  embed example `expires_at` literals (`2030-...`) that would otherwise self-trip. */
const SELF = "no-timebomb-auth-fixtures-hellgate.test.ts"

/** The single classifier — a fixture date is a latent TIME-BOMB when it is
 *  currently in the FUTURE (reads as fresh) but NOT far-future (will age into
 *  expiry). Past dates are fine (intentional expiry tests); unparseable dates are
 *  ignored. Both the live scan and the red-on-injection cases call THIS, so the
 *  teeth test exercises production logic rather than a re-implementation. */
const isTimeBombDate = (raw: string, now: number): boolean => {
  const t = Date.parse(raw)
  if (Number.isNaN(t)) return false
  return t > now && Number(raw.slice(0, 4)) < FAR_FUTURE_YEAR
}

const scanFileDangerZone = (file: string, now: number): DangerHit[] => {
  const hits: DangerHit[] = []
  const lines = readFileSync(file, "utf8").split("\n")
  for (let i = 0; i < lines.length; i++) {
    for (const m of (lines[i] as string).matchAll(EXPIRES_AT)) {
      const raw = m[1] as string
      if (isTimeBombDate(raw, now)) {
        hits.push({ file: file.replace(/^.*\/quanta-codeagent-v3\//, ""), line: i + 1, date: raw })
      }
    }
  }
  return hits
}

const scanDangerZone = (now: number): DangerHit[] => {
  const hits: DangerHit[] = []
  for (const file of walk("tests")) {
    if (file.endsWith(SELF)) continue
    hits.push(...scanFileDangerZone(file, now))
  }
  return hits
}

describe("no time-bomb auth fixtures (regression guard)", () => {
  test(`every test 'expires_at' is far-future (>=${FAR_FUTURE_YEAR}) or already past — never a latent time-bomb`, () => {
    const hits = scanDangerZone(Date.now())
    if (hits.length > 0) {
      const detail = hits.map((h) => `  ${h.file}:${h.line}  expires_at:"${h.date}"`).join("\n")
      throw new Error(
        `${hits.length} time-bomb auth fixture date(s) — currently fresh but will EXPIRE ` +
          `before ${FAR_FUTURE_YEAR}, silently breaking the suite later (the jun-24 ~60-test ` +
          `outage class). Use a far-future date (e.g. "2099-01-01T00:00:00Z") for a ` +
          `perpetually-fresh fixture, or a PAST date for an expiry test:\n${detail}`,
      )
    }
    expect(hits.length).toBe(0)
  })

  test("RED-ON-INJECTION: a near-future fixture date IS flagged; far-future + past are NOT", () => {
    // Deterministic clock so the assertion does not drift with wall time. Exercises
    // the SAME `isTimeBombDate` the live scan uses (not a re-implementation).
    const now = Date.parse("2026-06-24T00:00:00Z")
    expect(isTimeBombDate("2026-06-25T00:00:00Z", now)).toBe(true) // tomorrow ⇒ time-bomb
    expect(isTimeBombDate("2030-01-01T00:00:00Z", now)).toBe(true) // the original offender class
    expect(isTimeBombDate("2089-12-31T00:00:00Z", now)).toBe(true) // future but < far-future ⇒ time-bomb
    expect(isTimeBombDate("2099-01-01T00:00:00Z", now)).toBe(false) // far-future ⇒ perpetually fresh
    expect(isTimeBombDate("2020-01-01T00:00:00Z", now)).toBe(false) // past ⇒ intentional expiry
    expect(isTimeBombDate("2026-06-21T00:00:00Z", now)).toBe(false) // past (vs the fixed clock) ⇒ expiry test
    expect(isTimeBombDate("not-a-date", now)).toBe(false) // unparseable ⇒ ignored
  })
})
