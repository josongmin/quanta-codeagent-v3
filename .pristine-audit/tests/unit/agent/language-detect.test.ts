/**
 * N1 — assistant language auto-detect (absorb: Cursor `whichlang` /
 * assistant-language-tracking). Pure Unicode-script classifier: count
 * meaningful chars by script, argmax (NO magic %), map script→language with a
 * confidence. Non-Latin single-language scripts ⇒ `high`; Latin (ambiguous
 * across en/es/fr/...) ⇒ `low` so the prompt-hint wiring only fires on a
 * confident non-English signal (English/ambiguous ⇒ byte-identical).
 */
import { describe, expect, test } from "bun:test"
import { buildLanguageHint, detectLanguage } from "@/agent/language-detect"

describe("detectLanguage — Unicode-script classifier", () => {
  test("Hangul-dominant ⇒ ko / high", () => {
    expect(detectLanguage("안녕하세요 오늘 날씨 어때요")).toEqual({
      lang: "ko",
      confidence: "high",
    })
  })

  test("Japanese (kana present) ⇒ ja / high — even with Han", () => {
    expect(detectLanguage("こんにちは 今日は いい天気ですね")).toEqual({
      lang: "ja",
      confidence: "high",
    })
  })

  test("Han without kana ⇒ zh / high", () => {
    expect(detectLanguage("今天天气很好我们一起去公园散步")).toEqual({
      lang: "zh",
      confidence: "high",
    })
  })

  test("Cyrillic-dominant ⇒ ru / high", () => {
    expect(detectLanguage("Привет как дела сегодня хорошо")).toEqual({
      lang: "ru",
      confidence: "high",
    })
  })

  test("Latin (ambiguous) ⇒ en / low — never forces a guess", () => {
    const r = detectLanguage("hello how are you doing today")
    expect(r?.lang).toBe("en")
    expect(r?.confidence).toBe("low")
  })

  test("argmax over scripts — a few foreign chars in English stay Latin/low (no false ko)", () => {
    // 5 Latin words ≫ 1 Hangul token: Latin wins ⇒ low (hint must NOT fire).
    const r = detectLanguage("please read the file 네 and continue")
    expect(r?.confidence).toBe("low")
    expect(r?.lang).not.toBe("ko")
  })

  test("Korean majority with some English ⇒ ko / high", () => {
    expect(
      detectLanguage("이 파일 src/foo.ts 를 읽고 버그를 고쳐줘 그리고 테스트도 돌려줘")?.lang,
    ).toBe("ko")
  })

  test("empty / whitespace / punctuation-only / digits ⇒ undefined (no meaningful chars)", () => {
    expect(detectLanguage("")).toBeUndefined()
    expect(detectLanguage("   \n\t  ")).toBeUndefined()
    expect(detectLanguage("!!! ... ??? --- 123 456")).toBeUndefined()
  })
})

describe("buildLanguageHint — gated prompt notice (default-OFF byte-identical)", () => {
  test("gate OFF ⇒ undefined regardless of language (byte-identical)", () => {
    expect(buildLanguageHint("안녕하세요 오늘 코드 고쳐줘", false)).toBeUndefined()
  })

  test("gate ON + high-confidence non-English ⇒ notice naming the language", () => {
    const hint = buildLanguageHint("이 파일 읽고 버그 고쳐줘 테스트도 돌려줘", true)
    expect(hint).toBeDefined()
    expect(hint).toContain("Korean")
    expect(hint).toContain("ko")
  })

  test("gate ON + English / Latin (low conf) ⇒ undefined (never force a guess)", () => {
    expect(buildLanguageHint("please read this file and fix the bug", true)).toBeUndefined()
  })

  test("gate ON + empty / no user text ⇒ undefined", () => {
    expect(buildLanguageHint(undefined, true)).toBeUndefined()
    expect(buildLanguageHint("", true)).toBeUndefined()
    expect(buildLanguageHint("```\n42\n```", true)).toBeUndefined()
  })

  test("gate ON + Japanese ⇒ notice names Japanese", () => {
    expect(buildLanguageHint("このファイルを読んで直して", true)).toContain("Japanese")
  })
})
