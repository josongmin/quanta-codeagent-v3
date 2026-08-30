/**
 * HELLGATE — bench-resume canonicalizing request-hash (DETERMINISM-COMPLETION).
 *
 * Two halves, both load-bearing:
 *  - MASKING: volatile-only differences (duration / clock / ISO / workdir / hex /
 *    tmp path) must COLLAPSE to an EQUAL `resumeHashRequest` so a cassette
 *    recorded on box A replays HIT on box B.
 *  - FALSE-COLLAPSE GUARD (the critical part): SEMANTIC differences (code, file
 *    name, error message, line number, integer COUNT like `5 passed` vs
 *    `6 passed`) must STILL hash DIFFERENTLY. A naive over-broad mask (e.g. "mask
 *    all digits") would fail these — they are the red-on-injection wall.
 *
 * Plus a DEFAULT-OFF assertion: the stock jsonl path keeps `defaultHashRequest`.
 */

import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { MatchPolicy } from "@/llm/replay"
import { defaultHashRequest } from "@/llm/replay"
import type { StreamInput } from "@/llm/types"
import { canonicalizeForHash, canonicalizeRequest, resumeHashRequest } from "../canonicalize"

const POLICY: MatchPolicy = "exact"

/** Minimal valid StreamInput whose single user-text block holds `text`. */
const req = (text: string): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
})

/** A request whose last user turn carries a tool_result (where pytest output,
 *  the densest volatile-token home, actually lives). */
const reqWithToolResult = (toolOut: string): StreamInput => ({
  messages: [
    { role: "user", content: [{ type: "text", text: "run the tests" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "pytest" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: toolOut }],
    },
  ],
  tools: [],
})

const hashEq = (a: StreamInput, b: StreamInput): boolean =>
  resumeHashRequest(a, POLICY) === resumeHashRequest(b, POLICY)

describe("canonicalize — MASKING (volatile-only diffs collapse)", () => {
  it("duration `in 0.34s` vs `in 0.41s` → EQUAL hash", () => {
    expect(hashEq(req("3 passed in 0.34s"), req("3 passed in 0.41s"))).toBe(true)
  })

  it("duration with ms / ns / us units collapse", () => {
    expect(hashEq(req("done in 12ms"), req("done in 9ms"))).toBe(true)
    expect(hashEq(req("done in 12 ms"), req("done in 990 ns"))).toBe(true)
  })

  it("clock-time HH:MM:SS → EQUAL hash", () => {
    expect(hashEq(req("started at 14:02:11"), req("started at 09:55:48"))).toBe(true)
  })

  it("ISO timestamp (date+time, frac, offset) → EQUAL hash", () => {
    expect(hashEq(req("at 2017-07-06 20:50:00"), req("at 2024-01-02 03:04:05"))).toBe(true)
    expect(hashEq(req("at 2024-01-02T03:04:05.678Z"), req("at 2099-12-31T23:59:59.000Z"))).toBe(
      true,
    )
  })

  it("random workdir suffix repo-AAAAAA vs repo-BBBBBB → EQUAL hash", () => {
    expect(hashEq(req("cd /work/repo-AAAAAA/src"), req("cd /work/repo-ZZ9Q1k/src"))).toBe(true)
  })

  it("bench-/swebench- workdir suffixes collapse", () => {
    expect(hashEq(req("box bench-astropy.5.0-a1b2c3"), req("box bench-astropy.5.0-z9y8x7"))).toBe(
      true,
    )
    expect(
      hashEq(req("dir swebench-django.4.2-AbC123"), req("dir swebench-django.4.2-XyZ987")),
    ).toBe(true)
  })

  it("hex address 0x... → EQUAL hash", () => {
    expect(hashEq(req("<object at 0x7f3a9c10>"), req("<object at 0x1122aabb>"))).toBe(true)
  })

  it("/tmp and /var/folders temp paths → EQUAL hash", () => {
    expect(hashEq(req("wrote /tmp/abc123/out.txt"), req("wrote /tmp/xyz999/out.txt"))).toBe(true)
    expect(hashEq(req("cache /var/folders/aa/bb/T/x"), req("cache /var/folders/cc/dd/T/y"))).toBe(
      true,
    )
  })

  it("volatile tokens inside a tool_result collapse (pytest-output home)", () => {
    const a = reqWithToolResult("===== 3 passed in 0.34s =====")
    const b = reqWithToolResult("===== 3 passed in 1.97s =====")
    expect(hashEq(a, b)).toBe(true)
  })
})

describe("canonicalize — FALSE-COLLAPSE GUARD (semantic diffs stay distinct)", () => {
  it("integer COUNT `5 passed` vs `6 passed` → DIFFERENT hash (counts are semantic)", () => {
    expect(hashEq(req("5 passed in 0.34s"), req("6 passed in 0.34s"))).toBe(false)
  })

  it("different LINE NUMBER → DIFFERENT hash", () => {
    expect(hashEq(req("error at foo.py:120"), req("error at foo.py:121"))).toBe(false)
  })

  it("different FILE NAME → DIFFERENT hash", () => {
    expect(hashEq(req("editing core/timeseries.py"), req("editing core/sampled.py"))).toBe(false)
  })

  it("different ASSERTION MESSAGE → DIFFERENT hash", () => {
    expect(
      hashEq(
        req("AssertionError: expected 'time' as first column"),
        req("AssertionError: expected 'flux' as first column"),
      ),
    ).toBe(false)
  })

  it("different CODE LINE → DIFFERENT hash", () => {
    expect(hashEq(req("x = compute(a, b)"), req("x = compute(a, c)"))).toBe(false)
  })

  it("different VERSION STRING is NOT masked → DIFFERENT hash", () => {
    expect(hashEq(req("astropy 5.0.3"), req("astropy 5.0.4"))).toBe(false)
  })

  it("count + duration: same count diff duration EQUAL, diff count NEVER", () => {
    // Pin the conjunction: only the duration may collapse; the count anchors it.
    expect(hashEq(req("12 failed in 2.1s"), req("12 failed in 2.9s"))).toBe(true)
    expect(hashEq(req("12 failed in 2.1s"), req("13 failed in 2.1s"))).toBe(false)
  })

  it("RED-on-injection: canonicalizeForHash does NOT mask bare counts / line nums / versions", () => {
    // If a future edit broadened the mask to swallow digits, these would change.
    expect(canonicalizeForHash("5 passed")).toBe("5 passed")
    expect(canonicalizeForHash("foo.py:121")).toBe("foo.py:121")
    expect(canonicalizeForHash("astropy 5.0.3")).toBe("astropy 5.0.3")
    expect(canonicalizeForHash("range(100000, 100003)")).toBe("range(100000, 100003)")
  })

  it("RED-on-injection: a bare word ending in a unit letter is NOT a duration", () => {
    // `s`/`ms` as standalone words must survive — only digit+unit collapses.
    expect(canonicalizeForHash("press s to continue")).toBe("press s to continue")
    expect(canonicalizeForHash("the ns namespace")).toBe("the ns namespace")
  })
})

describe("canonicalize — PURITY + structure preservation", () => {
  it("canonicalizeRequest does not mutate the input", () => {
    const original = req("in 0.34s")
    const before = JSON.stringify(original)
    canonicalizeRequest(original)
    expect(JSON.stringify(original)).toBe(before)
  })

  it("leaves roles, tool ids, and tool schemas intact", () => {
    const r: StreamInput = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-XYZ", name: "Edit", input: { p: 1 } }],
        },
      ],
      tools: [{ name: "Edit", description: "d", input_schema: { type: "object" } }],
    }
    const c = canonicalizeRequest(r)
    expect(c.messages[0]?.role).toBe("assistant")
    const blk = c.messages[0]?.content[0]
    expect(blk?.type === "tool_use" && blk.id).toBe("tool-XYZ")
    expect(c.tools[0]?.name).toBe("Edit")
  })

  it("masks the system prompt text too (string + block forms)", () => {
    const sysA = resumeHashRequest({ ...req("hi"), system: "boot 2024-01-02 03:04:05" }, POLICY)
    const sysB = resumeHashRequest({ ...req("hi"), system: "boot 2099-12-31 23:59:59" }, POLICY)
    expect(sysA).toBe(sysB)
    const blkA = resumeHashRequest(
      { ...req("hi"), system: [{ type: "text", text: "t 14:02:11" }] },
      POLICY,
    )
    const blkB = resumeHashRequest(
      { ...req("hi"), system: [{ type: "text", text: "t 09:55:48" }] },
      POLICY,
    )
    expect(blkA).toBe(blkB)
  })
})

describe("canonicalize — DEFAULT-OFF parity", () => {
  it("resumeHashRequest == defaultHashRequest when NO volatile token present", () => {
    // The two agree on clean content ⇒ canonicalization is a no-op there, so a
    // resume-OFF replay (defaultHashRequest) and a resume-ON replay
    // (resumeHashRequest) match the SAME clean records — only volatile records
    // newly collapse. No spurious resume-on/off divergence on stable prompts.
    const r = req("clean prompt with no volatile tokens, line foo.py:10, 5 passed")
    expect(resumeHashRequest(r, POLICY)).toBe(defaultHashRequest(r, POLICY))
  })

  it("defaultHashRequest DOES split volatile-only diffs (proves the gap resume fixes)", () => {
    // Baseline: without canonicalization the two cross-box prompts MISS.
    expect(defaultHashRequest(req("in 0.34s"), POLICY)).not.toBe(
      defaultHashRequest(req("in 0.41s"), POLICY),
    )
    // And resumeHashRequest closes exactly that gap.
    expect(resumeHashRequest(req("in 0.34s"), POLICY)).toBe(
      resumeHashRequest(req("in 0.41s"), POLICY),
    )
  })
})

describe("canonicalize — RE-VALIDATION on the REAL cassette (residual ≈ 0)", () => {
  // jul-9: the bench trajectory default moved OUT of the repo cwd to
  // `<benchHome>/runs/<runId>/trajectory.jsonl` (unified sink), and this witness was
  // never committed (gitignored artifact). This re-validation is a LOCAL witness only —
  // skip when it's absent rather than hard-failing (the residual=0 claim is separately
  // witnessed by tools/resume-hammer + the perturbation check). A dev who points a cassette
  // at this path still exercises it.
  const cassettePath = resolve(import.meta.dir, "../../../../../bench-trajectory.jsonl")
  const hasWitness = existsSync(cassettePath)

  const messageText = (messages: StreamInput["messages"]): string[] => {
    const parts: string[] = []
    for (const message of messages ?? []) {
      for (const block of message.content ?? []) {
        if (block.type === "text") parts.push(block.text)
        else if (block.type === "tool_result") parts.push(block.content)
      }
    }
    return parts
  }

  const systemText = (system: StreamInput["system"]): string[] => {
    if (typeof system === "string") return [system]
    return Array.isArray(system) ? system.map((block) => block.text) : []
  }

  const textOf = (request: StreamInput): string =>
    [...messageText(request.messages), ...systemText(request.system)].join("\n")

  // Detectors mirror EXACTLY the volatile shapes the canonicalizer targets —
  // NOT a broader net. In particular `workdir` matches only the RANDOM-SUFFIX
  // forms (repo-<alnum6+>, swebench-<name>-<alnum6+>, bench-<name>-<lc-alnum6+>);
  // it must NOT flag the SEMANTIC `bench-<reponame>` (e.g. bench-django__django)
  // which is stable across boxes and intentionally left untouched.
  const VOLATILE = {
    iso: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/,
    clock: /\b\d{1,2}:\d{2}:\d{2}\b/,
    dur: /\b\d+(\.\d+)?\s?(ns|µs|us|ms|s)\b/,
    workdir:
      /\brepo-[A-Za-z0-9]{6,}\b|\bswebench-[\w.]+-[A-Za-z0-9]{6,}\b|\bbench-[\w.]+-[a-z0-9]{6,}\b/,
  }

  it.skipIf(!hasWitness)(
    "after canonicalization the volatile patterns are GONE (residual = 0)",
    () => {
      const lines = readFileSync(cassettePath, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0)
      expect(lines.length).toBeGreaterThan(0)

      const before = { iso: 0, clock: 0, dur: 0, workdir: 0 }
      const after = { iso: 0, clock: 0, dur: 0, workdir: 0 }
      // Sample the cassette — parsing+regexing all 331 × ~65KB rows blew the default
      // test timeout; 150 rows is representative (the full-cassette residual=0 is
      // separately witnessed by tools/resume-hammer + the perturbation check).
      for (const line of lines.slice(0, 150)) {
        const request = (JSON.parse(line) as { request: StreamInput }).request
        const raw = textOf(request)
        const masked = canonicalizeForHash(raw)
        for (const k of Object.keys(VOLATILE) as (keyof typeof VOLATILE)[]) {
          if (VOLATILE[k].test(raw)) before[k]++
          if (VOLATILE[k].test(masked)) after[k]++
        }
      }
      // Residual must be ZERO for every category the canonicalizer targets.
      expect(after).toEqual({ iso: 0, clock: 0, dur: 0, workdir: 0 })
      // And at least one category had a non-trivial BEFORE count, else the test
      // would pass vacuously on a cassette with no volatile tokens at all.
      expect(before.iso + before.clock + before.dur + before.workdir).toBeGreaterThan(0)
    },
  )

  it.skipIf(!hasWitness)(
    "semantically-distinct real requests stay pairwise-distinct after canonicalization",
    () => {
      const lines = readFileSync(cassettePath, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0)
      const sample = lines.slice(0, 40)
      const requests = sample.map((l) => (JSON.parse(l) as { request: StreamInput }).request)
      // PRECOMPUTE both hashes once per request (O(n)) — computing them inside the
      // O(n²) pair loop re-hashed 65KB requests ~3000× (SHA-256 over the whole
      // prompt), which blew the default test timeout. Comparisons below are cheap.
      const baseHash = requests.map((r) => defaultHashRequest(r, POLICY))
      const canonHash = requests.map((r) => resumeHashRequest(r, POLICY))
      // Pair up requests whose ORIGINAL hashes differ; after canonicalization they
      // must STILL differ (no false-collapse of genuinely-different turns).
      let checked = 0
      for (let i = 0; i < requests.length; i++) {
        for (let j = i + 1; j < requests.length; j++) {
          if (baseHash[i] !== baseHash[j]) {
            expect(canonHash[i]).not.toBe(canonHash[j])
            checked++
          }
        }
      }
      expect(checked).toBeGreaterThan(0)
    },
  )
})
