/**
 * R2 audit-H closeout (sanitize was shipped in 530405a9; this hellgate is
 * the missing leg pinning the public effect). The logger's `sanitizeLogText`
 * is module-private — the contract is the OUTPUT shape on the registered
 * stderr sink: every emitted line is exactly one `\n`-terminated line, no
 * embedded control characters / no surviving ANSI CSI escape sequences,
 * `\t` preserved (tabs are not a forge vector), and normal ASCII passes
 * verbatim.
 *
 * Without sanitization a hostile `e.message` containing
 * `"\x1b[2J\n[error] credentials leaked: <token>"` could:
 *   - clear the terminal (`\x1b[2J`)
 *   - inject a SECOND log line that operators would attribute to the agent
 *   - forge a fake severity tag (`[error]`)
 * The sanitize layer strips C0/C1/DEL controls (except `\t`) → `?`, and
 * strips ANSI CSI escape sequences entirely.
 *
 * Seven adversarial inputs (the audit-H R2 catalog):
 *   1. CSI cursor sequence    — stripped
 *   2. OSC title-set sequence — partially stripped (the audit decision: OSC
 *                              uses BEL/ST terminators that are themselves
 *                              C1 controls, which sanitize converts to `?`,
 *                              so the surviving payload is non-injectable
 *                              text)
 *   3. DCS device-control     — same as OSC (sanitize neutralizes the
 *                              terminators, leaving payload as inert text)
 *   4. bidi override (U+202E) — survives (Unicode > U+009F is intentional;
 *                              the audit scope is C0/C1/DEL + ANSI CSI)
 *   5. zero-width space U+200B— survives (same reason as #4 — intentional
 *                              Unicode passthrough; documented limit)
 *   6. TAB preserved          — `\t` is NOT a forge vector and is whitelisted
 *   7. plain ASCII unmodified — happy path, byte-identical
 *
 * The hellgate WILL revert-red if `sanitizeLogText` is removed or weakened
 * (the embedded `\n` injection check is the strongest signal — log-line
 * forgery is the audit-H vector).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { logger } from "@/shared"
import { setTerminalIo } from "@/shared/terminal-io"

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

const lastLine = (): string => captured.join("")

describe("R2 audit-H — logger sanitize control / ANSI", () => {
  test("(1) CSI cursor-position escape stripped — no \\x1b survives", () => {
    logger.info("hello\x1b[2J\x1b[Hworld")
    const out = lastLine()
    expect(out.includes("\x1b")).toBe(false)
    // The bracketed CSI body is also gone (whole match removed, not just ESC).
    expect(out.includes("[2J")).toBe(false)
    expect(out.includes("[H")).toBe(false)
    // Payload text survives.
    expect(out.includes("hello")).toBe(true)
    expect(out.includes("world")).toBe(true)
  })

  test("(2) OSC title-set: terminators (C1 BEL/ESC) neutralized to '?'", () => {
    // `\x1b]0;EVIL TITLE\x07` — OSC 0 sets terminal title.
    logger.info("a\x1b]0;EVIL TITLE\x07b")
    const out = lastLine()
    // ESC and BEL must NOT survive (both forge vectors).
    expect(out.includes("\x1b")).toBe(false)
    expect(out.includes("\x07")).toBe(false)
    expect(out.includes("a")).toBe(true)
    expect(out.includes("b")).toBe(true)
  })

  test("(3) DCS device-control: ESC + 'P' terminator stripped", () => {
    // `\x1bP...\x1b\\` is DCS; both terminators are control chars.
    logger.info("x\x1bPq malicious-payload \x1b\\y")
    const out = lastLine()
    expect(out.includes("\x1b")).toBe(false)
    expect(out.includes("x")).toBe(true)
    expect(out.includes("y")).toBe(true)
  })

  test("(4) bidi override U+202E STRIPPED (R3 forge-vector defence)", () => {
    // R3 audit-H expanded: bidi overrides (U+202A-U+202E) + isolates
    // (U+2066-U+2069) visually reorder `[error]` → `[rorre]`, fooling log
    // scraping. Stripped at sanitize.
    logger.info("safe‮evil")
    const out = lastLine()
    expect(out.includes("‮")).toBe(false)
  })

  test("(5) zero-width space U+200B STRIPPED (R3 forge-vector defence)", () => {
    // Zero-width chars (U+200B-U+200F, U+FEFF) craft visually identical
    // tokens bypassing grep-based alerting. Stripped at sanitize.
    logger.info("hello​world")
    const out = lastLine()
    expect(out.includes("​")).toBe(false)
  })

  test("(6) TAB is preserved (whitelisted — not a forge vector)", () => {
    logger.info("col1\tcol2\tcol3")
    const out = lastLine()
    // Tab is in the C0 range, but the sanitize regex
    // /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g intentionally EXCLUDES \x09 (TAB).
    expect(out.includes("\t")).toBe(true)
    expect(out.includes("col1")).toBe(true)
    expect(out.includes("col3")).toBe(true)
  })

  test("(7) plain ASCII passes through verbatim", () => {
    logger.info("ordinary log message 12345 abc")
    const out = lastLine()
    expect(out).toContain("ordinary log message 12345 abc")
    // Exactly one line emitted (terminating \n included).
    expect(captured.length).toBe(1)
    expect(captured[0]?.endsWith("\n")).toBe(true)
  })

  test("CRITICAL: embedded newline is replaced with '?' — log-line forgery BLOCKED", () => {
    // The original audit-H vector: a thrown e.message that injects a fake
    // `[error] credentials leaked: <token>` line. With sanitize, the
    // embedded `\n` is replaced with `?`, collapsing the would-be 2-line
    // forgery into a SINGLE line that operators see as one log record.
    logger.info("normal\n[error] credentials leaked: xyz")
    const out = lastLine()
    // Exactly ONE terminating newline (the writer's), zero embedded.
    expect(out.split("\n").length).toBe(2) // ["...payload...", ""]
    expect(out.includes("[error] credentials leaked")).toBe(true) // payload preserved
    // But it's all on a SINGLE log line — the forge vector is dead.
    expect(out.startsWith("[info]")).toBe(true)
  })
})
