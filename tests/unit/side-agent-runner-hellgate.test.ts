/**
 * Hellgate for the N1 Phase-2 bridge (`src/agent/side-agent-runner.ts`) — the
 * sole coupling of the pure `@/side-agent` slice to the real ADR-0130 runner +
 * ADR-0416 mailbox. Drives the adapters over fakes; pins the read-biased pass,
 * the finding→broadcast mapping, the bounded budget, and a full wired wake.
 */

import { describe, expect, test } from "bun:test"
import {
  mailboxToSideAgentMailbox,
  SIDE_AGENT_READONLY_TOOLS,
  subagentRunnerToSidePass,
  wireSideAgentDaemons,
} from "@/agent/side-agent-runner"
import type { MailboxPort } from "@/agent/subagent-mailbox"
import type { SubagentRequest, SubagentResult, SubagentRunner } from "@/subagent"

// ── fakes ─────────────────────────────────────────────────────────────────────

const mkMailbox = () => {
  const sends: { from: string; to: string; kind: string; body: string }[] = []
  const port = {
    send: (init: { from: string; to: string; kind: string; body: string }) => {
      sends.push({ from: init.from, to: init.to, kind: init.kind, body: init.body })
      return { id: "m", ...init } as never
    },
  } as unknown as MailboxPort
  return { port, sends }
}

const mkRunner = (
  fn: (req: SubagentRequest) => SubagentResult,
): { runner: SubagentRunner; reqs: SubagentRequest[] } => {
  const reqs: SubagentRequest[] = []
  // SubagentRunner is a bare callable `(req) => Promise<result>` — the fake must
  // BE that function, not an `{run}` object force-cast (the old `as unknown as`
  // hid a type mismatch that broke once the adapter invoked the runner directly).
  const runner: SubagentRunner = async (req: SubagentRequest): Promise<SubagentResult> => {
    reqs.push(req)
    return fn(req)
  }
  return { runner, reqs }
}

const okResult = (finalText: string, over: Partial<SubagentResult> = {}): SubagentResult => ({
  ok: true,
  finalText,
  turns: 1,
  ...over,
})

// ── mailbox adapter ─────────────────────────────────────────────────────────

describe("side-agent-runner — mailbox adapter (finding → broadcast)", () => {
  test("summary-only finding → broadcast with body = summary", () => {
    const mb = mkMailbox()
    const sidebox = mailboxToSideAgentMailbox(mb.port)
    sidebox.send({ from: "sa-1", to: "main", kind: "finding", summary: "build green" })
    expect(mb.sends).toEqual([{ from: "sa-1", to: "main", kind: "broadcast", body: "build green" }])
  })

  test("finding with detail → body encodes summary + detail", () => {
    const mb = mkMailbox()
    const sidebox = mailboxToSideAgentMailbox(mb.port)
    sidebox.send({
      from: "sa-1",
      to: "main",
      kind: "finding",
      summary: "2 failures",
      detail: "specA\nspecB",
    })
    expect(mb.sends[0]?.body).toBe("2 failures\n\nspecA\nspecB")
    expect(mb.sends[0]?.kind).toBe("broadcast")
  })
})

// ── runner adapter (read-biased, bounded, finalText→finding) ──────────────────

describe("side-agent-runner — runner adapter (one read-biased pass)", () => {
  test("ok + finalText → finding; read-biased toolFilter + maxTurns budget passed", async () => {
    const { runner, reqs } = mkRunner(() => okResult("found a flaky test"))
    const pass = subagentRunnerToSidePass(runner)
    const signal = new AbortController().signal
    const out = await pass.run({ task: "watch tests", wake: 1, maxTurns: 4, signal })
    expect(out).toEqual({ summary: "found a flaky test" })
    // The child ran read-biased + bounded.
    expect(reqs[0]?.toolFilter).toEqual([...SIDE_AGENT_READONLY_TOOLS])
    expect(reqs[0]?.budget).toEqual({ maxTurns: 4 })
    expect(reqs[0]?.prompt).toBe("watch tests")
    expect(reqs[0]?.depth).toBe(1)
    expect(reqs[0]?.signal).toBe(signal)
  })

  test("multi-line finalText → summary is the FIRST line, detail is the full text", async () => {
    const { runner } = mkRunner(() => okResult("HEADLINE\nmore context\nand more"))
    const pass = subagentRunnerToSidePass(runner)
    const out = await pass.run({
      task: "t",
      wake: 1,
      maxTurns: 1,
      signal: new AbortController().signal,
    })
    expect(out).toEqual({ summary: "HEADLINE", detail: "HEADLINE\nmore context\nand more" })
  })

  test("!ok OR empty finalText → null (the wake found nothing)", async () => {
    const failPass = subagentRunnerToSidePass(mkRunner(() => okResult("x", { ok: false })).runner)
    const emptyPass = subagentRunnerToSidePass(mkRunner(() => okResult("   ")).runner)
    const sig = new AbortController().signal
    expect(await failPass.run({ task: "t", wake: 1, maxTurns: 1, signal: sig })).toBeNull()
    expect(await emptyPass.run({ task: "t", wake: 1, maxTurns: 1, signal: sig })).toBeNull()
  })

  test("an explicit wider toolFilter overrides the read-biased default", async () => {
    const { runner, reqs } = mkRunner(() => okResult("ok"))
    const pass = subagentRunnerToSidePass(runner, { toolFilter: ["read", "write"] })
    await pass.run({ task: "t", wake: 1, maxTurns: 1, signal: new AbortController().signal })
    expect(reqs[0]?.toolFilter).toEqual(["read", "write"])
  })

  // DoS — a chatty child can return a multi-MB finalText. Unbounded `detail`
  // would balloon the registry findings ring-buffer (up to 1000 entries) AND
  // the mailbox broadcast body, mirroring the very explosion C2's per-field caps
  // guard against. The summary is line-1-capped; the detail MUST be capped too.
  test("huge multi-line finalText → detail is CAPPED (no unbounded payload)", async () => {
    const huge = `HEADLINE\n${"y".repeat(50_000)}`
    const pass = subagentRunnerToSidePass(mkRunner(() => okResult(huge)).runner)
    const out = await pass.run({
      task: "t",
      wake: 1,
      maxTurns: 1,
      signal: new AbortController().signal,
    })
    expect(out?.summary).toBe("HEADLINE")
    // detail present (multi-line) but bounded well below the raw 50k payload.
    expect(out?.detail).toBeDefined()
    expect(out?.detail?.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(8_000)
  })

  test("small multi-line finalText → detail still the FULL text (cap is a ceiling, not a chop)", async () => {
    const text = "HEADLINE\nline two\nline three"
    const pass = subagentRunnerToSidePass(mkRunner(() => okResult(text)).runner)
    const out = await pass.run({
      task: "t",
      wake: 1,
      maxTurns: 1,
      signal: new AbortController().signal,
    })
    expect(out).toEqual({ summary: "HEADLINE", detail: text })
  })

  // Surrogate-safety: a JS string is UTF-16, so a naive `slice` at the cap index
  // can cut an astral char (emoji / CJK-ext) in HALF, emitting a LONE surrogate
  // into the findings ring-buffer / mailbox body — which re-encodes to a U+FFFD
  // replacement char / malformed token. The cap MUST snap off a surrogate
  // boundary. We straddle the cut: lay down emoji ("💥" = a surrogate PAIR) so
  // one PAIR spans the `DETAIL_MAX - marker.length` index. Naive slice ⇒ lone
  // low surrogate at the tail ⇒ `isWellFormed() === false`.
  test("astral char straddling the cap → capped detail is well-formed (no split surrogate)", async () => {
    const DETAIL_MAX = 8_000
    const MARKER = "\n…[side-agent finding truncated]"
    // First line is a short HEADLINE so the result carries a detail (multi-line).
    // A body of dense emoji (each "💥" is a surrogate PAIR, 2 code units) packed
    // far past the cap GUARANTEES a pair straddles the `DETAIL_MAX - marker`
    // index — the odd-length HEADLINE prefix offsets the pair grid so the cut
    // never lands cleanly between two whole emoji. Naive slice ⇒ lone surrogate.
    const headline = "HEADLINE\n" // 9 code units (odd) → shifts the astral grid
    const fill = "💥".repeat(20_000) // far over cap, dense astral chars
    const huge = headline + fill
    const pass = subagentRunnerToSidePass(mkRunner(() => okResult(huge)).runner)
    const out = await pass.run({
      task: "t",
      wake: 1,
      maxTurns: 1,
      signal: new AbortController().signal,
    })
    const detail = out?.detail
    expect(detail).toBeDefined()
    // (1) well-formed — no lone surrogate emitted by the cut.
    expect(detail?.isWellFormed()).toBe(true)
    // (2) still ≤ the cap (the boundary snap may drop one extra unit, never add).
    expect((detail?.length ?? Number.POSITIVE_INFINITY) <= DETAIL_MAX).toBe(true)
    // (3) marker semantics preserved.
    expect(detail?.endsWith(MARKER)).toBe(true)
  })

  test("small detail containing astral chars is byte-identical (untouched under cap)", async () => {
    const text = "HEADLINE\n💥 boom 🎉 done"
    const pass = subagentRunnerToSidePass(mkRunner(() => okResult(text)).runner)
    const out = await pass.run({
      task: "t",
      wake: 1,
      maxTurns: 1,
      signal: new AbortController().signal,
    })
    expect(out).toEqual({ summary: "HEADLINE", detail: text })
    expect(out?.detail?.isWellFormed()).toBe(true)
  })
})

// ── full wire (registry over the real adapters) ───────────────────────────────

describe("side-agent-runner — wireSideAgentDaemons (end-to-end over fakes)", () => {
  test("a wired interval daemon: one wake runs the pass → finding pushed to the mailbox", async () => {
    const mb = mkMailbox()
    const { runner } = mkRunner(() => okResult("disk 92% full"))
    let timerHandler: (() => void) | undefined
    let cleared = false
    let t = 1000
    const reg = wireSideAgentDaemons({
      runner,
      mailbox: mb.port,
      mainRecipient: "main",
      setInterval: (h) => {
        timerHandler = h
        return 1
      },
      clearInterval: () => {
        cleared = true
      },
      now: () => t,
    })
    const id = reg.spawn({
      task: "watch disk",
      trigger: { kind: "interval", everyMs: 1000 },
      maxWakes: 1,
      maxTurnsPerWake: 2,
    })
    expect(typeof id).toBe("string")
    t += 5
    timerHandler?.() // tick → one bounded read-biased pass → finding
    await new Promise((r) => setTimeout(r, 0))
    // The finding reached the mailbox as a broadcast to main.
    expect(mb.sends).toEqual([{ from: id, to: "main", kind: "broadcast", body: "disk 92% full" }])
    // findings() also surfaces it; maxWakes=1 auto-stopped + cleared the timer.
    expect(reg.findings().map((f) => f.summary)).toEqual(["disk 92% full"])
    expect(reg.list()[0]?.status).toBe("stopped")
    expect(cleared).toBe(true)
  })
})
