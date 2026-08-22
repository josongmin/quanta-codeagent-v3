/**
 * Unit — RFC-02 §5.3 `renderTemplate` (pure, deterministic, no eval).
 */
import { describe, expect, test } from "bun:test"
import { renderTemplate } from "../../src/tool/subagent-batch"

describe("renderTemplate", () => {
  test("string item via {{item}}", () => {
    const r = renderTemplate("hello {{item}}", "world")
    expect(r.ok && r.prompt).toBe("hello world")
  })

  test("object item flat keys; number/boolean stringified", () => {
    const r = renderTemplate("{{a}}-{{n}}-{{b}}", { a: "x", n: 2, b: true })
    expect(r.ok && r.prompt).toBe("x-2-true")
  })

  test("non-primitive value is JSON-stringified", () => {
    const r = renderTemplate("{{v}}", { v: { k: 1 } })
    expect(r.ok && r.prompt).toBe('{"k":1}')
  })

  test("literal braces via doubling are NOT placeholders", () => {
    const r = renderTemplate("a {{{{lit}}}} b {{x}}", { x: "X" })
    expect(r.ok && r.prompt).toBe("a {{lit}} b X")
  })

  test("missing key collected (deduped, first-seen order)", () => {
    const r = renderTemplate("{{a}} {{b}} {{a}} {{c}}", { a: "A" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing).toEqual(["b", "c"])
  })

  test("{{item}} on an object with no item field is missing", () => {
    const r = renderTemplate("{{item}}", { a: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing).toEqual(["item"])
  })

  test("whitespace inside placeholder is tolerated", () => {
    const r = renderTemplate("{{  key  }}", { key: "v" })
    expect(r.ok && r.prompt).toBe("v")
  })

  test("no placeholders ⇒ verbatim", () => {
    const r = renderTemplate("plain text", "ignored")
    expect(r.ok && r.prompt).toBe("plain text")
  })

  test("does not treat injected-looking content as code (no eval)", () => {
    // The literal `${...}` is deliberate test data: it proves the template
    // engine does NOT interpret host-string-template syntax (no eval/Function).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional injection-probe literal
    const injection = "${process.exit(1)}"
    const r = renderTemplate("{{item}}", injection)
    expect(r.ok && r.prompt).toBe(injection)
  })
})
