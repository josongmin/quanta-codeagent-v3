/**
 * Inline markdown painter — streaming FSM unit suite.
 *
 * The painter rewrites assistant text deltas to ANSI-coloured chunks while
 * remaining a structural no-op when colour is off (NO_COLOR / non-TTY / OFF
 * mode). Tests force `enabled: true` so the suite is independent of TTY
 * detection, and use `stripAnsi` to verify the visible text is preserved.
 *
 * The FSM contract these tests pin down:
 *   - whole-line buffering (incomplete lines hold until next delta or flush)
 *   - delta-fragmentation safety (any byte-split of a paint-able token still
 *     paints correctly once the full line arrives)
 *   - fence open-close detection (lines inside a fence are dim regardless of
 *     content; an unclosed fence emits a trailing RESET on flush)
 *   - header / inline-code / bullet pattern recognition
 *   - byte-identical pass-through when disabled
 */
import { describe, expect, test } from "bun:test"
import { createMarkdownPainter } from "../../../src/apps/cli/markdown-painter"
import { stripAnsi } from "../../../src/ui"

describe("markdown-painter — colour OFF (no-op)", () => {
  test("enabled:false passes deltas through verbatim", () => {
    const p = createMarkdownPainter({ enabled: false })
    expect(p.write("# Title\n")).toBe("# Title\n")
    expect(p.write("plain text")).toBe("plain text")
    expect(p.flush()).toBe("")
  })

  test("mode:off passes deltas through verbatim even with enabled:true", () => {
    const p = createMarkdownPainter({ enabled: true, mode: "off" })
    expect(p.write("# Title\n")).toBe("# Title\n")
    expect(p.flush()).toBe("")
  })
})

describe("markdown-painter — headers (ATX)", () => {
  test("'# Title\\n' paints with bold + colour and preserves visible text", () => {
    const p = createMarkdownPainter({ enabled: true })
    const out = p.write("# Title\n")
    expect(stripAnsi(out)).toBe("# Title\n")
    expect(out).toContain("\x1b[1m") // bold
    expect(out).not.toBe("# Title\n") // actually painted
  })

  test("'## H2' and '### H3' are recognised and painted", () => {
    const p2 = createMarkdownPainter({ enabled: true })
    const o2 = p2.write("## H2\n")
    expect(stripAnsi(o2)).toBe("## H2\n")
    expect(o2).toContain("\x1b[1m")

    const p3 = createMarkdownPainter({ enabled: true })
    const o3 = p3.write("### H3\n")
    expect(stripAnsi(o3)).toBe("### H3\n")
    expect(o3).toContain("\x1b[1m")
  })

  test("'#### H4' is NOT painted (depth limit)", () => {
    const p = createMarkdownPainter({ enabled: true })
    const out = p.write("#### H4\n")
    expect(out).toBe("#### H4\n")
  })

  test("plain text without a header marker is preserved exactly", () => {
    const p = createMarkdownPainter({ enabled: true })
    const out = p.write("hello world\n")
    expect(out).toBe("hello world\n")
  })
})

describe("markdown-painter — code fences", () => {
  test("triple-backtick open + close: lines inside the fence are dim", () => {
    const p = createMarkdownPainter({ enabled: true })
    const opened = p.write("```\n")
    expect(opened).toContain("\x1b[2m") // dim on the fence line itself
    const body = p.write("console.log('hi')\n")
    expect(body).toContain("\x1b[2m")
    expect(stripAnsi(body)).toBe("console.log('hi')\n")
    const closed = p.write("```\n")
    expect(closed).toContain("\x1b[2m")
    // After close, plain text is back to plain.
    const after = p.write("done\n")
    expect(after).toBe("done\n")
  })

  test("fence with language tag: lang annotation rendered dim", () => {
    const p = createMarkdownPainter({ enabled: true })
    const opened = p.write("```typescript\n")
    expect(stripAnsi(opened)).toContain("```typescript")
    expect(stripAnsi(opened)).toContain("(typescript)") // lang suffix
  })

  test("unclosed fence: flush emits a RESET so the terminal isn't stuck dim", () => {
    const p = createMarkdownPainter({ enabled: true })
    p.write("```\n")
    p.write("half a code block")
    const tail = p.flush()
    // The trailing partial line is emitted, then a RESET.
    expect(tail).toContain("half a code block")
    expect(tail.endsWith("\x1b[0m")).toBe(true)
  })

  test("inside-fence, a line that LOOKS LIKE a header is still dim, not painted as a header", () => {
    const p = createMarkdownPainter({ enabled: true })
    p.write("```\n")
    const out = p.write("# not a header\n")
    expect(out).toContain("\x1b[2m") // dim
    expect(out).not.toContain("\x1b[1m") // no bold
  })
})

describe("markdown-painter — inline code spans", () => {
  test("'`code`' inside a sentence is painted with REVERSE", () => {
    const p = createMarkdownPainter({ enabled: true })
    const out = p.write("see `foo()` for details\n")
    expect(out).toContain("\x1b[7m") // REVERSE
    expect(stripAnsi(out)).toBe("see foo() for details\n")
  })

  test("multiple spans on one line are all painted", () => {
    const p = createMarkdownPainter({ enabled: true })
    const out = p.write("use `a` then `b`\n")
    // String-built regex so the literal ESC control char does not appear
    // in source (biome `noControlCharactersInRegex`).
    const REVERSE_RE = new RegExp(`${String.fromCharCode(27)}\\[7m`, "g")
    const reverseCount = (out.match(REVERSE_RE) ?? []).length
    expect(reverseCount).toBe(2)
  })

  test("a stray single backtick with no closing pair is left as-is", () => {
    const p = createMarkdownPainter({ enabled: true })
    const out = p.write("price is `$5\n")
    expect(out).toBe("price is `$5\n")
  })
})

describe("markdown-painter — bullet markers", () => {
  test("'- item' line: marker is dim, body preserved", () => {
    const p = createMarkdownPainter({ enabled: true })
    const out = p.write("- one\n")
    expect(out).toContain("\x1b[2m")
    expect(stripAnsi(out)).toBe("- one\n")
  })

  test("'1. item' numbered marker: marker is dim", () => {
    const p = createMarkdownPainter({ enabled: true })
    const out = p.write("1. first\n")
    expect(out).toContain("\x1b[2m")
    expect(stripAnsi(out)).toBe("1. first\n")
  })
})

describe("markdown-painter — streaming FSM (delta fragmentation)", () => {
  test("header split across two deltas (`# ` + `Title\\n`) still paints", () => {
    const p = createMarkdownPainter({ enabled: true })
    const a = p.write("# ")
    expect(a).toBe("") // buffering — no newline yet
    const b = p.write("Title\n")
    expect(stripAnsi(b)).toBe("# Title\n")
    expect(b).toContain("\x1b[1m")
  })

  test("fence open split across deltas (` ``` ` + `\\nbody`)", () => {
    const p = createMarkdownPainter({ enabled: true })
    expect(p.write("```")).toBe("") // partial
    const opened = p.write("\n")
    expect(opened).toContain("\x1b[2m")
    const body = p.write("body\n")
    expect(body).toContain("\x1b[2m")
  })

  test("many tiny deltas (1 char at a time) ⇒ same final output as one delta", () => {
    const full = "# Heading\nsome `code` here\n"
    const single = createMarkdownPainter({ enabled: true })
    const a = single.write(full) + single.flush()

    const tiny = createMarkdownPainter({ enabled: true })
    let acc = ""
    for (const ch of full) acc += tiny.write(ch)
    acc += tiny.flush()

    expect(acc).toBe(a)
  })

  test("end-of-turn without a trailing newline ⇒ flush emits the partial", () => {
    const p = createMarkdownPainter({ enabled: true })
    const a = p.write("no trailing newline")
    expect(a).toBe("")
    const tail = p.flush()
    expect(stripAnsi(tail)).toBe("no trailing newline")
  })

  test("empty delta returns empty without altering buffer", () => {
    const p = createMarkdownPainter({ enabled: true })
    expect(p.write("")).toBe("")
    expect(p.write("# T")).toBe("")
    expect(p.write("")).toBe("")
    const out = p.write("\n")
    expect(stripAnsi(out)).toBe("# T\n")
  })
})

describe("markdown-painter — unicode + scale safety", () => {
  test("Korean (한국어) header paints with correct visible text", () => {
    const p = createMarkdownPainter({ enabled: true })
    const out = p.write("# 제목\n")
    expect(stripAnsi(out)).toBe("# 제목\n")
    expect(out).toContain("\x1b[1m")
  })

  test("large code fence (2000 lines) does not balloon memory or duplicate output", () => {
    const p = createMarkdownPainter({ enabled: true })
    p.write("```\n")
    let out = ""
    for (let i = 0; i < 2000; i++) out += p.write(`line ${i}\n`)
    out += p.write("```\n")
    // Visible line count: 2000 body lines + the closing fence line.
    const visibleLines = stripAnsi(out).split("\n")
    // 2000 body + 1 close + trailing "" from final "\n" split.
    expect(visibleLines.length).toBe(2002)
    expect(visibleLines[0]).toBe("line 0")
    expect(visibleLines[1999]).toBe("line 1999")
    expect(visibleLines[2000]).toBe("```")
  })
})
