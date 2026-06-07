/**
 * M4 (jun-7-naive-impl-hardening Phase-2 FINAL) — ANSI / control-char strip to
 * the MODEL.
 *
 * THE ORPHAN THIS CLOSES — `formatRunBody` (foreground) and
 * `buildBackgroundCompletedResult` (bg-completed) both emit the captured
 * stdout/stderr VERBATIM into the model-facing `output`. `npm`/`cargo`/`pytest`
 * paint their output with ANSI SGR colour codes + cursor/erase CSI sequences;
 * those escapes reach the LLM verbatim — wasted tokens + degraded parsing. The
 * fix runs both model-facing bodies through {@link stripModelControlChars}: a
 * pure CSI/SGR/OSC + C0-control stripper that PRESERVES `\n` and `\t` (layout
 * the model legitimately reads).
 *
 * RED-ON-INJECTION (the `via the public formatters` block): the bodies are
 * asserted clean of a known escape soup. Reverting either formatter to the bare
 * `.join("\n")` (dropping the strip) turns those assertions RED.
 */

import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool, stripModelControlChars } from "@/tool/bash"

describe("stripModelControlChars — pure ANSI/control stripper (M4)", () => {
  test("strips a CSI erase-line + CR + SGR colour, leaving the visible text", () => {
    // `\x1b[2K` erase-line, `\r` carriage-return, `\x1b[31m` red, `\x1b[0m` reset.
    expect(stripModelControlChars("\x1b[2K\rfoo\x1b[31mbar\x1b[0m")).toBe("foobar")
  })

  test("PRESERVES newlines and tabs (model layout must survive)", () => {
    expect(stripModelControlChars("a\nb\tc\n")).toBe("a\nb\tc\n")
  })

  test("strips an OSC terminal-title sequence (BEL- and ST-terminated)", () => {
    expect(stripModelControlChars("\x1b]0;hijack\x07ok")).toBe("ok")
    expect(stripModelControlChars("\x1b]0;hijack\x1b\\ok")).toBe("ok")
  })

  test("strips bare C0 controls (e.g. \\x08 backspace, \\x00 NUL) but keeps \\n/\\t", () => {
    expect(stripModelControlChars("a\x08\x00b\nc")).toBe("ab\nc")
  })

  test("idempotent — a second pass is a no-op", () => {
    const once = stripModelControlChars("\x1b[2K\rfoo\x1b[0m\nbar")
    expect(stripModelControlChars(once)).toBe(once)
  })

  test("surrogate-safe — a lone high surrogate is preserved, not corrupted into a throw", () => {
    const lone = "x\ud83d" // lone high surrogate
    // Must not throw, and must leave the surrogate untouched (it is not a control).
    expect(() => stripModelControlChars(lone)).not.toThrow()
    expect(stripModelControlChars(lone)).toBe(lone)
  })

  test("clean text passes through unchanged", () => {
    expect(stripModelControlChars("plain output\nwith tabs\there")).toBe(
      "plain output\nwith tabs\there",
    )
  })
})

describe("via the public formatter — real shell emits ANSI, model body is clean (M4)", () => {
  const collect = async (input: unknown): Promise<ToolResult> => {
    const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }
    let result: ToolResult | undefined
    for await (const ev of bashTool.execute(input as never, ctx) as AsyncIterable<ToolEvent>) {
      if (ev.type === "result") result = ev.result
    }
    if (result === undefined) throw new Error("no result")
    return result
  }

  test("foreground `formatRunBody` strips a printf-emitted SGR colour + erase-line", async () => {
    // `printf` writes a literal CSI erase-line, a red SGR, the word, then reset.
    const result = await collect({
      command: String.raw`printf '\033[2K\rhello\033[31mworld\033[0m\n'`,
    })
    // RED-ON-INJECTION: reverting formatRunBody to the bare `.join("\n")` leaves
    // the raw escapes in `output`, failing the no-ESC assertion below.
    expect(result.output).not.toContain("\x1b")
    expect(result.output).toContain("helloworld")
  })
})
