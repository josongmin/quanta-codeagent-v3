/**
 * `extractErrors` — exception type names (…Error / …Exception / …Warning).
 *
 * Conservative: bare `Error`/`Exception`/`Warning` are rejected (common in
 * prose). PascalCase prefix required.
 */
import { describe, expect, test } from "bun:test"
import { extractErrors } from "../../../src/agent/issue-hint/extract-errors"

describe("extractErrors — exception/warning type names", () => {
  test("empty input → []", () => {
    expect(extractErrors("")).toEqual([])
  })

  test("Python-style …Error is captured", () => {
    expect(extractErrors("raises UnicodeError sometimes")).toEqual(["UnicodeError"])
  })

  test("…Exception is captured", () => {
    expect(extractErrors("FlaskException occurs")).toEqual(["FlaskException"])
  })

  test("…Warning is captured", () => {
    expect(extractErrors("DeprecationWarning was emitted")).toEqual(["DeprecationWarning"])
  })

  test("bare 'Error' alone REJECTED (too common in prose)", () => {
    expect(extractErrors("an Error happened")).toEqual([])
    expect(extractErrors("an Exception was raised")).toEqual([])
    expect(extractErrors("a Warning was logged")).toEqual([])
  })

  test("multiple distinct errors deduped + sorted", () => {
    const out = extractErrors("got TypeError and ValueError; also got TypeError again")
    expect(out).toEqual(["TypeError", "ValueError"])
  })

  test("case-sensitive: lowercase prefix REJECTED", () => {
    // PascalCase required — `typeError` (lower-t) is not a real Python type.
    expect(extractErrors("got typeError")).toEqual([])
  })

  test("mid-identifier substrings NOT captured (word boundary required)", () => {
    // `MyCustomError` IS captured (starts at boundary); `xUnicodeError` is not.
    expect(extractErrors("MyCustomError raised")).toEqual(["MyCustomError"])
    // No boundary before the capital — must skip
    expect(extractErrors("xUnicodeError")).toEqual([])
  })

  test("identifier longer than 60 chars REJECTED", () => {
    const big = `${"A".repeat(70)}Error`
    expect(extractErrors(`raises ${big}`)).toEqual([])
  })

  test("prototype-pollution defense", () => {
    // The error regex requires `…Error/Exception/Warning` suffix so __proto__
    // alone cannot match — but the dedicated rejection catches edge cases.
    expect(extractErrors("__proto__Error")).toEqual([])
  })

  test("real SWE-bench example: requests/5414 issue text", () => {
    const text = "Attempting to get `http://.example.com` results in a `UnicodeError`."
    expect(extractErrors(text)).toEqual(["UnicodeError"])
  })

  test("verbatim message body retained when colon-suffix present", () => {
    const text = "got UnicodeError: encoding with 'idna' codec failed"
    expect(extractErrors(text)).toEqual(["UnicodeError: encoding with 'idna' codec failed"])
  })

  test("both bare and message-bearing forms can co-exist (sorted)", () => {
    // Same TYPE with and without a message body deduplicates to distinct
    // entries — both forms carry information for the model.
    const text = "raises UnicodeError sometimes; specifically UnicodeError: bad codec name"
    const out = extractErrors(text)
    expect(out).toContain("UnicodeError")
    expect(out).toContain("UnicodeError: bad codec name")
  })

  test("message tail length-capped at 256 chars", () => {
    const big = "x".repeat(500)
    const text = `TypeError: ${big}`
    const out = extractErrors(text)
    expect(out.length).toBe(1)
    const entry = out[0] ?? ""
    // Type prefix + colon-space (2) + capped body
    expect(entry.length).toBeLessThanOrEqual(2 + "TypeError".length + 256)
    expect(entry.startsWith("TypeError: ")).toBe(true)
  })

  test("message stops at newline (next line is NOT part of the error)", () => {
    const text = "TypeError: bad arg\nNext line is unrelated text"
    expect(extractErrors(text)).toEqual(["TypeError: bad arg"])
  })

  test("InvalidURL pattern (Url not Error suffix) NOT captured by this extractor", () => {
    // `InvalidURL` doesn't end in Error/Exception/Warning — by design, it
    // surfaces via `extractSymbols` (backtick fence) instead.
    expect(extractErrors("raises InvalidURL")).toEqual([])
  })

  test("regex state isolation", () => {
    const text = "TypeError"
    expect(extractErrors(text)).toEqual(["TypeError"])
    expect(extractErrors(text)).toEqual(["TypeError"])
  })
})
