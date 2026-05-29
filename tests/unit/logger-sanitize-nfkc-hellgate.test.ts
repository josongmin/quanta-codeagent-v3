/**
 * R5 audit-M3 closeout — logger NFKC normalization + soft-hyphen strip.
 *
 * Pre-fix the sanitize layer enumerated a closed set of forge-vector code
 * points (C0/C1/DEL, ANSI CSI/OSC/DCS, bidi U+202A-U+202E + zero-width
 * U+200B-U+200F + U+FEFF). Anything Unicode that DECOMPOSES under NFKC into
 * those bytes — and anything outside the set but with the same forge effect
 * (soft hyphen U+00AD splits grep-anchored alert tokens) — bypassed the gate.
 *
 * Adversarial cases:
 *   (1) fullwidth `[` U+FF3B decomposes to ASCII `[` under NFKC — pre-fix this
 *       lets an attacker forge `[error]` without the strip set noticing the
 *       fullwidth variant. Post-fix NFKC runs FIRST, the ASCII `[` lands in
 *       the message as a plain bracket (no forge: severity tag uses the
 *       writer's own `[level]` prefix).
 *   (2) combining acute U+0301 attached to `e` (`é`-shape) renders visually
 *       like `e` and survives the regex set unchanged. NFKC canonicalises it
 *       and leaves the base + mark in the output (visible to operators), but
 *       it CANNOT compose into a control char or CSI escape — that's the
 *       structural defence we pin here.
 *   (3) soft hyphen U+00AD splits `credentials` into `creden­tials` — naive
 *       grep alerting misses it. Soft hyphen NFKC-passes, but the expanded
 *       BIDI_ZW_RE strips it.
 *   (4) ligature `ﬁ` (U+FB01) decomposes to `fi` under NFKC — the strip set
 *       sees nothing to remove (no escape, no control), but the output is now
 *       grep-stable as plain ASCII (alerting on `file` or `fi` works again).
 *   (5) fullwidth digits `０１２` decompose to `012` under NFKC. Same shape
 *       contract as (4).
 *   (6) fullwidth ESC equivalent does NOT exist as a single code point — and
 *       the byte-level ESC (U+001B) is already stripped by ANSI regex. This
 *       case asserts the existing strip remains effective AFTER NFKC.
 *   (7) lone unpaired surrogate input does NOT crash the logger — NFKC can
 *       throw RangeError on some engines; the try/catch fallback keeps the
 *       sanitize layer alive.
 *   (8) soft hyphen embedded in `[error]` doesn't bypass severity detection:
 *       `[e­rror]` (with U+00AD) becomes `[error]` after strip — operators
 *       grepping `\[error\]` see the forge attempt as if it were plain text
 *       (which the writer's own `[level]` prefix tags as the OUTER level).
 *
 * Replay against a pre-fix tree (no normalize, no U+00AD in BIDI_ZW_RE) and
 * cases (1)(3)(4)(5)(8) flip RED — that's the revert proof.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { logger, setTerminalIo } from "@/shared"

let captured: string[] = []

beforeEach(() => {
  captured = []
  setTerminalIo({
    stdout: () => {},
    stderr: (chunk) => captured.push(chunk),
  })
})

afterAll(() => {
  setTerminalIo(null)
})

const out = (): string => captured.join("")

describe("R5 audit-M3 — logger NFKC + soft-hyphen sanitize", () => {
  test("(1) fullwidth bracket U+FF3B decomposes to ASCII bracket under NFKC", () => {
    // FF3B = `[`, FF3D = `]`. Without NFKC these survive as exotic Unicode
    // and would bypass any future strip-set that anchors on ASCII bracket.
    logger.info("text ［error］ more")
    const o = out()
    // Output must contain plain ASCII bracket (NFKC ran).
    expect(o.includes("[error]")).toBe(true)
    // Original fullwidth code points must be GONE (canonicalised away).
    expect(o.includes("［")).toBe(false)
    expect(o.includes("］")).toBe(false)
  })

  test("(2) combining mark U+0301 does NOT smuggle a control char", () => {
    // Combining acute on `e` — NFKC composes to U+00E9 (`é`). The point of
    // the test is: no control char appears, no CSI escape forged, the
    // structural defence stands.
    logger.info("safe é message")
    const o = out()
    expect(o.includes("\x1b")).toBe(false)
    expect(o.includes("\x00")).toBe(false)
    // The composed `é` is visible (operator-readable).
    expect(o.includes("é") || o.includes("é")).toBe(true)
  })

  test("(3) soft hyphen U+00AD stripped (splits grep-anchored alert tokens)", () => {
    logger.info("creden­tials leaked")
    const o = out()
    expect(o.includes("­")).toBe(false)
    // After strip the alert token `credentials` is grep-stable.
    expect(o.includes("credentials leaked")).toBe(true)
  })

  test("(4) ligature ﬁ (U+FB01) decomposes to `fi` under NFKC", () => {
    logger.info("ﬁle opened")
    const o = out()
    expect(o.includes("ﬁ")).toBe(false)
    expect(o.includes("file opened")).toBe(true)
  })

  test("(5) fullwidth digits decompose to ASCII digits under NFKC", () => {
    // ０１２ = `０１２` (fullwidth). NFKC → `012`.
    logger.info("port ０１２ active")
    const o = out()
    expect(o.includes("port 012 active")).toBe(true)
  })

  test("(6) ESC still stripped after NFKC (regression seal for case 1/2)", () => {
    // A combined attack: fullwidth bracket adjacent to a real ANSI CSI.
    logger.info("［fake］\x1b[2J")
    const o = out()
    // No ESC survives.
    expect(o.includes("\x1b")).toBe(false)
    // No fullwidth bracket survives.
    expect(o.includes("［")).toBe(false)
    // CSI body is gone (whole match removed).
    expect(o.includes("[2J")).toBe(false)
  })

  test("(7) lone unpaired surrogate does NOT crash the logger", () => {
    // U+D800 is a lone high surrogate — `String.prototype.normalize` can
    // throw RangeError on some engines. The try/catch in `normalizeNfkc`
    // must keep the sink alive.
    expect(() => logger.info("safe \uD800 tail")).not.toThrow()
    // SOMETHING was emitted (sink not silently broken).
    expect(captured.length).toBeGreaterThanOrEqual(1)
  })

  test("(8) soft hyphen inside forged severity tag cannot bypass detection", () => {
    // Attacker tries `[e<soft-hyphen>rror]` to slip past `[error]` greps.
    logger.info("normal [e­rror] tail")
    const o = out()
    // Soft hyphen stripped → `[error]` exposed (operator alert wins).
    expect(o.includes("[error]")).toBe(true)
    expect(o.includes("­")).toBe(false)
  })

  test("(9) plain ASCII unmodified (happy-path byte identity preserved)", () => {
    logger.info("plain ascii message 12345")
    const o = out()
    expect(o).toContain("plain ascii message 12345")
    // Exactly one terminating newline (writer's), zero embedded.
    expect(o.split("\n").length).toBe(2)
  })
})
