/**
 * Bench driver wiring for `QUANTA_BENCH_ISSUE_HINT`.
 *
 * Invariants:
 *   - flag unset OR "off" ⇒ `buildConfig` user message is byte-identical to
 *     `${problemStatement}\n\nWork inside ${sandbox}. When done, stop.`
 *     (custom-corpus path; swebench adds SWEBENCH_DIRECTIVE on top)
 *   - flag "1" / "on" with a non-empty hint extraction ⇒ hint is PREPENDED
 *     above the problem statement block, separated by `\n\n`
 *   - flag "1" but extraction yields empty hint (e.g. empty problemStatement)
 *     ⇒ still byte-identical (no `\n\n` join, no header)
 *   - `benchOptIns().issueHint` strict accept-list (only "1"/"on")
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { StreamPort } from "@/stream"
import { benchOptIns, buildConfig } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

const ENV_KEYS = [
  "QUANTA_BENCH_ISSUE_HINT",
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_SUBAGENT",
  "QUANTA_BENCH_SKILLS",
  "QUANTA_LSP_TOOLS",
] as const

const snapshot = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}
const restore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = snapshot()
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  restore(saved)
})

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
const stubStream: StreamPort = { emit() {} }

const customInstance = (problemStatement: string): Instance => ({
  id: "test-issue-hint",
  repoPath: "/tmp/x",
  problemStatement,
  testCmd: "true",
})

const swebenchInstance = (problemStatement: string): Instance => ({
  id: "test-issue-hint-swe",
  repoPath: "/tmp/x",
  problemStatement,
  testCmd: "true",
  swebench: {
    instanceId: "x__1",
    repo: "x/x",
    baseCommit: "deadbeef",
  },
})

const baseDeps = { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 }

const getUserText = (cfg: ReturnType<typeof buildConfig>): string => {
  const msg = cfg.messages[0]
  if (!msg || msg.role !== "user") return ""
  const content = msg.content
  if (!Array.isArray(content)) return ""
  const first = content[0]
  if (!first || first.type !== "text") return ""
  return first.text
}

describe("benchOptIns — issueHint flag", () => {
  test("unset → issueHint:false", () => {
    expect(benchOptIns().issueHint).toBe(false)
  })

  test("'1' → issueHint:true", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "1"
    expect(benchOptIns().issueHint).toBe(true)
  })

  test("'on' → issueHint:true", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "on"
    expect(benchOptIns().issueHint).toBe(true)
  })

  test("'off' → issueHint:false (strict accept-list)", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "off"
    expect(benchOptIns().issueHint).toBe(false)
  })

  test("other values (true / yes / 0 / empty) → issueHint:false", () => {
    for (const v of ["true", "yes", "0", "", "TRUE"]) {
      process.env.QUANTA_BENCH_ISSUE_HINT = v
      expect(benchOptIns().issueHint).toBe(false)
    }
  })

  test("issueHint independent of other axes", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "1"
    const r = benchOptIns()
    expect(r.issueHint).toBe(true)
    expect(r.lspNav).toBe(false)
    expect(r.subagent).toBeUndefined()
    expect(r.skills).toBeUndefined()
  })
})

describe("buildConfig — issue-hint prepend wiring", () => {
  const RICH_ISSUE = [
    "Getting http://.example.com raises UnicodeError",
    "Attempting to get `http://.example.com` results in a `UnicodeError`.",
    "See requests/models.py for context.",
    "",
    "```python",
    "import requests",
    "requests.get('http://.example.com')",
    "```",
  ].join("\n")

  test("flag unset → user message is byte-identical to baseline (no hint header)", () => {
    const ac = new AbortController()
    const cfg = buildConfig(customInstance(RICH_ISSUE), baseDeps, "/tmp/sb", ac.signal, stubStream)
    const text = getUserText(cfg)
    expect(text.startsWith(RICH_ISSUE)).toBe(true)
    expect(text).not.toContain("Issue Hints (auto-extracted)")
    // Exact contract for custom-corpus default
    expect(text).toBe(`${RICH_ISSUE}\n\nWork inside /tmp/sb. When done, stop.`)
  })

  test("flag 'off' → byte-identical (same as unset)", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "off"
    const ac = new AbortController()
    const cfg = buildConfig(customInstance(RICH_ISSUE), baseDeps, "/tmp/sb", ac.signal, stubStream)
    expect(getUserText(cfg)).toBe(`${RICH_ISSUE}\n\nWork inside /tmp/sb. When done, stop.`)
  })

  test("flag '1' + non-empty extraction → hint prepended, format verified", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "1"
    const ac = new AbortController()
    const cfg = buildConfig(customInstance(RICH_ISSUE), baseDeps, "/tmp/sb", ac.signal, stubStream)
    const text = getUserText(cfg)
    // Header on first line
    expect(text.startsWith("## Issue Hints (auto-extracted)")).toBe(true)
    // Calibration line BEFORE the problem statement
    expect(text).toContain("Use these as starting points but verify with your own tools.")
    // Hint AND original problem still present
    expect(text).toContain(RICH_ISSUE)
    expect(text).toContain("requests/models.py")
    expect(text).toContain("UnicodeError")
    // Separator: hint block + "\n\n" + baseText
    expect(text).toContain("\n\nGetting http://.example.com raises UnicodeError")
  })

  test("flag '1' + empty problemStatement → no hint, byte-identical", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "1"
    const ac = new AbortController()
    const cfg = buildConfig(customInstance(""), baseDeps, "/tmp/sb", ac.signal, stubStream)
    const text = getUserText(cfg)
    expect(text).not.toContain("Issue Hints (auto-extracted)")
    expect(text).toBe("\n\nWork inside /tmp/sb. When done, stop.")
  })

  test("flag '1' + non-extracting problem (no signals) → byte-identical", () => {
    // A short prose blurb with no path / no backticks / no error names.
    const plain = "Please make the thing work better."
    process.env.QUANTA_BENCH_ISSUE_HINT = "1"
    const ac = new AbortController()
    const cfg = buildConfig(customInstance(plain), baseDeps, "/tmp/sb", ac.signal, stubStream)
    const text = getUserText(cfg)
    expect(text).not.toContain("Issue Hints (auto-extracted)")
    expect(text).toBe(`${plain}\n\nWork inside /tmp/sb. When done, stop.`)
  })

  test("flag '1' + swebench instance → hint prepended, SWEBENCH_DIRECTIVE preserved", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "1"
    const ac = new AbortController()
    const cfg = buildConfig(
      swebenchInstance(RICH_ISSUE),
      baseDeps,
      "/tmp/sb",
      ac.signal,
      stubStream,
    )
    const text = getUserText(cfg)
    // All three components present in order: hint → problem → directive
    const idxHint = text.indexOf("## Issue Hints (auto-extracted)")
    const idxProblem = text.indexOf("Getting http://.example.com")
    const idxDirective = text.indexOf("automated grader")
    expect(idxHint).toBeGreaterThanOrEqual(0)
    expect(idxProblem).toBeGreaterThan(idxHint)
    expect(idxDirective).toBeGreaterThan(idxProblem)
  })

  test("flag '1' + swebench instance + EMPTY extraction → byte-identical to legacy swebench path", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "1"
    const plain = "make it work"
    const ac = new AbortController()
    const cfg = buildConfig(swebenchInstance(plain), baseDeps, "/tmp/sb", ac.signal, stubStream)
    const text = getUserText(cfg)
    // No hint header. Starts with the problem statement.
    expect(text).not.toContain("Issue Hints (auto-extracted)")
    expect(text.startsWith(plain)).toBe(true)
    expect(text).toContain("automated grader")
  })
})
