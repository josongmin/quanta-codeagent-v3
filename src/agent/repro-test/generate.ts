/**
 * Repro-test generation — drives the LLM K times to synthesise Python test
 * candidates per Agentless §3.3.1.
 *
 * What this is
 * ============
 * The function builds a single, paper-faithful prompt that asks the model to
 * emit a self-contained Python script that exercises the buggy behaviour and
 * prints EXACTLY one of three sentinels (`"Issue reproduced"` / `"Issue
 * resolved"` / `"Other issues"`). It then runs the LLM `K` times and returns
 * the K raw response strings (after markdown-fence stripping). Selection /
 * execution / outcome classification live in sibling modules.
 *
 * Paper deviation table (this file)
 * =================================
 *   - K — paper 40, our default 5. Caller controls.
 *   - temperature — paper 0.8 for 39 samples + greedy for 1. Our `LLMPort`
 *     has no temperature knob; each call uses the provider's default
 *     sampling. Two consequences:
 *       (a) for providers that sample (most adapters do at default temp),
 *           K independent calls give K independent samples — same shape as
 *           the paper's "39 sampled" plus a greedy one that we cannot
 *           explicitly request.
 *       (b) for a deterministic test double, every call returns the same
 *           text — `select.ts` will see them as a unanimous majority.
 *     We accept this trade-off rather than widen the `LLMPort` shape.
 *   - prompt — verbatim from paper §3.3.1, with the explicit `print(...)`
 *     contract enumerated.
 *
 * Slice posture
 * =============
 *   - no I/O beyond the LLM port; no `node:fs` / `node:child_process`.
 *   - any per-call exception is swallowed and a `""` source is recorded
 *     for that index (`execute.ts` classifies it `"unknown"` / skip).
 *   - markdown fences (` ``` `, ` ```python `) are stripped so the source
 *     written to disk is executable Python.
 *   - cancellation: the caller's `AbortSignal` is checked between samples;
 *     a triggered signal returns whatever was collected so far (best-effort
 *     partial result — `select.ts` is happy to operate on fewer samples).
 */

import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { ReproTestConfig } from "./types"

/** Default K when the caller doesn't override. Paper uses 40; 5 is our
 *  measurement-budget default. */
export const DEFAULT_SAMPLES = 5
/** Hard ceiling — the paper used 40 and that's a defensible upper bound. */
export const MAX_SAMPLES = 40
/** Default per-sample LLM timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** System prompt — Agentless paper §3.3.1, verbatim semantics. The
 *  print-contract triple is the load-bearing piece; do not edit lightly. */
const SYSTEM_MSG = [
  "You are a senior Python engineer writing a single self-contained script that reproduces a reported bug.",
  "Reason calmly. Output Python source code ONLY — no explanations, no markdown fences.",
].join("\n")

/** Build the user message. Paper format: issue text + explicit print-contract
 *  + a tiny example so the LLM emits the exact sentinel strings (not
 *  paraphrases like `"the issue was reproduced"`). */
export const buildReproTestPrompt = (issue: string): string =>
  [
    "Write a Python script that reproduces the bug described in the issue below.",
    "",
    "The script must:",
    "1. Import the project's library code and exercise the buggy behavior described in the issue.",
    "2. Print EXACTLY ONE of these three lines (no other variants):",
    '   - "Issue reproduced" if the bug is currently present (the issue is NOT fixed)',
    '   - "Issue resolved"   if the bug appears fixed',
    '   - "Other issues"     if the script hits unexpected errors',
    "",
    "Output only the Python source code. No explanation. No markdown fences.",
    "",
    "# Issue",
    issue,
    "",
    "# Example output (illustrative — replace with code for THIS issue):",
    "from package import thing",
    "",
    "try:",
    '    result = thing.do_something("bad input")',
    "    if result == expected_safe:",
    '        print("Issue resolved")',
    "    else:",
    '        print("Issue reproduced")',
    "except SomeError:",
    '    print("Issue reproduced")',
    "except Exception:",
    '    print("Other issues")',
  ].join("\n")

/** Strip leading / trailing ```fence lines (with optional language tag like
 *  ```python). Conservative: only removes a fence if the FIRST non-empty
 *  line is a triple-backtick line; otherwise returns the input verbatim.
 *  Pure helper — exported for direct unit testing. */
export const stripMarkdownFences = (raw: string): string => {
  if (typeof raw !== "string" || raw.length === 0) return ""
  // Tolerate CR/CRLF.
  const lines = raw.replace(/\r\n?/g, "\n").split("\n")
  // Find the first non-empty line.
  let start = 0
  while (start < lines.length) {
    const ln = lines[start]
    if (ln !== undefined && ln.trim() !== "") break
    start++
  }
  if (start >= lines.length) return ""
  const first = lines[start]
  if (first === undefined) return ""
  // Only strip if the leading line is a fence (```, ```py, ```python, …).
  if (!/^```/.test(first.trim())) return raw
  // Drop the fence line.
  start += 1
  // Find a closing fence (last non-empty line that is exactly ```).
  let end = lines.length - 1
  while (end > start) {
    const ln = lines[end]
    if (ln !== undefined && ln.trim() !== "") break
    end--
  }
  const last = lines[end]
  if (last !== undefined && /^```\s*$/.test(last.trim())) end -= 1
  return lines.slice(start, end + 1).join("\n")
}

/** Bounds-checked K. Returns 1 for any non-integer / negative / NaN / 0,
 *  caps at `MAX_SAMPLES`. */
const resolveSamples = (raw: number | undefined): number => {
  const n = raw ?? DEFAULT_SAMPLES
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULT_SAMPLES
  if (n < 1) return 1
  if (n > MAX_SAMPLES) return MAX_SAMPLES
  return n
}

/** Consume only the text surface we need for the Python source. A
 *  `stream_reset` tombstones any dead partial so the returned source matches
 *  the assembled-text behavior without retaining the whole event stream. */
const collectTextFromStream = async (iter: AsyncIterable<StreamEvent>): Promise<string> => {
  let raw = ""
  for await (const ev of iter) {
    switch (ev.type) {
      case "stream_reset":
        raw = ""
        break
      case "text_delta":
        raw += ev.delta
        break
      default:
        break
    }
  }
  return raw
}

/**
 * Run the LLM `K` times to synthesise K Python repro-test candidates.
 * Returns the raw source strings (markdown-fence stripped). On any per-call
 * exception, a `""` source is recorded for that index; the caller's
 * `executeReproTests` will classify a `""` source as `"unknown"` (since
 * Python's empty-script exit is 0 with empty stdout, no marker).
 *
 * Cancellation: between calls, if `signal.aborted` is true we return the
 * partial result. Inside a single call we cannot abort the LLM stream from
 * here (the `LLMPort` shape forwards the signal via `StreamInput`); we pass
 * it through.
 */
/** Drive ONE LLM call. Returns the assembled text (fence-stripped) or `""`
 *  on any exception. Extracted to bound `generateReproTests`'s cognitive
 *  complexity under the biome ceiling. */
const generateOne = async (
  llm: LLMPort,
  messages: Message[],
  signal: AbortSignal | undefined,
): Promise<string> => {
  try {
    const streamInput =
      signal !== undefined
        ? { messages, system: SYSTEM_MSG, tools: [], signal }
        : { messages, system: SYSTEM_MSG, tools: [] }
    const iter = llm.stream(streamInput)
    return stripMarkdownFences(await collectTextFromStream(iter))
  } catch {
    // Per-call failure → empty source. The caller's executor will classify
    // an empty source as `"unknown"` (no marker) and `select.ts` will
    // ignore it (only `"reproduced"` outcomes participate in the vote).
    return ""
  }
}

export const generateReproTests = async (args: {
  issue: string
  llm: LLMPort
  config?: ReproTestConfig
  signal?: AbortSignal
}): Promise<readonly string[]> => {
  const { issue, llm, signal } = args
  if (typeof issue !== "string" || issue.length === 0) return []
  const samples = resolveSamples(args.config?.samples)
  const userText = buildReproTestPrompt(issue)
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: userText }] }]
  const out: string[] = []
  for (let i = 0; i < samples; i++) {
    if (signal?.aborted === true) break
    out.push(await generateOne(llm, messages, signal))
  }
  return out
}
