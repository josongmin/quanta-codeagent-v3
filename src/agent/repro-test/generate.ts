/**
 * Repro-test generation — drives the LLM K times to synthesise Python test
 * candidates per Agentless §3.3.1.
 *
 * What this is
 * ============
 * The function builds a single prompt that asks the model to emit a
 * self-contained PYTEST test (P1, jun-23): one or more `def test_*` functions
 * with real `assert`s on the EXPECTED (correct) behaviour, plus a self-driving
 * footer that runs pytest on the file itself so the process exit code carries
 * the verdict. There are NO sentinel prints — the verdict is pytest's exit
 * semantics, which the model cannot author/paraphrase (the fakeability we are
 * removing). It then runs the LLM `K` times and returns the K raw response
 * strings (after markdown-fence stripping). Selection / execution / outcome
 * classification live in sibling modules.
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
 *   - prompt — adapted from paper §3.3.1: the model emits a PYTEST test (real
 *     `assert`s + self-driving footer) instead of a sentinel-printing script.
 *     The exit code is the verdict.
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

/** System prompt — Agentless paper §3.3.1 adapted for pytest (P1). The verdict
 *  is pytest's exit code, NOT a printed sentinel; the model must write real
 *  assertions, not narrate a conclusion. */
const SYSTEM_MSG = [
  "You are a senior Python engineer writing a single self-contained pytest test that reproduces a reported bug.",
  "Reason calmly. Output Python source code ONLY — no explanations, no markdown fences.",
  "The verdict is decided by pytest's exit code: your assertions FAIL on the buggy code and PASS once it is fixed. Do NOT print a verdict.",
].join("\n")

/** Optional grounding block injected when the issue body embeds a confidently
 *  EXECUTABLE Minimal Working Example (extracted fail-closed by
 *  `extractIssueRepro`). The MWE is the issue author's OWN reproduction — it is
 *  known to trigger the bug — but it is not yet a pytest test. We hand it to the
 *  model as the SEED to wrap in a `def test_*` with assertions (P1 grounding),
 *  instead of letting the model guess a reproduction from prose.
 *  Empty/whitespace `mwe` ⇒ no block (byte-identical to the un-grounded prompt).
 *  Returns the lines to splice before the trailing example. Pure. */
const groundingBlock = (mwe: string | undefined): readonly string[] => {
  if (typeof mwe !== "string" || mwe.trim() === "") return []
  return [
    "",
    "# Known reproduction (the issue author's own minimal working example).",
    "# This code is known to TRIGGER the bug. Build your pytest test AROUND this",
    "# exact code: keep its imports and the call(s) that trigger the bug, then",
    "# wrap it in a def test_* and assert the EXPECTED (correct) behavior so the",
    "# assertion FAILS on the current buggy code. Do NOT invent a different",
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
  "the single example in the issue must STILL leave at least one assertion FAILING.",
  "Beyond that literal example, assert the cases below that apply to THIS bug:",
  "  - boundary / edge values (empty, zero, negative, very large, range limits);",
  "  - inputs that SHOULD be rejected or raise (malformed, out-of-domain): assert",
  "    they are rejected / None / raise (use pytest.raises), NOT silently accepted;",
  "  - consistency a correct fix must preserve (a sign or transform applied",
  "    uniformly, round-trip or symmetry equality).",
  "Derive the EXPECTED behavior by reasoning about what a CORRECT fix must do. Do",
  "NOT copy any fix, regex, or patch the issue itself proposes — issue-suggested",
  "fixes are frequently incomplete. Write several assertions (across one or more",
  "def test_* functions); pytest passes ONLY if EVERY assertion holds.",
]

/** The self-driving pytest footer (P1 `python <path>`→pytest bridge). The driver
 *  invokes a repro as `python <path>`; pytest must drive the assertions. This
 *  footer runs pytest on the file ITSELF so the process exit code is the verdict.
 *
 *  The `if __name__ == "__main__"` guard is LOAD-BEARING: during pytest's OWN
 *  collection the module is imported under its test-module name (not "__main__"),
 *  so the footer is inert then; it fires ONLY under the outer `python <path>`
 *  call. Without the guard, pytest re-imports the file and the footer recurses
 *  ("error during collection"), collapsing pass and fail to the same exit code.
 *  `-p no:cacheprovider` keeps pytest from writing a `.pytest_cache` into the
 *  repo tree. Verbatim — the classifier depends on this exact shape. */
const PYTEST_FOOTER = [
  "",
  "",
  'if __name__ == "__main__":',
  "    import os",
  '    os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")',
  "    import sys, pytest",
  "    # Self-drive pytest on THIS file so `python <path>` yields a pass/fail",
  "    # exit code (the execution-grounded verdict). Disable third-party plugin",
  "    # autoload so host/user pytest entrypoints cannot perturb the oracle. The",
  "    # __main__ guard keeps this inert during pytest's own collection (see",
  "    # PYTEST_FOOTER docs).",
  '    sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider"]))',
] as const

/** Build the user message. The model emits a self-contained PYTEST test (P1):
 *  real `def test_*` functions whose `assert`s encode the EXPECTED (correct)
 *  behaviour, so they FAIL on the buggy base tree (pytest exit≠0 ⇒ "reproduced")
 *  and PASS on a correct fix (exit 0 ⇒ "resolved"). The self-driving footer is
 *  appended so the driver's `python <path>` invocation drives pytest. NO sentinel
 *  prints — the verdict is pytest's exit code.
 *
 *  When `mwe` is a non-empty extracted Minimal Working Example, a grounding block
 *  is spliced in (see {@link groundingBlock}) so the model wraps the
 *  KNOWN-reproducing code in a test with assertions rather than guessing. When
 *  `mwe` is undefined/empty the output is byte-identical to the un-grounded prompt.
 *
 *  `kind` (jun-23 canonical/hardening split) selects the contract:
 *    - `"canonical"` (default): the PLAIN "assert the CORE symptom" contract. The
 *      minimal correct fix MUST be able to make the assertion PASS. NO adversarial
 *      over-strictness. This is the submit-gate oracle prompt.
 *    - `"hardening"`: the {@link hardeningBlock} is spliced in so a shallow
 *      happy-path fix leaves at least one assertion failing (#10999 under-fix
 *      class). ADVISORY only. */
export const buildReproTestPrompt = (
  issue: string,
  mwe?: string,
  kind: ReproTestKind = "canonical",
): string =>
  [
    "Write a self-contained pytest test that reproduces the bug described in the issue below.",
    "",
    "The test must:",
    "1. Import the project's library code and exercise the buggy behavior described in the issue.",
    "2. Define one or more `def test_*()` functions that ASSERT the EXPECTED (correct)",
    "   behavior stated in the issue (what it SHOULD do). On the current buggy code the",
    "   assertion FAILS; once the bug is fixed it PASSES. Use plain `assert`, and",
    "   `pytest.raises(...)` when the correct behavior is to raise.",
    ...(kind === "canonical"
      ? [
          "   Assert the issue's CORE symptom only — the single behavior the issue is",
          "   actually about. Do NOT demand secondary / incidental cases; a minimal",
          "   correct fix of the reported bug must be enough to make the test PASS.",
        ]
      : []),
    "3. Do NOT print a verdict. There are NO sentinel strings. The VERDICT is pytest's",
    "   exit code: a failing assertion means the bug is present; an all-passing run",
    "   means it is fixed. Let pytest decide — do not catch the assertion or call",
    "   sys.exit() yourself inside the test body.",
    "",
    "Reliability (pytest's exit code is the automated gate — it MUST be trustworthy):",
    "  - Put the bug-exercising code INSIDE the `def test_*` function, not at module",
    "    top level, so a triggered error is reported as a test failure/error by pytest",
    "    rather than crashing the import.",
    "  - Keep the test focused: a real assertion failure is the signal we want, not an",
    "    unrelated import or setup error.",
    "  - END THE FILE with EXACTLY this footer (so `python <file>` runs pytest on itself):",
    '        if __name__ == "__main__":',
    "            import os",
    '            os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")',
    "            import sys, pytest",
    '            sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider"]))',
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
    "",
    "def test_handles_bad_input():",
    '    result = thing.do_something("bad input")',
    "    assert result == expected_safe  # FAILS on the buggy code, PASSES once fixed",
    "",
    "",
    'if __name__ == "__main__":',
    "    import os",
    '    os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")',
    "    import sys, pytest",
    '    sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider"]))',
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

/** True when the source already self-drives pytest — i.e. it has BOTH the
 *  `__main__` guard and a `pytest.main(` call. We require both so we never
 *  double-append when the model complied, and never mistake a stray
 *  `pytest.main` inside a helper for a real footer. */
const hasPytestFooter = (src: string): boolean =>
  /if\s+__name__\s*==\s*["']__main__["']/.test(src) && /pytest\.main\s*\(/.test(src)

/**
 * Ensure the P1 `python <path>`→pytest bridge is present (see PYTEST_FOOTER).
 *
 * The prompt INSTRUCTS the model to end with the self-driving footer, but the
 * bridge is load-bearing — without it `python <path>` would just import the test
 * module and exit 0 (every repro would be a false "resolved"/"unknown"). So we
 * GUARANTEE it structurally: if the model omitted the footer we append it; if it
 * complied we leave the source byte-identical. Empty source ⇒ unchanged (the
 * executor classifies "" as "unknown" without ever running it).
 *
 * Exported for direct unit testing. Pure. */
export const ensurePytestFooter = (src: string): string => {
  if (typeof src !== "string" || src.trim() === "") return typeof src === "string" ? src : ""
  if (hasPytestFooter(src)) return src
  // Trim a single trailing newline so we don't accumulate blank lines, then
  // splice the footer (which begins with two blank lines for PEP-8 spacing).
  return `${src.replace(/\n+$/, "")}\n${PYTEST_FOOTER.join("\n")}`
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
 * Run the LLM `K` times to synthesise K pytest repro-test candidates.
 * Returns the source strings (markdown-fence stripped, with the self-driving
 * pytest footer guaranteed via {@link ensurePytestFooter}). On any per-call
 * exception, a `""` source is recorded for that index; the caller's
 * `executeReproTests` will classify a `""` source as `"unknown"` (it is never
 * executed).
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
    // Strip fences, then GUARANTEE the self-driving pytest footer so the
    // driver's `python <path>` invocation actually runs pytest (P1 bridge).
    return ensurePytestFooter(stripMarkdownFences(await collectTextFromStream(iter)))
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
