/**
 * `extractSymbols` — function / class / method-name extraction.
 *
 * Three signal classes: backtick-fenced identifiers, Python `def/class`, and
 * TS/JS `function`/`class`/`const x = () =>`. Keywords and prototype-pollution
 * tokens are denied.
 */
import { describe, expect, test } from "bun:test"
import { extractSymbols } from "../../../src/agent/issue-hint/extract-symbols"

describe("extractSymbols — function/class/method names", () => {
  test("empty input → []", () => {
    expect(extractSymbols("")).toEqual([])
  })

  test("backtick-fenced identifier captured", () => {
    expect(extractSymbols("call `prepare_url` first")).toEqual(["prepare_url"])
  })

  test("Python def is captured", () => {
    expect(extractSymbols("def prepare_url(self, url):")).toEqual(["prepare_url"])
  })

  test("Python class is captured", () => {
    expect(extractSymbols("class HTTPAdapter(BaseAdapter):")).toEqual(["HTTPAdapter"])
  })

  test("TS/JS function is captured", () => {
    expect(extractSymbols("function buildConfig(args) {}")).toEqual(["buildConfig"])
  })

  test("TS/JS class is captured", () => {
    expect(extractSymbols("export class Foo extends Bar {}")).toEqual(["Foo"])
  })

  test("TS/JS arrow assignment is captured", () => {
    expect(extractSymbols("const buildConfig = (instance) => {}")).toEqual(["buildConfig"])
    expect(extractSymbols("const fetchData = async (url) => fetch(url)")).toEqual(["fetchData"])
  })

  test("language keywords are REJECTED even when backtick-fenced", () => {
    // `def`/`class`/`function`/`if`/etc. would never be a symbol on their own.
    expect(extractSymbols("the `def` keyword and `class` keyword")).toEqual([])
    expect(extractSymbols("use `import` and `return`")).toEqual([])
    expect(extractSymbols("`true` and `false` and `null`")).toEqual([])
  })

  test("single-letter identifiers REJECTED (too noisy)", () => {
    expect(extractSymbols("`x` and `i` and `n`")).toEqual([])
  })

  test("prototype-pollution tokens REJECTED", () => {
    expect(extractSymbols("`__proto__` and `constructor` and `prototype`")).toEqual([])
  })

  test("dotted backtick form: each component emitted (split + dedup + sort)", () => {
    // `obj.method` → both `obj` and `method` extracted (callers pick).
    expect(extractSymbols("call `Foo.bar` somehow")).toEqual(["Foo", "bar"])
  })

  test("dotted form with a denied component → entire dotted form rejected", () => {
    // If ANY part is a keyword/reserved, we don't emit anything from this dotted form.
    expect(extractSymbols("call `Foo.__proto__.bar`")).toEqual([])
  })

  test("output is sorted-unique", () => {
    const out = extractSymbols("def foo(): pass\nclass Bar: pass\ndef foo(): pass")
    expect(out).toEqual(["Bar", "foo"])
  })

  test("multiple patterns compose: backtick + python def + TS arrow", () => {
    const text = "Use `handler` — `def render():` and `const submit = () =>` both exist."
    const out = extractSymbols(text)
    expect(out).toEqual(expect.arrayContaining(["handler", "render", "submit"]))
  })

  test("identifier longer than 80 chars REJECTED", () => {
    const big = "a".repeat(90)
    expect(extractSymbols(`def ${big}():`)).toEqual([])
  })

  test("Python `def` with leading whitespace still captured", () => {
    expect(extractSymbols("    def deep_method():")).toEqual(["deep_method"])
  })

  test("multiple class definitions all captured + sorted", () => {
    const out = extractSymbols("class Alpha:\nclass Bravo:\nclass Charlie:")
    expect(out).toEqual(["Alpha", "Bravo", "Charlie"])
  })

  test("regex state isolation (multiple invocations same input)", () => {
    const text = "def foo(): pass"
    expect(extractSymbols(text)).toEqual(["foo"])
    expect(extractSymbols(text)).toEqual(["foo"])
  })
})
