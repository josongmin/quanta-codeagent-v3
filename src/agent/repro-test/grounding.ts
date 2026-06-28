/**
 * Repro-test GROUNDING — repo-context injection for repro generation (jun-29 RFC).
 *
 * Why
 * ===
 * A1 per-candidate artifacts (prod sphinx campaign) showed ~40% of generated repro
 * candidates `exec_failed` (`test_errored`): the model HAND-ROLLS full framework
 * setup (e.g. a Sphinx build) because the prompt gives it only the issue text — it
 * has never seen how THIS repo's tests import the module / declare fixtures. Two
 * instances reproduced only 1/5 (4/5 crashed on hand-rolled setup).
 *
 * Fix (Agentless/SWE-RL "retrieve existing test to guide generation"): splice the
 * SETUP SKELETON of a relevant existing test + the issue-symbol signatures into the
 * prompt, so the model COPIES the repo's real fixture pattern instead of guessing.
 *
 * NO-LEAK is the load-bearing invariant
 * =====================================
 * An existing test file can contain the gold FAIL_TO_PASS oracle (or, for tests
 * modified-not-added by `test_patch`, the very assertions the fix must satisfy).
 * Injecting test BODIES would hand the model the answer. So this module ships
 * {@link stripTestBodies}: keep imports + decorators + class/def SIGNATURES (the
 * fixture pattern — the value), ELIDE every function body (the assertions — the
 * leak). The block builders only ever consume stripped skeletons; the fence test
 * (`grounding.test.ts`) is red-on-injection: a secret expected value placed in an
 * assertion must NOT survive the strip.
 *
 * Slice posture
 * =============
 *   - pure: no I/O, no `node:fs`, no LLM. Retrieval (reading the repo, picking the
 *     relevant test) lives in the driver-side adapter; this module only TRANSFORMS
 *     already-read source and FORMATS prompt lines.
 *   - empty/whitespace inputs ⇒ `[]` / `""` (byte-identical to the un-grounded
 *     prompt — the default-OFF invariant rides on this).
 */

/** A line is "structural" iff it starts a top-level import, a decorator, or a
 *  def/class signature. Captured at any indent so nested fixtures/classes keep
 *  their shape. IMPORT is kept verbatim (module paths are not oracle values);
 *  DECORATOR + SIGNATURE lines are LITERAL-REDACTED before keeping. */
const IMPORT_LINE = /^\s*(?:import\s|from\s+\S+\s+import\b)/
const DECORATOR_LINE = /^\s*@/
const DEF_OR_CLASS = /^\s*(?:async\s+)?(?:def|class)\b/

/** Hard cap on a single emitted skeleton (RFC R3 token bound, ~char proxy). A
 *  large test class kept as dozens of verbatim signatures must not blow the
 *  prompt budget; head-truncate with an elision marker. */
const MAX_SKELETON_CHARS = 6000

/** Leading-whitespace prefix of a line (for the elision placeholder indent). */
const leadingWhitespace = (line: string): string => {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0] : ""
}

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9"
const isIdentChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch)

/** Index just past a string literal whose opening quote is at `start` (handles
 *  backslash escapes). Pure. */
const pastString = (line: string, start: number): number => {
  const q = line[start]
  let i = start + 1
  while (i < line.length && line[i] !== q) {
    if (line[i] === "\\") i++
    i++
  }
  return i + 1
}

/** Net bracket depth contributed by a single char (0 for non-brackets). */
const BRACKET_DELTA: Readonly<Record<string, number>> = {
  "(": 1,
  "[": 1,
  "{": 1,
  ")": -1,
  "]": -1,
  "}": -1,
}

/** Index just past the numeric-literal run (digits + dots) starting at `i`. */
const numericRunEnd = (line: string, i: number): number => {
  let j = i
  while (j < line.length && (isDigit(line[j]) || line[j] === ".")) j++
  return j
}

/**
 * Single-pass scan of one source line that simultaneously (a) REDACTS the
 * CONTENTS of string literals to empty and numeric literals to `0` — the only
 * places a kept decorator/signature line can carry a gold/expected VALUE — and
 * (b) optionally CUTS the line at its first top-level `:` (paren-depth 0, not in
 * a string), dropping any single-line body after it. String-aware so a `:`,
 * quote, or paren inside a literal cannot confuse depth/cut. Pure.
 *
 * This is the no-leak hardening (C6 audit): a single-line `def f(): assert x ==
 * "GOLD"` is cut to `def f():`; `@parametrize("a,expected", [(1,"GOLD")])` keeps
 * the marker shape but the expected table becomes `("", [(0,"")])`; a nested
 * `def inner(default="LEAK")` becomes `def inner(default="")`. The fixture
 * PATTERN (names, markers, structure) survives; literal VALUES never do.
 */
const redactAndMaybeCut = (line: string, cutAtTopLevelColon: boolean): string => {
  let out = ""
  let i = 0
  let depth = 0
  while (i < line.length) {
    const ch = line[i] ?? ""
    if (ch === '"' || ch === "'") {
      // String literal ⇒ emit empty quotes (content redacted), skip to past-close.
      out += ch + ch
      i = pastString(line, i)
      continue
    }
    if (cutAtTopLevelColon && ch === ":" && depth <= 0) return `${out}:`
    if (isDigit(ch) && !isIdentChar(line[i - 1])) {
      // Standalone numeric literal ⇒ `0` (an expected number could be the gold).
      i = numericRunEnd(line, i)
      out += "0"
      continue
    }
    depth += BRACKET_DELTA[ch] ?? 0
    out += ch
    i++
  }
  return out
}

/** True once `line` (scanned from `startDepth`) reaches a top-level `:` —
 *  i.e. the signature header ends here (mid-line or at line end). String-aware.
 *  Returns the ending paren depth too. Pure. */
const signatureCloses = (
  line: string,
  startDepth: number,
): { readonly closed: boolean; readonly depth: number } => {
  let depth = startDepth
  let i = 0
  while (i < line.length) {
    const ch = line[i] ?? ""
    if (ch === '"' || ch === "'") {
      i = pastString(line, i)
      continue
    }
    if (ch === ":" && depth <= 0) return { closed: true, depth }
    depth += BRACKET_DELTA[ch] ?? 0
    i++
  }
  return { closed: false, depth }
}

/** Capture a (possibly multi-line) def/class signature starting at `lines[start]`,
 *  consuming continuation lines until a top-level `:` closes the header. Each
 *  captured line is literal-redacted; the closing line is cut at its colon so a
 *  single-line body is dropped. Returns the redacted signature + next index. */
const captureSignature = (
  lines: readonly string[],
  start: number,
): { readonly sig: readonly string[]; readonly next: number } => {
  const sig: string[] = []
  let depth = 0
  let i = start
  while (i < lines.length) {
    const line = lines[i] ?? ""
    const { closed, depth: d } = signatureCloses(line, depth)
    if (closed) {
      sig.push(redactAndMaybeCut(line, true))
      return { sig, next: i + 1 }
    }
    sig.push(redactAndMaybeCut(line, false))
    depth = d
    i++
  }
  return { sig, next: i }
}

/**
 * Strip a Python test file to its SETUP SKELETON: keep imports verbatim, keep
 * literal-redacted decorators + class/def signatures (incl. multi-line; a
 * single-line body is cut at the colon), replace every body with one elision
 * placeholder. Module-level + body STATEMENTS (asserts/calls/assignments) are
 * DROPPED. Consecutive blank lines collapsed; output head-truncated to
 * {@link MAX_SKELETON_CHARS}.
 *
 * No-leak gate (C6-hardened): assertion bodies — where the gold oracle lives —
 * never survive, AND no kept line carries a string/number literal VALUE. The
 * fixture pattern (import paths, decorator markers, fixture-param signatures) —
 * the value — does. Pure. Empty/whitespace ⇒ `""`.
 */
export const stripTestBodies = (src: string): string => {
  if (typeof src !== "string" || src.trim() === "") return ""
  const lines = src.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const ln = lines[i] ?? ""
    if (DEF_OR_CLASS.test(ln)) {
      const { sig, next } = captureSignature(lines, i)
      out.push(...sig, `${leadingWhitespace(ln)}    ...  # body elided (no-leak)`)
      i = next
      continue
    }
    if (IMPORT_LINE.test(ln) || ln.trim() === "") {
      // Import / from (module paths — not oracle values) or blank ⇒ verbatim.
      out.push(ln)
      i++
      continue
    }
    if (DECORATOR_LINE.test(ln)) {
      // Decorator ⇒ keep the marker SHAPE but redact literal args (a
      // `@parametrize([... "GOLD" ...])` table is a gold oracle).
      out.push(redactAndMaybeCut(ln, false))
      i++
      continue
    }
    // Non-structural statement at ANY indent ⇒ DROP (assert/call/assignment;
    // may carry an expected-value constant).
    i++
  }
  const joined = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return joined.length > MAX_SKELETON_CHARS
    ? `${joined.slice(0, MAX_SKELETON_CHARS)}\n# … skeleton truncated (no-leak)`
    : joined
}

/** Heading lines shared by the exemplar block (kept as a const so the fence test
 *  can assert the block frames the skeletons honestly). */
export const EXEMPLAR_BLOCK_HEADER =
  "# Existing tests in THIS repo — copy their import paths, fixtures, and setup pattern."

/**
 * Build the exemplar grounding block: the SETUP SKELETONS of relevant existing
 * tests, framed so the model copies the repo's real fixture/setup pattern instead
 * of hand-rolling framework setup. Each skeleton is fence-wrapped Python.
 *
 * Inputs are assumed ALREADY stripped via {@link stripTestBodies} by the
 * driver-side adapter, but this builder defensively re-strips each one so a
 * caller that forgets cannot leak a body through the prompt. Empty / all-blank ⇒
 * `[]` (byte-identical to the un-grounded prompt). Pure.
 */
export const exemplarBlock = (skeletons: readonly string[] | undefined): readonly string[] => {
  if (skeletons === undefined) return []
  const cleaned = skeletons.map((s) => stripTestBodies(s)).filter((s) => s.trim() !== "")
  if (cleaned.length === 0) return []
  const body: string[] = [
    "",
    EXEMPLAR_BLOCK_HEADER,
    "# These are SETUP SKELETONS (assertion bodies are elided): mirror how they",
    "# import the package and declare fixtures/markers — do NOT hand-roll your own",
    "# framework setup. Write YOUR OWN assertions for the issue's bug.",
  ]
  for (const sk of cleaned) {
    body.push("```python", sk, "```")
  }
  return body
}

/** Heading for the signature block. */
export const SIGNATURE_BLOCK_HEADER =
  "# Public signatures of the symbols the issue mentions (use these EXACT shapes)."

/**
 * Build the issue-symbol signature block: the real public signatures (from LSP)
 * of the symbols the issue references, so the model stops GUESSING private/public
 * shapes (the wrong-API-guess subset of `no_reproduced` / `exec_failed`). Each
 * entry is a one-line signature string. Empty ⇒ `[]`. Pure.
 */
export const signatureBlock = (signatures: readonly string[] | undefined): readonly string[] => {
  if (signatures === undefined) return []
  const cleaned = signatures.map((s) => s.trim()).filter((s) => s !== "")
  if (cleaned.length === 0) return []
  return ["", SIGNATURE_BLOCK_HEADER, "```python", ...cleaned, "```"]
}
