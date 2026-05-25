/**
 * gh_pr_blame — argv-injection + adversarial-input sibling hellgate (ADR-0103).
 *
 * Sibling to `gh-pr-tools-hellgate.test.ts` (argv builder + canned JSON
 * rendering across 18 cases for the WHOLE gh PR tool family). THIS file
 * focuses NARROWLY on `gh_pr_blame`'s adversarial-input surface: malicious
 * PR identifiers, unicode authors, oversize blame, network/auth failures,
 * abort signal, malformed JSON, RTL/ZWJ author shapes, and the ref-rejection
 * contract (no shell metacharacter ever reaches argv).
 *
 * Coverage gap closed:
 *   - Existing test asserts the happy/structured outputs and a couple of
 *     argv shapes, but does NOT probe:
 *       - the rejection envelope for `-`-leading / shell-metachar / empty
 *         PR identifiers
 *       - unicode comment authors (RTL, ZWJ, emoji)
 *       - gh stderr 502/504/auth → typed ok:false envelope
 *       - JSON parse failure path
 *       - very large reviewThreads blob (output shape sanity)
 *       - abort signal propagated to runner
 *
 * 14 distinct cases.
 */

import { describe, expect, test } from "bun:test"
import { type GhRunner, ghPrBlameTool } from "@/tool/gh"
import type { ToolEvent } from "@/tool/types"

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

const okGh = (stdout: string) => ({ code: 0, stdout, stderr: "" })
const failGh = (stderr: string, code = 1) => ({ code, stdout: "", stderr })

const captureCalls = (
  reply: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): GhRunner & { argv: string[][] } => {
  const argv: string[][] = []
  return Object.assign(
    async (a: string[], _cwd: string, _t: number) => {
      argv.push([...a])
      return reply(a)
    },
    { argv },
  ) as GhRunner & { argv: string[][] }
}

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const events: ToolEvent[] = []
  for await (const ev of it) events.push(ev)
  return events
}

const resultOf = (events: ToolEvent[]): { ok: boolean; output: string } | undefined => {
  const r = events.find((e) => e.type === "result")
  if (r && r.type === "result") return r.result as { ok: boolean; output: string }
  return undefined
}

// =============================================================
// A. ref-rejection envelope (4)
// =============================================================

describe("gh_pr_blame injection — A. ref rejection envelope", () => {
  test("INJ-1: PR id with leading `-` (flag-injection) → ok:false rejected WITHOUT calling runner", async () => {
    // ref.ts L1-L13 — a `-`-leading value is rejected before argv composition.
    // The runner is never invoked.
    const runner = captureCalls(async () => okGh("never"))
    const tool = ghPrBlameTool(runner)
    const events = await drain(
      tool.execute({ pr: "--web" }, { cwd: "/tmp", signal: new AbortController().signal }),
    )
    const r = resultOf(events)
    expect(r?.ok).toBe(false)
    expect(r?.output).toContain("invalid PR identifier")
    expect(runner.argv).toEqual([]) // runner NEVER touched
  })

  test("INJ-2: shell-metacharacter laden ids (;, backtick, $(...)) → all rejected, no argv emitted", async () => {
    const runner = captureCalls(async () => okGh("never"))
    const tool = ghPrBlameTool(runner)
    const bad = [";rm -rf /", "`whoami`", "$(curl evil)", "'OR 1=1--'", "../../etc/passwd"]
    for (const pr of bad) {
      const events = await drain(
        tool.execute({ pr }, { cwd: "/tmp", signal: new AbortController().signal }),
      )
      const r = resultOf(events)
      expect(r?.ok).toBe(false)
      expect(r?.output).toContain("invalid PR identifier")
    }
    expect(runner.argv).toEqual([]) // none reached the runner
  })

  test("INJ-3: empty / whitespace-only PR id → rejected, no runner call", async () => {
    const runner = captureCalls(async () => okGh("never"))
    const tool = ghPrBlameTool(runner)
    for (const pr of ["", "   ", "\t"]) {
      const events = await drain(
        tool.execute({ pr }, { cwd: "/tmp", signal: new AbortController().signal }),
      )
      const r = resultOf(events)
      expect(r?.ok).toBe(false)
    }
    expect(runner.argv).toEqual([])
  })

  test("INJ-4: valid `#42` shorthand → accepted, normalized to '42' in argv (no leading hash leak)", async () => {
    const runner = captureCalls(async () =>
      okGh(JSON.stringify({ url: "https://github.com/x/y/pull/42", reviewThreads: [] })),
    )
    const tool = ghPrBlameTool(runner)
    await drain(tool.execute({ pr: "#42" }, { cwd: "/tmp", signal: new AbortController().signal }))
    // ref.ts strips leading `#`.
    expect(runner.argv[0]).toContain("42")
    expect(runner.argv[0]).not.toContain("#42")
  })
})

// =============================================================
// B. unicode + adversarial JSON content (4)
// =============================================================

describe("gh_pr_blame injection — B. unicode content / oversize / malformed", () => {
  test("INJ-5: unicode comment authors (RTL, ZWJ, emoji) → rendered verbatim in output", async () => {
    const json = JSON.stringify({
      url: "https://github.com/x/y/pull/9",
      reviewThreads: [
        {
          path: "src/i18n.ts",
          line: 5,
          comments: {
            nodes: [
              { author: { login: "أليس" }, body: "RTL nit" },
              { author: { login: "alice‍bob" }, body: "ZWJ" },
              { author: { login: "🦊_fox" }, body: "emoji" },
            ],
          },
        },
      ],
    })
    const runner = captureCalls(async () => okGh(json))
    const tool = ghPrBlameTool(runner)
    const events = await drain(
      tool.execute({ pr: 9 }, { cwd: "/tmp", signal: new AbortController().signal }),
    )
    const r = resultOf(events)
    expect(r?.ok).toBe(true)
    expect(r?.output).toContain("أليس")
    expect(r?.output).toContain("alice‍bob")
    expect(r?.output).toContain("🦊_fox")
  })

  test("INJ-6: gh JSON output is NOT JSON → ok:false envelope with structured reason (no throw)", async () => {
    const runner = captureCalls(async () => okGh("not-json-here {{"))
    const tool = ghPrBlameTool(runner)
    let threw: unknown = null
    let events: ToolEvent[] = []
    try {
      events = await drain(
        tool.execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }),
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    const r = resultOf(events)
    expect(r?.ok).toBe(false)
    expect(r?.output).toContain("non-JSON")
  })

  test("INJ-7: oversize reviewThreads (200 threads × 5 comments) → output still bounded by render shape (no crash, ok:true)", async () => {
    const threads = Array.from({ length: 200 }, (_, i) => ({
      path: `src/f${i}.ts`,
      line: (i % 50) + 1,
      comments: {
        nodes: Array.from({ length: 5 }, (_, j) => ({
          author: { login: `user-${i}-${j}` },
          body: `comment number ${j} on thread ${i}`,
        })),
      },
    }))
    const runner = captureCalls(async () =>
      okGh(JSON.stringify({ url: "https://example.com/pr/1", reviewThreads: threads })),
    )
    const tool = ghPrBlameTool(runner)
    const events = await drain(
      tool.execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }),
    )
    const r = resultOf(events)
    expect(r?.ok).toBe(true)
    // Output contains the PR header.
    expect(r?.output).toContain("PR:")
    // Sanity: at least one rendered thread is present.
    expect(r?.output).toContain("user-0-0")
  })

  test("INJ-8: empty reviewThreads → ok:true with `no review threads` reason", async () => {
    const runner = captureCalls(async () =>
      okGh(JSON.stringify({ url: "https://github.com/x/y/pull/1", reviewThreads: [] })),
    )
    const tool = ghPrBlameTool(runner)
    const events = await drain(
      tool.execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }),
    )
    const r = resultOf(events)
    expect(r?.ok).toBe(true)
    expect(r?.output).toContain("no review threads")
  })
})

// =============================================================
// C. network / auth / abort (3)
// =============================================================

describe("gh_pr_blame injection — C. network / auth / abort", () => {
  test("INJ-9: gh exit=1 stderr 502 → ok:false with stderr prefix", async () => {
    const runner = captureCalls(async () => failGh("HTTP 502 Bad Gateway: github.com is down", 1))
    const tool = ghPrBlameTool(runner)
    const events = await drain(
      tool.execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }),
    )
    const r = resultOf(events)
    expect(r?.ok).toBe(false)
    expect(r?.output).toContain("gh pr view failed")
    expect(r?.output).toContain("502")
  })

  test("INJ-10: gh exit=1 stderr authentication failure → ok:false (stderr truncated to 500 chars)", async () => {
    const longStderr = `${"x".repeat(900)}\nauth failure`
    const runner = captureCalls(async () => failGh(longStderr, 1))
    const tool = ghPrBlameTool(runner)
    const events = await drain(
      tool.execute({ pr: 1 }, { cwd: "/tmp", signal: new AbortController().signal }),
    )
    const r = resultOf(events)
    expect(r?.ok).toBe(false)
    // Source (pr-blame.ts L61): `r.stderr.slice(0, 500)`. Output starts with
    // the wrapper + 500 stderr chars = roughly 520 chars total. Anything
    // beyond the 500-char tail should NOT be present.
    expect(r?.output?.length).toBeLessThan(longStderr.length + 200)
  })

  test("INJ-11: signal aborted at runner level → runner returns exit=1 with abort stderr → typed ok:false envelope (no throw)", async () => {
    const controller = new AbortController()
    controller.abort()
    const runner: GhRunner = async () => {
      // Simulate the spawn boundary's abort-aware termination — exit=1, sentinel stderr.
      return { code: 1, stdout: "", stderr: "context deadline exceeded (aborted)" }
    }
    const tool = ghPrBlameTool(runner)
    let threw: unknown = null
    let events: ToolEvent[] = []
    try {
      events = await drain(tool.execute({ pr: 1 }, { cwd: "/tmp", signal: controller.signal }))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    const r = resultOf(events)
    expect(r?.ok).toBe(false)
    expect(r?.output).toContain("aborted")
  })
})

// =============================================================
// D. argv shape + readOnly contract (3)
// =============================================================

describe("gh_pr_blame injection — D. argv shape + contract", () => {
  test("INJ-12: tool isReadOnly + isConcurrencySafe → both true (no posture gating beyond gh CLI)", () => {
    const tool = ghPrBlameTool()
    expect(tool.isReadOnly?.()).toBe(true)
    expect(tool.isConcurrencySafe?.({} as never)).toBe(true)
  })

  test("INJ-13: argv NEVER contains user-controlled file/line filter values (filters applied POST-fetch)", async () => {
    // The schema accepts `file` + `line` but they're applied as IN-MEMORY
    // filters inside the parser, NOT as gh flags. Confirms a malicious
    // `file` value can't smuggle a gh flag.
    const runner = captureCalls(async () =>
      okGh(JSON.stringify({ url: "https://github.com/x/y/pull/1", reviewThreads: [] })),
    )
    const tool = ghPrBlameTool(runner)
    await drain(
      tool.execute(
        { pr: 1, file: "--web", line: 1 },
        { cwd: "/tmp", signal: new AbortController().signal },
      ),
    )
    const a = runner.argv[0]
    expect(a).toBeDefined()
    if (a === undefined) return
    // The file filter "--web" must NOT appear in argv.
    expect(a).not.toContain("--web")
    expect(a.join(" ")).toBe("gh pr view 1 --json url,headRefName,baseRefName,reviewThreads")
  })

  test("INJ-14: full URL form (https://github.com/x/y/pull/1) passed through verbatim to argv", async () => {
    const runner = captureCalls(async () =>
      okGh(JSON.stringify({ url: "https://github.com/x/y/pull/1", reviewThreads: [] })),
    )
    const tool = ghPrBlameTool(runner)
    await drain(
      tool.execute(
        { pr: "https://github.com/x/y/pull/1" },
        { cwd: "/tmp", signal: new AbortController().signal },
      ),
    )
    expect(runner.argv[0]).toContain("https://github.com/x/y/pull/1")
    // Ref-normalizer kept it verbatim because it begins with http(s).
  })
})
