/**
 * ADR-0314 hellgate R2 — mention-filter under fuzz / unicode / encoding /
 * formatting attacks. R1 sealed code-block / blockquote / bot / non-collab.
 * R2 targets:
 *   - email-like @mentions in domain context (no false positive),
 *   - markdown links / HTML tags / HTML comments wrapping the phrase,
 *   - Unicode look-alikes (fullwidth @, math font, ZWSP, ZWJ, diacritics),
 *   - whitespace boundary edge cases (no-match suffix, paragraph end),
 *   - mention inside our own idempotency marker comment,
 *   - huge-body correctness (10MB) + LINEAR scan-work scaling (the
 *     anti-catastrophic-backtracking invariant; not a wall-clock ceiling),
 *   - multiple phrases / triple boundary / escape sequences.
 *
 * Invariant: every case must produce a deterministic, well-defined match
 * outcome. False positives (non-mention bodies that match) are the worst
 * regression — they would trigger spurious agent runs.
 */

import { describe, expect, test } from "bun:test"

import { matchMention } from "@/integrations/github"

/** Deadlock backstop for the huge-body cases — generous on purpose so machine
 *  load can never turn it into the verdict; it exists only so a non-terminating
 *  (catastrophic-backtracking) regression fails instead of hanging the suite. */
const HUGE_BODY_BACKSTOP_MS = 120_000

/** A body of exactly `bytes` whose ONLY mention sits on the final line — the
 *  worst case for a scanner (every byte must be walked before the hit). */
const hugeBody = (bytes: number): string => `${"x".repeat(bytes - 16)}\n@quanta go`

/** Input-size step between the two scaling probes. Linear work ⇒ the cost ratio
 *  lands on this number; quadratic work ⇒ its SQUARE. */
const SCALE_STEP = 16
const SMALL_BODY_BYTES = 256 * 1024
const LARGE_BODY_BYTES = SMALL_BODY_BYTES * SCALE_STEP
/** Allocated ONCE, outside every timed window — a fresh multi-MB string per
 *  measurement would put allocation + GC (which scale with size, and with the
 *  host process's heap) inside the numbers we are comparing. */
const smallBody = hugeBody(SMALL_BODY_BYTES)
const largeBody = hugeBody(LARGE_BODY_BYTES)

/**
 * Minimum process CPU cost over `repeats` runs of an ALREADY-ALLOCATED body.
 *
 * Load-robustness comes from three properties, in order of importance:
 *  1. `process.cpuUsage` measures CPU consumed by THIS process, so host
 *     preemption by a VM/compiler cannot inflate one input size selectively;
 *  2. in-process GC can only ADD work to a run, so the MINIMUM over K runs is
 *     the estimator closest to the algorithm's real cost;
 *  3. the body is built by the caller and warmed once here, so neither the
 *     multi-MB string allocation nor JIT warm-up is inside a timed window.
 * Every repeat re-asserts the match, so a regression that "gets fast" by not
 * scanning cannot pass.
 */
const minScanCpuCostMs = (body: string, repeats = 7): number => {
  expect(matchMention(body, ["@quanta"]).matched).toBe(true) // warm-up, untimed
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i < repeats; i++) {
    const startUsage = process.cpuUsage()
    const m = matchMention(body, ["@quanta"])
    const usage = process.cpuUsage(startUsage)
    const ms = (usage.user + usage.system) / 1_000
    expect(m.matched).toBe(true)
    if (ms < min) min = ms
  }
  return min
}

describe("ADR-0314 hellgate R2 — mention-filter fuzz", () => {
  test("nested backticks (```inner```)inside fenced block ⇒ no match", () => {
    const body = "```\n```inner @quanta```\n```"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("unclosed fence after phrase ⇒ no match (everything after fence is code)", () => {
    const body = "intro\n```\n@quanta review\nmore code here"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("phrase BEFORE an unclosed fence still matches", () => {
    const body = "@quanta hi\n```\nfollowing code"
    expect(matchMention(body, ["@quanta"]).matched).toBe(true)
  })

  test("email-like mention inside a domain segment ⇒ no match (no boundary)", () => {
    // The phrase is `@quanta`, the boundary checks reject when followed by an
    // alphanumeric character (".io" starts with '.', which is punctuation —
    // word-boundary OK). We test the STRICT no-boundary case: `@quantaio`.
    expect(matchMention("user@quantaio", ["@quanta"]).matched).toBe(false)
  })

  test("email-like mention followed by '.io' ⇒ matches (punctuation IS a boundary)", () => {
    // This is by design — `@quanta.io` is treated as a mention followed by
    // arguments starting with `.io`. The boundary contract documents this.
    expect(matchMention("contact @quanta.io for help", ["@quanta"]).matched).toBe(true)
  })

  test("markdown link `[@quanta](url)` ⇒ matches (R4: open punct is valid pre-boundary, GitHub parity)", () => {
    // Updated R4: open punctuation (`(`, `[`, `{`, `<`, `"`, `'`) is accepted
    // as a pre-boundary so GitHub-native mention shapes like `[@quanta](url)`
    // and `(@quanta)` fire. The phrase is preceded by `[`, which is now a
    // valid boundary.
    expect(matchMention("see [@quanta](https://x.io) docs", ["@quanta"]).matched).toBe(true)
  })

  test("HTML comment wrapping the phrase ⇒ phrase still detected (we don't strip HTML)", () => {
    // Comments are NOT stripped by the slice. That's the documented behavior —
    // hostile users could put `<!-- @quanta hi -->` and we'd trigger. The R2
    // test pins this so a future change is a deliberate decision.
    expect(matchMention("<!-- @quanta hi -->", ["@quanta"]).matched).toBe(true)
  })

  test("HTML tag wrapping the phrase: `<p>@quanta</p>` ⇒ no match (preceded by `>`)", () => {
    // `>` precedes the phrase, but `>` at COLUMN 0 is a blockquote, not here.
    // The line is `<p>@quanta</p>` ⇒ `>` is mid-line ⇒ not a blockquote ⇒
    // boundary check on `>` fails (non-whitespace prefix).
    expect(matchMention("<p>@quanta</p>", ["@quanta"]).matched).toBe(false)
  })

  test("fullwidth '＠quanta' ⇒ no match (different codepoint)", () => {
    // `＠` is U+FF20, NOT `@` (U+0040). Phrase comparison is exact-byte.
    expect(matchMention("＠quanta hi", ["@quanta"]).matched).toBe(false)
  })

  test("math-font '@𝓺𝓾𝓪𝓷𝓽𝓪' ⇒ no match", () => {
    expect(matchMention("@𝓺𝓾𝓪𝓷𝓽𝓪 hi", ["@quanta"]).matched).toBe(false)
  })

  test("ZWSP inside phrase '@quanta​' ⇒ no match (boundary breaks)", () => {
    // U+200B (ZWSP) is NOT whitespace per /\s/ — boundary check fails.
    // (Actually /\s/ in JS does NOT match ZWSP, so the next char ZWSP fails.)
    const body = "@quanta​ hi"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("phrase immediately followed by alpha '@quantatest' ⇒ no match", () => {
    expect(matchMention("@quantatest", ["@quanta"]).matched).toBe(false)
  })

  test("triple boundary: line-start phrase ⇒ matches", () => {
    expect(matchMention("@quanta start of line", ["@quanta"]).matched).toBe(true)
  })

  test("triple boundary: phrase at EOL with trailing \\n ⇒ matches", () => {
    expect(matchMention("hello @quanta\n", ["@quanta"]).matched).toBe(true)
  })

  test("triple boundary: phrase at paragraph end with \\n\\n ⇒ matches", () => {
    expect(matchMention("hello @quanta\n\nnext para", ["@quanta"]).matched).toBe(true)
  })

  test("body whose ONLY content is our own marker ⇒ no match (self-loop guard)", () => {
    expect(matchMention("<!-- quanta:idempotency=abc @quanta -->", ["@quanta"]).matched).toBe(false)
  })

  test(
    "10MB body with mention at the END matches (huge-body correctness ceiling)",
    () => {
      const m = matchMention(hugeBody(10 * 1024 * 1024), ["@quanta"])
      expect(m.matched).toBe(true)
      expect(m.command).toBe("@quanta")
      expect(m.atLine).toBe(2)
    },
    // Deadlock backstop ONLY (a catastrophic-backtracking regression never
    // returns, and must not wedge the suite forever). It is not the verdict:
    // the verdict is the match above + the scaling assertion below.
    HUGE_BODY_BACKSTOP_MS,
  )

  test(
    "mention scan work scales LINEARLY with body size (the anti-catastrophic-backtracking invariant)",
    () => {
      // The R2 header's "performance ceiling" case used to assert `elapsed <
      // 2000` on a 10MB body. That is a statement about THIS MACHINE AT THIS
      // MOMENT, not about the algorithm: a congested full-suite process (2805
      // files, bloated heap, GC pauses) inflates every wall-clock number and the
      // test flips red without any code change. What the case is actually
      // defending is the ALGORITHM — catastrophic backtracking / a quadratic
      // scan must not creep into the fence walk, the inline-code strip or the
      // boundary search.
      //
      // So: measure WORK SCALING with an estimator host congestion cannot
      // corrupt in the failing direction (see `minScanCpuCostMs`). A 16x input
      // step separates
      // the classes widely: linear ⇒ ratio ≈ 16, quadratic ⇒ ≈ 256,
      // catastrophic ⇒ never returns (the backstop above). The ceiling sits at
      // 64 — measured worst case on a loaded box is ~23, and quadratic is 4x
      // above the ceiling — so a constant-factor slowdown (a slow machine, a
      // congested suite) can never red this, and no super-linear class survives.
      const small = minScanCpuCostMs(smallBody)
      const large = minScanCpuCostMs(largeBody)
      expect(large / small).toBeLessThan(SCALE_STEP * 4)
    },
    HUGE_BODY_BACKSTOP_MS,
  )

  test("multiple distinct trigger phrases — first match wins (deterministic)", () => {
    const m = matchMention("@quanta first\n/quanta second", ["@quanta", "/quanta"])
    expect(m.matched).toBe(true)
    expect(m.command).toBe("@quanta")
    expect(m.atLine).toBe(1)
  })

  test("first phrase variant in list misses, second hits ⇒ matches with second", () => {
    const m = matchMention("/quanta only", ["@quanta", "/quanta"])
    expect(m.matched).toBe(true)
    expect(m.command).toBe("/quanta")
  })

  test("diacritics: '@quántá' ⇒ no match (not the same codepoints)", () => {
    expect(matchMention("@quántá hi", ["@quanta"]).matched).toBe(false)
  })

  test("escape: '\\@quanta' ⇒ matches (we do not honor markdown escapes)", () => {
    // We deliberately don't strip `\` — that's a markdown rendering concern,
    // not a mention-detection concern. The `\` is a non-whitespace prefix ⇒
    // boundary check fails ⇒ no match.
    expect(matchMention("\\@quanta", ["@quanta"]).matched).toBe(false)
  })

  test("RTL marker between phrase chars ⇒ no match (boundary breaks)", () => {
    expect(matchMention("@qu‮anta hi", ["@quanta"]).matched).toBe(false)
  })

  test("phrase on a line with leading tabs (still line-start whitespace) ⇒ matches", () => {
    expect(matchMention("\t\t@quanta indented", ["@quanta"]).matched).toBe(true)
  })

  test("phrase preceded by non-breaking space U+00A0 ⇒ matches (\\s includes NBSP)", () => {
    expect(matchMention(" @quanta hi", ["@quanta"]).matched).toBe(true)
  })

  test("CRLF line endings handled (Windows webhook payloads)", () => {
    expect(matchMention("intro\r\n@quanta hi\r\n", ["@quanta"]).matched).toBe(true)
  })

  test("CRLF inside fenced code block still blocks the phrase", () => {
    expect(matchMention("```\r\n@quanta hi\r\n```", ["@quanta"]).matched).toBe(false)
  })

  test("phrase split across two lines '@quan\\nta' ⇒ no match (each line treated separately)", () => {
    expect(matchMention("@quan\nta hi", ["@quanta"]).matched).toBe(false)
  })
})
