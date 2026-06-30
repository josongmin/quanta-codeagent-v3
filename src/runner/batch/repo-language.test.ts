import { describe, expect, test } from "bun:test"
import {
  isJsLikeRepoLanguage,
  normalizeRepoLanguage,
  normalizeRepoLanguageWithPythonDefault,
} from "./repo-language"

describe("repo-language", () => {
  test("normalizes repo language spellings into canonical values", () => {
    expect(normalizeRepoLanguage(undefined)).toBeUndefined()
    expect(normalizeRepoLanguage("")).toBeUndefined()
    expect(normalizeRepoLanguage("python")).toBe("python")
    expect(normalizeRepoLanguage("Python3")).toBe("python")
    expect(normalizeRepoLanguage("py")).toBe("python")
    expect(normalizeRepoLanguage("cpython")).toBe("python")
    expect(normalizeRepoLanguage("go")).toBe("go")
    expect(normalizeRepoLanguage("javascript")).toBe("js")
    expect(normalizeRepoLanguage("ts")).toBe("ts")
    expect(normalizeRepoLanguage("rust")).toBeUndefined()
  })

  test("defaults only absent repo language to python, not explicit unknown languages", () => {
    expect(normalizeRepoLanguageWithPythonDefault(undefined)).toBe("python")
    expect(normalizeRepoLanguageWithPythonDefault("")).toBe("python")
    expect(normalizeRepoLanguageWithPythonDefault("python")).toBe("python")
    expect(normalizeRepoLanguageWithPythonDefault("go")).toBe("go")
    expect(normalizeRepoLanguageWithPythonDefault("rust")).toBeUndefined()
  })

  test("keeps JS and TS grouped without widening to other languages", () => {
    expect(isJsLikeRepoLanguage("js")).toBe(true)
    expect(isJsLikeRepoLanguage("typescript")).toBe(true)
    expect(isJsLikeRepoLanguage("python")).toBe(false)
    expect(isJsLikeRepoLanguage("go")).toBe(false)
    expect(isJsLikeRepoLanguage("rust")).toBe(false)
  })
})
