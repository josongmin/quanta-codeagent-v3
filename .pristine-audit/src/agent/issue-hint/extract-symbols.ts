/**
 * Symbol (function / class / method) extraction from issue text.
 *
 * Three signal classes:
 *   1. Backtick-quoted single identifiers — `prepare_url`, `HTTPAdapter`.
 *      Highest precision because the author *explicitly* fenced the name.
 *   2. Python definitions — `def foo`, `class Bar`. Anchored on the keyword.
 *   3. TS/JS definitions — `function foo`, `class Bar`, `const foo = () =>`.
 *
 * Conservative filter: language keywords themselves (def/class/function/if/for
 * /while/return/import/from/in) never count as symbols, even if backtick-
 * fenced, because they almost never carry localization signal. Single-letter
 * identifiers (`x`, `i`) are also rejected — too noisy.
 *
 * Hardening:
 *   - prototype-pollution: `__proto__`/`constructor`/`prototype` rejected
 *   - identifier length cap (80 chars)
 *   - ANSI escape codes stripped before scanning (terminal-output paste safety)
 *   - all matches deduped and sorted for byte-stable output
 */
import { stripAnsi } from "./normalize"

/** Words we never emit as symbols even when backtick-fenced. */
const KEYWORD_DENYLIST = new Set([
  "def",
  "class",
  "function",
  "if",
  "else",
  "elif",
  "for",
  "while",
  "return",
  "import",
  "from",
  "in",
  "is",
  "not",
  "and",
  "or",
  "try",
  "except",
  "finally",
  "raise",
  "with",
  "as",
  "pass",
  "yield",
  "lambda",
  "True",
  "False",
  "None",
  "null",
  "undefined",
  "true",
  "false",
  "var",
  "let",
  "const",
  "async",
  "await",
  "new",
  "this",
  "self",
  "super",
  "typeof",
  "instanceof",
  "void",
])

const RESERVED = new Set(["__proto__", "constructor", "prototype"])

const MAX_LEN = 80

/** Backtick-quoted single identifier: ` `foo` ` or ` `Foo.bar` `. We grab the
 *  whole bracketed token then extract the leaf identifier component(s). */
const BACKTICK_RE = /`([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)`/g

/** Python `def name(` and `class Name(` or `class Name:`. */
const PY_DEF_RE = /\b(?:def|class)\s+([A-Za-z_][\w]*)/g

/** TS/JS `function name(`, `class Name`, and `const/let name = ... =>`. */
const TSJS_FUNC_RE = /\bfunction\s+([A-Za-z_$][\w$]*)/g
const TSJS_CLASS_RE = /\bclass\s+([A-Za-z_$][\w$]*)/g
const TSJS_ARROW_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g

const acceptable = (id: string | undefined): id is string => {
  if (id === undefined) return false
  if (id.length === 0 || id.length > MAX_LEN) return false
  if (id.length === 1) return false
  if (KEYWORD_DENYLIST.has(id)) return false
  if (RESERVED.has(id)) return false
  return true
}

const scanBackticks = (text: string, found: Set<string>): void => {
  BACKTICK_RE.lastIndex = 0
  for (const m of text.matchAll(BACKTICK_RE)) {
    const raw = m[1]
    if (typeof raw !== "string") continue
    if (raw.includes(".")) {
      // Dotted forms `a.b.c`: emit each component ONLY when every part is
      // acceptable. We don't emit the dotted form itself — components are
      // more useful as localization signals.
      const parts = raw.split(".")
      if (parts.every((p) => acceptable(p))) {
        for (const p of parts) found.add(p)
      }
      continue
    }
    if (acceptable(raw)) found.add(raw)
  }
}

const scanDefinitions = (text: string, found: Set<string>): void => {
  for (const re of [PY_DEF_RE, TSJS_FUNC_RE, TSJS_CLASS_RE, TSJS_ARROW_RE]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const id = m[1]
      if (acceptable(id)) found.add(id)
    }
  }
}

export const extractSymbols = (text: string): readonly string[] => {
  if (typeof text !== "string" || text === "") return []
  const cleaned = stripAnsi(text)
  const found = new Set<string>()
  scanBackticks(cleaned, found)
  scanDefinitions(cleaned, found)
  return Array.from(found).sort()
}
