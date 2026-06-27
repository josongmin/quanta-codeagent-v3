/**
 * Bench-resume DETERMINISM-COMPLETION — canonicalizing request-hash that MASKS
 * volatile tokens so a cassette recorded on box A replays HIT on box B even
 * though tool outputs (pytest durations, clock times, ISO timestamps) differ.
 *
 * WHY: after the deterministic-workdir fix, request prompts STILL embed volatile
 * tokens (durations `in 0.34s`, clock `HH:MM:SS`, ISO timestamps, pytest
 * summaries). The replay match is a CONTENT hash ("exact"), so request N+1's
 * prompt — which feeds back the PREVIOUS turn's tool output — mismatches across
 * boxes. The replay misses early and resume saves ~nothing. Fix = canonicalize
 * (mask) the volatile tokens BEFORE hashing, on BOTH record and replay sides.
 *
 * The replay store REHASHES every recorded candidate request with the
 * replay-side `hashRequest` ({@link import("@/llm/replay").jsonlReplayStore}
 * `match`), so applying {@link resumeHashRequest} on the replay side alone makes
 * record⇄replay symmetric. We also wire it on the record side so a cassette's
 * `id` field is canonical too (belt-and-suspenders; not load-bearing for match).
 *
 * SAFETY — FALSE-COLLAPSE MUST BE IMPOSSIBLE for semantic differences. The masks
 * are TARGETED + CONSERVATIVE: only the specific volatile shapes below are
 * replaced. Two requests that differ in REAL content (different code, file,
 * error message, line number, or COUNT like `5 passed` vs `6 passed`) MUST still
 * hash DIFFERENTLY. We deliberately do NOT mask: bare line numbers, version
 * strings, integer counts, identifiers, or file paths other than the random
 * workdir-suffix / temp-dir shapes below.
 *
 * DEFAULT-OFF / byte-identical: this module is only reached on the resume path
 * (recorder.ts S3 store + trajectory.ts replay when `resumeActive`). The default
 * record/replay path keeps using `defaultHashRequest` verbatim. This module does
 * NOT modify `defaultHashRequest` — it reuses it on the canonicalized request so
 * all the existing normalization (stable key sort, policy salt, field selection)
 * still applies on top of the masking.
 */

import { defaultHashRequest } from "@/llm/replay"
import type { MatchPolicy } from "@/llm/replay"
import type { Message, StreamInput, SystemBlock } from "@/llm/types"

/**
 * Ordered list of volatile masks. Each entry is applied in sequence; order
 * matters where one pattern's match could be a substring of another's (ISO
 * timestamps are masked BEFORE the bare clock-time mask so the `HH:MM:SS` tail
 * of an ISO string isn't independently rewritten to `<TIME>`).
 */
const VOLATILE_MASKS: ReadonlyArray<{ readonly re: RegExp; readonly to: string }> = [
  // ISO timestamps: 2017-07-06 20:50:00, 2024-01-02T03:04:05.678Z, +09:00 offsets.
  // Masked FIRST so the trailing HH:MM:SS isn't separately caught by the clock mask.
  {
    re: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g,
    to: "<TS>",
  },
  // Bare clock times: 21:21:54, 2:00:00. Word-bounded so we don't eat e.g. a
  // 4-segment version-ish "1:2:3:4" middle (the \b on each end keeps it tight).
  { re: /\b\d{1,2}:\d{2}:\d{2}\b/g, to: "<TIME>" },
  // Durations: a digit IMMEDIATELY followed (optionally one space) by a time
  // unit. The leading \b + required digit means we never touch a bare word like
  // "press" or "ms" alone — only "0.34s", "12 ms", "5ns".
  { re: /\b\d+(\.\d+)?\s?(ns|µs|us|ms|s)\b/g, to: "<DUR>" },
  // Random workdir suffixes (belt-and-suspenders with the deterministic-workdir
  // fix). repo-<hex/alnum>, bench-<name>-<suffix>, swebench-<name>-<suffix>.
  { re: /\bswebench-[\w.]+-[A-Za-z0-9]{6,}\b/g, to: "<WORK>" },
  { re: /\bbench-[\w.]+-[a-z0-9]{6,}\b/g, to: "<WORK>" },
  { re: /\brepo-[A-Za-z0-9]{6,}\b/g, to: "<WORK>" },
  // Hex addresses: 0x7f3a... (object reprs, traceback frame ids).
  { re: /0x[0-9a-fA-F]{4,}/g, to: "<ADDR>" },
  // Temp paths: /tmp/..., /var/folders/... (macOS). Up to the next whitespace
  // or quote so we don't swallow following prose.
  { re: /\/tmp\/[^\s"']+/g, to: "<TMP>" },
  { re: /\/var\/folders\/[^\s"']+/g, to: "<TMP>" },
]

/**
 * Replace ONLY the volatile patterns above with stable placeholders. PURE: no
 * I/O, no mutation of inputs. Conservative by construction — see SAFETY in the
 * module header. Over-masking would FALSE-COLLAPSE semantic differences, so the
 * mask set is intentionally narrow.
 */
export function canonicalizeForHash(text: string): string {
  let out = text
  for (const { re, to } of VOLATILE_MASKS) {
    // Each RegExp carries the global flag; String.replace resets lastIndex per
    // call so reusing the module-level instances is safe (no shared state leak).
    out = out.replace(re, to)
  }
  return out
}

/** Canonicalize the text of one message's content blocks, leaving every other
 *  field (roles, tool ids, schemas, non-text block kinds) byte-intact. */
function canonicalizeMessage(m: Message): Message {
  const content = m.content.map((block) => {
    if (block.type === "text") return { ...block, text: canonicalizeForHash(block.text) }
    if (block.type === "tool_result") {
      // tool_result.content is the verbatim tool output — the PRIMARY home of
      // volatile tokens (pytest durations live here, then echo into the next
      // user turn). Mask its text; leave structured contentBlocks/ids intact.
      return { ...block, content: canonicalizeForHash(block.content) }
    }
    return block
  })
  return { ...m, content }
}

/** Canonicalize the system prompt (string or block list). */
function canonicalizeSystem(
  system: StreamInput["system"],
): StreamInput["system"] {
  if (system === undefined) return undefined
  if (typeof system === "string") return canonicalizeForHash(system)
  return system.map((b: SystemBlock) => ({ ...b, text: canonicalizeForHash(b.text) }))
}

/**
 * Deep-copy `req` and run {@link canonicalizeForHash} over the TEXT content of
 * `messages` (+ `system`) ONLY. Structure, roles, tool schemas, tool ids,
 * thinking signatures, and every non-text field are left intact. PURE — the
 * input request is not mutated.
 */
export function canonicalizeRequest(req: StreamInput): StreamInput {
  const messages = req.messages.map(canonicalizeMessage)
  const system = canonicalizeSystem(req.system)
  // exactOptionalPropertyTypes: omit `system` when absent rather than set it to
  // `undefined`, preserving the exact field-presence shape `defaultHashRequest`
  // hashes (`req.system ?? null`).
  return {
    ...req,
    messages,
    ...(system !== undefined ? { system } : {}),
  }
}

/**
 * The resume-side request→hash function. Reuses {@link defaultHashRequest} on
 * the CANONICALIZED request, so all existing jsonl normalization (stable key
 * sort, policy salt, exact/messages-only/fuzzy field selection) still applies —
 * we only strip volatile tokens first. Pass this as the `hashRequest` option to
 * the resume S3 store and the resume replay store.
 */
export function resumeHashRequest(req: StreamInput, policy: MatchPolicy): string {
  return defaultHashRequest(canonicalizeRequest(req), policy)
}
