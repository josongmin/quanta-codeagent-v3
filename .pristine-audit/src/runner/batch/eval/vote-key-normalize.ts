/**
 * Strategy hardening (#3 rerank) — stronger patch-vote KEY, toward Agentless parity.
 *
 * Agentless's majority vote dedups candidates on an AST-CANONICAL key
 * (`postprocess_data.normalize_code`: `ast.parse → ast.unparse` + remove
 * comments/docstrings), so two samples that make the SAME fix but differ only in a
 * comment / blank line / trailing whitespace vote TOGETHER and reinforce the
 * majority. Our acceptance rerank used the raw trimmed patch as the key
 * (`acceptance-adapter.trimKey`), so those cosmetic variants split the vote and
 * weaken the majority — a real capability gap the adversarial audit surfaced.
 *
 * We do NOT re-implement an AST round-trip (it needs file content + a per-language
 * parser); instead we COMPOSE the existing diff normalizer (`selection-paths
 * .normalizePatch` — keeps `+/-` content + file headers, drops `@@` offsets + trims)
 * and add the comment/blank-line strip. This captures the dominant cosmetic-variant
 * dedup (comments, blank lines, trailing whitespace, hunk offsets) purely from the
 * diff text — no sandbox, no AST. NO-LEAK: operates only on the patch text.
 *
 * Behavior is OFF by default (the driver injects this only behind a knob); the
 * acceptance path otherwise keeps its raw-trim key (byte-identical).
 */

import { normalizePatch } from "./selection-paths"

/** A unified-diff FILE header line (`+++ b/x`, `--- a/x`) — kept verbatim (the SAME
 *  content edit on DIFFERENT files is a DIFFERENT fix site, must not collide). */
const isFileHeader = (line: string): boolean => line.startsWith("+++") || line.startsWith("---")

/** A `+/-` CONTENT line whose payload (minus the single prefix char) is blank or a
 *  whole-line comment (`#…` Python / `//…` JS-TS). Dropped from the vote key so a
 *  comment-only / blank-line difference does not split the majority. Conservative:
 *  only WHOLE-LINE comments (never splits `code  # trailing` — a `#` could be inside
 *  a string; that needs the AST we deliberately avoid). */
const isCommentOrBlankContent = (line: string): boolean => {
  if (isFileHeader(line)) return false
  const payload = line.slice(1).trim() // drop the single +/- prefix
  return payload === "" || payload.startsWith("#") || payload.startsWith("//")
}

/**
 * Stronger vote key: the existing `normalizePatch` (file headers + `+/-` content,
 * `@@` offsets dropped, trailing ws trimmed) MINUS whole-line comment/blank content
 * lines. Two patches collide iff they make the same NON-COMMENT edits to the same
 * files. Pure + deterministic.
 */
export const strongVoteKey = (patch: string): string =>
  normalizePatch(patch)
    .split("\n")
    .filter((l) => !isCommentOrBlankContent(l))
    .join("\n")
