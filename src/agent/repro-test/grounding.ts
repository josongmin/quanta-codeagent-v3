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

/** A line is "structural" (kept verbatim) iff it starts a top-level import, a
 *  decorator, or a def/class signature. Captured at any indent so nested
 *  fixtures/classes keep their shape. */
const IMPORT_OR_DECORATOR = /^\s*(?:import\s|from\s+\S+\s+import\b|@)/
const DEF_OR_CLASS = /^\s*(?:async\s+)?(?:def|class)\b/

/** Width of the leading whitespace run (tabs counted as 1 — test files are
 *  space-indented; this only needs a monotone indent comparison). */
const indentWidth = (line: string): number => {
  let n = 0
  for (const ch of line) {
    if (ch === " " || ch === "\t") n++
    else break
  }
  return n
}

/** Leading-whitespace prefix of a line (for the elision placeholder indent). */
const leadingWhitespace = (line: string): string => line.slice(0, indentWidth(line))

/** Net unclosed-paren depth contributed by a line (ignores parens inside string
 *  literals only crudely — sufficient for def signatures, which rarely embed
 *  unbalanced parens in default-arg strings). */
const parenDelta = (line: string): number => {
  let depth = 0
  for (const ch of line) {
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
  }
  return depth
}

/**
 * Strip a Python test file to its SETUP SKELETON: keep imports, decorators, and
 * class/def signatures (incl. multi-line signatures); replace every function /
 * method / class body with a single elision placeholder. Module-level
 * non-structural statements (bare assignments, expressions — which could embed an
 * expected-value constant) are DROPPED. Consecutive blank lines are collapsed.
 *
 * This is the no-leak gate: assertion bodies — where the gold oracle lives — never
 * survive. The fixture pattern (decorator markers, fixture-param signatures, import
 * paths) — the value — does. Pure. Empty/whitespace ⇒ `""`.
 */
const SIG_ENDS = /:\s*(#.*)?$/

/** Capture a (possibly multi-line) def/class signature starting at `lines[start]`,
 *  consuming continuation lines until paren-balanced AND a line ends with ":".
 *  Returns the signature lines and the index just past them. Pure. */
const captureSignature = (
  lines: readonly string[],
  start: number,
): { readonly sig: readonly string[]; readonly next: number } => {
  const first = lines[start] ?? ""
  const sig: string[] = [first]
  let depth = parenDelta(first)
  let i = start + 1
  let done = depth <= 0 && SIG_ENDS.test(first)
  while (!done && i < lines.length) {
    const cont = lines[i] ?? ""
    sig.push(cont)
    depth += parenDelta(cont)
    done = depth <= 0 && SIG_ENDS.test(cont)
    i++
  }
  return { sig, next: i }
}

export const stripTestBodies = (src: string): string => {
  if (typeof src !== "string" || src.trim() === "") return ""
  const lines = src.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const ln = lines[i] ?? ""
    if (DEF_OR_CLASS.test(ln)) {
      // Keep the signature + ONE elision placeholder. We do NOT skip the body
      // wholesale — nested def/class/decorator lines are kept by the main loop
      // (the fixture pattern often lives in methods inside a test class); only
      // non-structural STATEMENTS (asserts, calls, assignments) are dropped.
      const { sig, next } = captureSignature(lines, i)
      out.push(...sig, `${leadingWhitespace(ln)}    ...  # body elided (no-leak)`)
      i = next
      continue
    }
    if (IMPORT_OR_DECORATOR.test(ln) || ln.trim() === "") {
      // Structural line (import/from/decorator) or blank ⇒ keep verbatim.
      out.push(ln)
      i++
      continue
    }
    // Non-structural statement at ANY indent (module-level constant OR a body
    // line: assert / call / assignment): DROP — it may carry an expected-value
    // constant (leak) and is not fixture shape.
    i++
  }
  // Collapse runs of blank lines to a single blank; trim ends.
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
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
