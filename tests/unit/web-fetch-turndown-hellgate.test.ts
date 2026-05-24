/**
 * Hellgate — `htmlToMarkdown` turndown-backed converter (ADR-0176).
 *
 * Mirrors the "E. HTML→Markdown" suite in `web-fetch-hellgate.test.ts`
 * but probes the turndown swap directly: every case asserts a property
 * the swap MUST preserve from the byte-shape of the prior 9-stage inline
 * converter, plus a small number of new properties turndown enables
 * (fenced code blocks, lists, bold/em sigils, entity decoding).
 *
 * Imports ONLY from `@/tool/web` — the public barrel. No turndown direct
 * import, no internal helper imports — that proves the swap is invisible
 * to callers.
 */

import { describe, expect, test } from "bun:test"
import { htmlToMarkdown, turndown } from "@/tool/web"

describe("turndown-backed htmlToMarkdown — A. heading + link parity", () => {
  test("1. <h1>Title</h1> → '# Title'", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toContain("# Title")
  })
  test("2. <h2>Sub</h2> → '## Sub'", () => {
    expect(htmlToMarkdown("<h2>Sub</h2>")).toContain("## Sub")
  })
  test("3. <a href='X'>Y</a> → '[Y](X)'", () => {
    expect(htmlToMarkdown('<a href="X">Y</a>')).toContain("[Y](X)")
  })
})

describe("turndown-backed htmlToMarkdown — B. security strip", () => {
  test("4. <script>BAD_PAYLOAD</script>visible — script text removed", () => {
    const out = htmlToMarkdown("<script>BAD_PAYLOAD</script>visible")
    expect(out).not.toContain("BAD_PAYLOAD")
    expect(out).toContain("visible")
  })
  test("5. <style>x{color:red}</style>visible — style text removed", () => {
    const out = htmlToMarkdown("<style>x{color:red}</style>visible")
    expect(out).not.toContain("color:red")
    expect(out).toContain("visible")
  })
  test("5b. <noscript>FALLBACK</noscript>visible — noscript text removed", () => {
    const out = htmlToMarkdown("<noscript>FALLBACK</noscript>visible")
    expect(out).not.toContain("FALLBACK")
    expect(out).toContain("visible")
  })
  test("5c. <iframe>FRAMED</iframe>visible — iframe text removed", () => {
    const out = htmlToMarkdown("<iframe>FRAMED</iframe>visible")
    expect(out).not.toContain("FRAMED")
    expect(out).toContain("visible")
  })
})

describe("turndown-backed htmlToMarkdown — C. code emphasis lists", () => {
  test("6. <code>x</code> → '`x`' (backticks)", () => {
    expect(htmlToMarkdown("<code>x</code>")).toContain("`x`")
  })
  test("7. <pre><code>multi\\nline</code></pre> → fenced code block", () => {
    const out = htmlToMarkdown("<pre><code>multi\nline</code></pre>")
    // fenced style (``` somewhere in output)
    expect(out).toContain("```")
    expect(out).toContain("multi")
    expect(out).toContain("line")
  })
  test("8. <ul><li>a</li><li>b</li></ul> → '- a\\n- b'", () => {
    const out = htmlToMarkdown("<ul><li>a</li><li>b</li></ul>")
    expect(out).toContain("- a")
    expect(out).toContain("- b")
  })
  test("9. <strong>bold</strong> + <em>it</em> → '**bold**' + '_it_'", () => {
    const out = htmlToMarkdown("<strong>bold</strong> <em>it</em>")
    expect(out).toContain("**bold**")
    expect(out).toContain("_it_")
  })
})

describe("turndown-backed htmlToMarkdown — D. post-processing", () => {
  test("10. inline triple newlines collapsed to 2 (post-turndown polish)", () => {
    // turndown itself preserves source newlines inside text; we still
    // guarantee the prior 9-stage invariant for raw input.
    const out = htmlToMarkdown("a\n\n\n\n\nb")
    expect(out).not.toContain("\n\n\n")
  })
  test("11. entities decoded — &amp;/&lt;/&gt;/&quot;", () => {
    // turndown's domino DOM decodes HTML entities natively before
    // serialization.
    const out = htmlToMarkdown("&lt;a&gt;&amp;&quot;")
    expect(out).toContain("<")
    expect(out).toContain(">")
    expect(out).toContain("&")
    expect(out).toContain('"')
  })
  test("12. trim — leading + trailing whitespace removed", () => {
    const out = htmlToMarkdown("   <p>hello</p>   ")
    expect(out.startsWith(" ")).toBe(false)
    expect(out.endsWith(" ")).toBe(false)
    expect(out).toContain("hello")
  })
})

describe("turndown-backed htmlToMarkdown — E. exposed singleton", () => {
  test("13. `turndown` singleton exported (callers can extend with addRule)", () => {
    expect(turndown).toBeDefined()
    expect(typeof turndown.turndown).toBe("function")
    expect(typeof turndown.addRule).toBe("function")
  })
  test("14. empty string → empty string (no throw, byte-stable)", () => {
    expect(htmlToMarkdown("")).toBe("")
  })
})
