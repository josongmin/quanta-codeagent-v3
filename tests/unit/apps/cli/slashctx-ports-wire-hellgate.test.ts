/**
 * S3 SlashContext 6-port wire-up — hellgate.
 *
 * Pins the surface contract for the 6 ports the REPL surface threads onto
 * `SlashContext` (cost / planSnapshot / workingState / history / branchSearch
 * / side). For each port we verify TWO invariants:
 *
 *   1. PRESENT — when the surface BUILDS the adapter, the slash command
 *      receives the populated ctx field and renders its real body
 *      (panel / snapshot / state / etc.).
 *
 *   2. ABSENT — when the surface OMITS the field (gate refused / env off
 *      / dep missing), the slash command STILL prints its existing
 *      "not wired in this surface" message and exits 0 (byte-identical
 *      default-OFF parity with `/skills` / `/snooze`).
 *
 * A throwing closure must NOT crash the surface — `/cost`, `/plan`,
 * `/branches` defend against errors (exit 1 + clear err message; the
 * REPL stays alive).
 *
 * Slice discipline: imports `runSlashCommand` + `SlashContext` from
 * `apps/cli/slash-commands` and the port-typed shapes from their owner
 * modules. No `@/agent`/`@/llm`/`@/runner` runtime is mounted — every
 * test injects pure fakes.
 */

import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import type { SideConversationPort, SideConversationStartArgs } from "@/runner"
import {
  type BranchProgressState,
  createBranchProgressTracker,
} from "../../../../src/apps/cli/branch-search-progress"
import { createCostPanel } from "../../../../src/apps/cli/cost-panel"
import type { HistorySessionState } from "../../../../src/apps/cli/history-cmd"
import type { SideCmdSlashState } from "../../../../src/apps/cli/side-cmd"
import { runSlashCommand, type SlashContext } from "../../../../src/apps/cli/slash-commands"

interface CapturedCtx {
  out: string
  err: string
}

const makeBase = (cap: CapturedCtx): SlashContext => ({
  out: (s) => {
    cap.out += s
  },
  err: (s) => {
    cap.err += s
  },
  cwd: "/tmp",
})

// ─── /cost ──────────────────────────────────────────────────────────────

describe("/cost: cost-panel port wire", () => {
  test("ABSENT cost ⇒ prints 'not wired' + exit 0 (default-OFF parity)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/cost", makeBase(cap))
    expect(code).toBe(0)
    expect(cap.out).toContain("not wired")
    expect(cap.err).toBe("")
  })

  test("PRESENT cost ⇒ renders detailed panel body (Duration/Turns/Total cost)", async () => {
    const panel = createCostPanel({ model: "claude-3-5-sonnet-20241022", enabled: true })
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 })
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), cost: () => panel.renderDetailed() }
    const code = await runSlashCommand("/cost", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Turns:")
    expect(cap.out).toContain("Input:")
    expect(cap.out).toContain("Output:")
  })

  test("PRESENT but closure returns empty string ⇒ panel-disabled message + exit 0", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), cost: () => "" }
    const code = await runSlashCommand("/cost", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("panel disabled")
  })

  test("/cost takes no args ⇒ extra arg fails 1 with clear message", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), cost: () => "anything" }
    const code = await runSlashCommand("/cost extra", ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("takes no arguments")
  })
})

// ─── /plan ──────────────────────────────────────────────────────────────

describe("/plan: planSnapshot port wire", () => {
  test("ABSENT planSnapshot ⇒ 'plan-store not wired' + exit 0", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/plan", makeBase(cap))
    expect(code).toBe(0)
    expect(cap.out).toContain("plan-store not wired")
  })

  test("PRESENT planSnapshot returning null ⇒ renders '(no active plan)' panel", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), planSnapshot: () => null }
    const code = await runSlashCommand("/plan", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("no active plan")
  })

  test("PRESENT planSnapshot returning a real Plan ⇒ renders header with name", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = {
      ...makeBase(cap),
      planSnapshot: () => ({
        id: "p1",
        name: "Refactor X",
        overview: "step plan",
        version: 0,
        createdAt: 0,
        updatedAt: 0,
        isProject: false,
        phases: [],
        todos: {},
      }),
    }
    const code = await runSlashCommand("/plan", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Refactor X")
  })

  test("PRESENT planSnapshot throwing ⇒ exit 1 with clear err message (no crash)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = {
      ...makeBase(cap),
      planSnapshot: () => {
        throw new Error("boom")
      },
    }
    const code = await runSlashCommand("/plan", ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("snapshot failed")
    expect(cap.err).toContain("boom")
  })

  test("/plan unknown subcommand ⇒ exit 1", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), planSnapshot: () => null }
    const code = await runSlashCommand("/plan bogus", ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("unknown subcommand")
  })
})

// ─── /state ─────────────────────────────────────────────────────────────

describe("/state: workingState port wire", () => {
  test("ABSENT workingState ⇒ '/state: not wired' + exit 0", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/state", makeBase(cap))
    expect(code).toBe(0)
    expect(cap.out).toContain("not wired")
  })

  test("PRESENT returning undefined ⇒ renders 'working state is empty' panel", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), workingState: () => undefined }
    const code = await runSlashCommand("/state", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Working state")
  })

  test("PRESENT returning a non-empty WorkingState ⇒ renders posture + blockers", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = {
      ...makeBase(cap),
      workingState: () => ({
        ownerShortlist: [],
        blockers: [{ surface: "type" as const, what: "Missing import" }],
        nextStepQueue: [],
        deferredValidation: [],
      }),
    }
    const code = await runSlashCommand("/state", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Missing import")
  })

  test("/state takes no args ⇒ extra arg fails 1", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), workingState: () => undefined }
    const code = await runSlashCommand("/state nope", ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("takes no arguments")
  })
})

// ─── /history ───────────────────────────────────────────────────────────

describe("/history: history port wire", () => {
  test("ABSENT history ⇒ '/history: not wired' + exit 0", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/history", makeBase(cap))
    expect(code).toBe(0)
    expect(cap.out).toContain("not wired")
  })

  test("PRESENT with empty messages ⇒ '(no turns yet)' + exit 0", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const history: HistorySessionState = { messages: () => [] }
    const ctx: SlashContext = { ...makeBase(cap), history }
    const code = await runSlashCommand("/history", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("no turns yet")
  })

  test("PRESENT with a user turn ⇒ renders 'Recent turns' panel", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "first prompt" }] },
    ]
    const history: HistorySessionState = { messages: () => messages }
    const ctx: SlashContext = { ...makeBase(cap), history }
    const code = await runSlashCommand("/history", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Recent turns")
    expect(cap.out).toContain("first prompt")
  })

  test("PRESENT 'turn N' where N not found ⇒ exit 1", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const history: HistorySessionState = { messages: () => [] }
    const ctx: SlashContext = { ...makeBase(cap), history }
    const code = await runSlashCommand("/history turn 99", ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("not found")
  })

  test("PRESENT 'tools' ⇒ renders '(no tool calls yet)' on empty session", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const history: HistorySessionState = { messages: () => [] }
    const ctx: SlashContext = { ...makeBase(cap), history }
    const code = await runSlashCommand("/history tools", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("no tool calls yet")
  })
})

// ─── /branches ──────────────────────────────────────────────────────────

describe("/branches: branchSearch port wire", () => {
  test("ABSENT branchSearch ⇒ '/branches: not wired' + exit 0", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/branches", makeBase(cap))
    expect(code).toBe(0)
    expect(cap.out).toContain("not wired")
  })

  test("PRESENT empty tracker ⇒ '(no branch search recorded yet)' + exit 0", async () => {
    const tracker = createBranchProgressTracker()
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), branchSearch: () => tracker.snapshot() }
    const code = await runSlashCommand("/branches", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("no branch search recorded yet")
  })

  test("PRESENT with state ⇒ renders 'Branch search · N candidates' header", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    // Build a state with at least one candidate by ingesting an event.
    const tracker = createBranchProgressTracker()
    tracker.ingest({ kind: "candidate-started", id: "cand-1", seed: {} })
    const ctx: SlashContext = { ...makeBase(cap), branchSearch: () => tracker.snapshot() }
    const code = await runSlashCommand("/branches", ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Branch search")
    expect(cap.out).toContain("cand-1")
  })

  test("PRESENT closure throwing ⇒ propagates (caller's responsibility)", async () => {
    // Defensive contract: a throwing snapshot closure surfaces upward; the
    // REPL surface wraps the whole dispatch in try/catch so a crash here
    // becomes a turn-error transient. Verify the throw is NOT swallowed by
    // the slash command itself (no silent no-op).
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = {
      ...makeBase(cap),
      branchSearch: (): BranchProgressState => {
        throw new Error("tracker crash")
      },
    }
    let threw = false
    try {
      await runSlashCommand("/branches", ctx)
    } catch (e) {
      threw = e instanceof Error && e.message === "tracker crash"
    }
    expect(threw).toBe(true)
  })

  test("/branches takes no args ⇒ extra arg fails 1", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const tracker = createBranchProgressTracker()
    const ctx: SlashContext = { ...makeBase(cap), branchSearch: () => tracker.snapshot() }
    const code = await runSlashCommand("/branches nope", ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("takes no arguments")
  })
})

// ─── /side ──────────────────────────────────────────────────────────────

describe("/side: side-chat port wire", () => {
  test("ABSENT side ⇒ '/side: not wired' + exit 0 (after question parsed)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/side what is X?", makeBase(cap))
    expect(code).toBe(0)
    expect(cap.out).toContain("not wired")
  })

  test("/side with no question ⇒ exit 1 even when port absent (shape error first)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/side", makeBase(cap))
    expect(code).toBe(1)
    expect(cap.err).toContain("expected a question")
  })

  test("/side --help works even when port absent (help is shape-only)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/side --help", makeBase(cap))
    expect(code).toBe(0)
    expect(cap.out).toContain("isolated agent loop")
  })

  test("PRESENT side state ENTERS real branch — port.start spy called with the question", async () => {
    // ADR-0304 — REGRESSION CLASS CAUGHT (kept from the pre-port era):
    // the prior test used a structurally-invalid fake state (`deps: {
    // signal: ... } as never`), swallowed every throw via `.catch(() =>
    // undefined)`, and only asserted the header line — which is painted
    // BEFORE the real branch runs, so a regression that short-circuited
    // dispatch entirely (e.g. changed `if (state === undefined)` to
    // `if (true)`) would still print the header and pass.
    //
    // After ADR-0304 the slash command no longer touches `runSideChat`
    // directly — it calls `state.port.start(...)`. We spy on the port to
    // (a) prove dispatch actually crossed the gate, (b) verify the
    // question + transcript snapshot were forwarded, (c) short-circuit
    // before the runner so we don't need heavy deps.
    let startCalls = 0
    let startArgs: SideConversationStartArgs | undefined
    const SENTINEL = "ADR-0304-PORT-START-REACHED"
    const fakePort: SideConversationPort = {
      start: async (req): Promise<never> => {
        startCalls++
        startArgs = req
        throw new Error(SENTINEL)
      },
    }
    const out: string[] = []
    const err: string[] = []
    const liveTranscript: Message[] = [
      { role: "user", content: [{ type: "text", text: "main-u" }] },
    ]
    const ctx: SlashContext = {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      cwd: "/tmp",
      side: {
        port: fakePort,
        getHistory: () => liveTranscript,
        signal: new AbortController().signal,
      } satisfies SideCmdSlashState,
    }
    const code = await runSlashCommand("/side hello world", ctx)
    // The thrown SENTINEL is caught by /side's catch arm and rendered to err
    // (exit 1). Proves: dispatch entered the real branch AND the surface
    // error path correctly handles a port.start() throw.
    expect(code).toBe(1)
    expect(err.join("")).toContain(SENTINEL)
    // Header painted before the throw (positive control).
    expect(out.join("")).toContain("- /side - hello world")
    // CRITICAL — proves real branch was engaged. start() called EXACTLY
    // ONCE with the prompt as the `question` and the live transcript as
    // `messages`.
    expect(startCalls).toBe(1)
    expect(startArgs?.question).toBe("hello world")
    expect(startArgs?.messages.length).toBe(1)
    expect((startArgs?.messages[0]?.content[0] as { text?: string })?.text).toBe("main-u")
    // No `inherit` / `tools` / `maxTurns` requested ⇒ port receives them
    // as `undefined` (no per-call override) so the adapter falls back to
    // its closed-over defaults.
    expect(startArgs?.inherit).toBeUndefined()
    expect(startArgs?.tools).toBeUndefined()
  })

  test("/side --inherit=invalid ⇒ exit 1 even when port present (parse before dispatch)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    let startCalls = 0
    const fakeState: SideCmdSlashState = {
      port: {
        start: async () => {
          startCalls++
          throw new Error("should not reach")
        },
      },
      getHistory: () => [],
      signal: new AbortController().signal,
    }
    const ctx: SlashContext = { ...makeBase(cap), side: fakeState }
    const code = await runSlashCommand("/side --inherit=nonsense q", ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("invalid --inherit")
    // Parse-error short-circuit: port is NEVER consulted.
    expect(startCalls).toBe(0)
  })
})

// ─── Cross-port invariants ──────────────────────────────────────────────

describe("All 6 ports: ABSENT-field invariant (the byte-identical default-OFF axis)", () => {
  // Each row: command, expected "not wired" / parity sentinel substring.
  const cases: ReadonlyArray<{ cmd: string; sentinel: string }> = [
    { cmd: "/cost", sentinel: "not wired" },
    { cmd: "/plan", sentinel: "plan-store not wired" },
    { cmd: "/state", sentinel: "not wired" },
    { cmd: "/history", sentinel: "not wired" },
    { cmd: "/branches", sentinel: "not wired" },
    { cmd: "/side hello", sentinel: "not wired" },
  ]
  for (const c of cases) {
    test(`${c.cmd} with no ctx field ⇒ '${c.sentinel}'`, async () => {
      const cap: CapturedCtx = { out: "", err: "" }
      const code = await runSlashCommand(c.cmd, makeBase(cap))
      expect(code).toBe(0)
      expect(cap.out).toContain(c.sentinel)
    })
  }
})

describe("All 6 ports: PRESENT-field smoke ⇒ NOT the not-wired message", () => {
  test("/cost present ⇒ does NOT print 'not wired'", async () => {
    const panel = createCostPanel({ model: "x", enabled: true })
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), cost: () => panel.renderDetailed() }
    await runSlashCommand("/cost", ctx)
    expect(cap.out).not.toContain("not wired")
  })
  test("/plan present ⇒ does NOT print 'plan-store not wired'", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), planSnapshot: () => null }
    await runSlashCommand("/plan", ctx)
    expect(cap.out).not.toContain("plan-store not wired")
  })
  test("/state present ⇒ does NOT print '/state: not wired'", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), workingState: () => undefined }
    await runSlashCommand("/state", ctx)
    expect(cap.out).not.toContain("/state: not wired")
  })
  test("/history present ⇒ does NOT print 'not wired'", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const ctx: SlashContext = { ...makeBase(cap), history: { messages: () => [] } }
    await runSlashCommand("/history", ctx)
    expect(cap.out).not.toContain("not wired")
  })
  test("/branches present ⇒ does NOT print '/branches: not wired'", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const tracker = createBranchProgressTracker()
    const ctx: SlashContext = {
      ...makeBase(cap),
      branchSearch: () => tracker.snapshot(),
    }
    await runSlashCommand("/branches", ctx)
    expect(cap.out).not.toContain("/branches: not wired")
  })
})
