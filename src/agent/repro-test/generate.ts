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
import type { ReproTestConfig, ReproTestKind } from "./types"

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

/** Optional grounding block injected when the issue body embeds a confidently
 *  EXECUTABLE Minimal Working Example (extracted fail-closed by
 *  `extractIssueRepro`). The MWE is the issue author's OWN reproduction — it is
 *  known to trigger the bug — but it does NOT print the sentinel markers. We
 *  hand it to the model as the SEED to wrap in the sentinel scaffold (Agentless
 *  §3.3.1 grounding), instead of letting the model guess a reproduction from
 *  prose. Empty/whitespace `mwe` ⇒ no block (byte-identical to the un-grounded
 *  prompt). Returns the lines to splice before the trailing example. Pure. */
const groundingBlock = (mwe: string | undefined): readonly string[] => {
  if (typeof mwe !== "string" || mwe.trim() === "") return []
  return [
    "",
    "# Known reproduction (the issue author's own minimal working example).",
    "# This code is known to TRIGGER the bug but does NOT yet print the sentinel",
    "# lines. Build your script AROUND this exact code: keep its imports and the",
    "# call(s) that trigger the bug, then add the print-contract above so the",
    "# script prints one of the three sentinel lines. Do NOT invent a different",
    "# reproduction — adapt THIS one.",
    "```python",
    mwe,
    "```",
  ]
}

/**
 * HARDENING-coverage block (jun-19 #10999 under-fix class, jun-23 split).
 *
 * ⚠️ SCOPE CHANGE (jun-23): this block governs HARDENING generation ONLY. It is
 * the ADVISORY adversarial set (boundary / must-reject / consistency), NOT the
 * canonical submit oracle. It is spliced ONLY into a `kind === "hardening"`
 * prompt; the canonical prompt NEVER sees it.
 *
 * WHY the split: folding "print 'Issue resolved' ONLY if EVERY case behaves
 * correctly" into the SUBMIT oracle made it a 75% gold false-NEGATIVE (the
 * canonical-correct gold fix could not satisfy the many incidental cases), which
 * the proof-required gate then treated as authority to WITHHOLD a correct patch —
 * structurally unwinnable. Hardening reproes stay RED on a shallow fix (good for
 * tie-break / repair seeding) but must NEVER block submit.
 *
 * The over-strict "EVERY case must pass" demand is RETAINED here on purpose: it
 * is exactly what makes a hardening repro a sensitive shallow-fix detector. It is
 * safe ONLY because the driver routes hardening reproes to the advisory lane, not
 * the submit gate. Pure. */
const hardeningBlock = (): readonly string[] => [
  "",
  "Make this reproduction ADVERSARIAL / HARDENING. A shallow fix that only handles",
  'the single example in the issue must STILL print "Issue reproduced". Beyond that',
  "literal example, exercise the cases below that apply to THIS bug:",
  "  - boundary / edge values (empty, zero, negative, very large, range limits);",
  "  - inputs that SHOULD be rejected or raise (malformed, out-of-domain): assert",
  "    they are rejected / None / error, NOT silently accepted;",
  "  - consistency a correct fix must preserve (a sign or transform applied",
  "    uniformly, round-trip or symmetry equality).",
  "Derive the EXPECTED behavior by reasoning about what a CORRECT fix must do. Do",
  "NOT copy any fix, regex, or patch the issue itself proposes — issue-suggested",
  "fixes are frequently incomplete. Use several concrete cases and print",
  '"Issue resolved" ONLY if EVERY case behaves correctly.',
]

/** Build the user message. Paper format: issue text + explicit print-contract
 *  + a tiny example so the LLM emits the exact sentinel strings (not
 *  paraphrases like `"the issue was reproduced"`).
 *
 *  When `mwe` is a non-empty extracted Minimal Working Example, a grounding
 *  block is spliced in (see {@link groundingBlock}) so the model wraps the
 *  KNOWN-reproducing code in the sentinel scaffold rather than guessing. When
 *  `mwe` is undefined/empty the output is byte-identical to the pre-feature
 *  prompt.
 *
 *  `kind` (jun-23 canonical/hardening split) selects the contract:
 *    - `"canonical"` (default): the PLAIN "reproduce the CORE symptom" contract.
 *      The minimal correct fix MUST be able to flip it to "Issue resolved". NO
 *      adversarial over-strictness. This is the submit-gate oracle prompt and is
 *      byte-identical to the legacy un-adversarial prompt.
 *    - `"hardening"`: the {@link hardeningBlock} is spliced in so a shallow
 *      happy-path fix stays RED (#10999 under-fix class). ADVISORY only. */
export const buildReproTestPrompt = (
  issue: string,
  mwe?: string,
  kind: ReproTestKind = "canonical",
): string =>
  [
    "Write a Python script that reproduces the bug described in the issue below.",
    "",
    "The script must:",
    "1. Import the project's library code and exercise the buggy behavior described in the issue.",
    "2. Decide the verdict by comparing the ACTUAL behavior to the EXPECTED behavior",
    "   stated in the issue (what it should do vs what it currently does).",
    ...(kind === "canonical"
      ? [
          "   Exercise the issue's CORE symptom only — the single behavior the issue is",
          "   actually about. Do NOT demand secondary / incidental cases; a minimal",
          '   correct fix of the reported bug must be enough to make it print "Issue',
          '   resolved".',
        ]
      : []),
    "3. Print EXACTLY ONE of these three lines (no other variants):",
    '   - "Issue reproduced" if the bug is currently present (the issue is NOT fixed)',
    '   - "Issue resolved"   if the bug appears fixed (ACTUAL matches EXPECTED)',
    '   - "Other issues"     if the script hits unexpected errors',
    "",
    "Reliability (the marker is an automated gate — it MUST be trustworthy):",
    "  - The marker line MUST be the LAST line the script prints.",
    "  - Do NOT run further code, assert, raise, or call sys.exit() AFTER printing",
    "    the marker — let the script exit cleanly (exit code 0). A correct fix that",
    '    prints "Issue resolved" but then crashes would be misread as still-broken.',
    "  - Wrap the bug-exercising code in try/except so an unexpected error prints",
    '    "Other issues" instead of aborting before any marker.',
    ...(kind === "hardening" ? hardeningBlock() : []),
    "",
    "Output only the Python source code. No explanation. No markdown fences.",
    "",
    "# Issue",
    issue,
    ...groundingBlock(mwe),
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
  /** Extracted Minimal Working Example from the issue body (the author's own
   *  reproduction). When present, grounds the prompt so the model wraps THIS
   *  known-reproducing code in the sentinel scaffold instead of guessing.
   *  Undefined/empty ⇒ byte-identical to the un-grounded prompt. */
  mwe?: string
  /** jun-23 canonical/hardening split. `"canonical"` (default) emits the plain
   *  core-symptom submit-gate prompt; `"hardening"` emits the advisory
   *  adversarial set. Back-compat: omitting it is byte-identical to the legacy
   *  un-adversarial prompt. */
  kind?: ReproTestKind
}): Promise<readonly string[]> => {
  const { issue, llm, signal, mwe } = args
  if (typeof issue !== "string" || issue.length === 0) return []
  const samples = resolveSamples(args.config?.samples)
  const userText = buildReproTestPrompt(issue, mwe, args.kind ?? "canonical")
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: userText }] }]
  const out: string[] = []
  for (let i = 0; i < samples; i++) {
    if (signal?.aborted === true) break
    out.push(await generateOne(llm, messages, signal))
  }
  return out
}

// NOTE (jun-23): the canonical+hardening tagging used to live here as
// `generateReproTestCandidates`, but the bench driver needs the INJECTABLE
// `deps.generate` seam, so the split is performed in the driver's
// `generateReproCandidateTests` (the single, tested real path). This module
// stays the pure per-`kind` generator to avoid a second, untested code path.
