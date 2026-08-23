/**
 * RFC-01 A4 — `/attention` front-door hellgate (REAL navigation receipt).
 *
 * This is the A4 product receipt, NOT a leaf-unit stub. It drives the REAL
 * production rail end to end:
 *   - a REAL `TaskRegistry` with two children (A awaiting, B clean),
 *   - the REAL A3 producer (`bindBrokerUserInputPort` + `questionOwnerFor`) that
 *     `request_user_input` uses, emitting A's question through the REAL broker,
 *   - A2's REAL `buildSessionAuthorities` join (`AttentionReader`),
 *   - the REAL CLI `/attention` command over the REAL `buildAttentionSlashState`
 *     wire the surface uses.
 *
 * North-star receipt (RFC-01 §Product closure): child emits a real question →
 * `/attention` selects THAT exact opaque request → `/attention answer` reaches
 * the waiting request → the child resumes (the producer Promise settles with the
 * answer) → the pending marker clears.
 *
 * Load-bearing properties pinned here:
 *  1. REGISTRATION GATE (OFF byte-identical) — `/attention` is registered ONLY
 *     under `QUANTA_ATTENTION_NAV`. Red-on-injection: drop the
 *     `isAttentionNavEnabled()` guard and the OFF command table gains `/attention`.
 *  2. ONLY awaiting agents appear, ONLY the `task` owner arm (a `root` question
 *     is session-level, never a fleet row) — anti-vacuum.
 *  3. Navigation is REAL select+drill (the awaiting agent's inspect view), not a
 *     printed id.
 *  4. Answer routes by opaque requestId IN-PROCESS via `broker.answer`, the child
 *     resumes with the exact text, and the pending row disappears. A foreign id
 *     is rejected, never delivered to the waiting child.
 */

import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { bindBrokerUserInputPort, questionOwnerFor } from "@/agent/user-question"
import { ACTION_SET } from "@/apps/cli/keybindings/types"
import { type ReadLineTestIO, readLine } from "@/apps/cli/raw-line-reader"
import { toAgentFleetRow } from "@/apps/cli/repl/slash-surface"
import { attentionCmd, buildAttentionSlashState } from "@/apps/cli/slash/attention-cmd"
import { buildSurfaceSlashCommands } from "@/apps/cli/slash/registry-surface"
import type { SlashCommand, SlashContext } from "@/apps/cli/slash-contract"
import { buildSessionAuthorities } from "@/runner/assemble/session-authorities"
import { TaskRegistry } from "@/subagent"

const withEnv = <T>(key: string, val: string | undefined, fn: () => T): T => {
  const prev = process.env[key]
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

const names = (): string[] =>
  buildSurfaceSlashCommands((): readonly SlashCommand[] => []).map((c) => c.name)

describe("RFC-01 A4 — /attention registration gate (OFF byte-identical)", () => {
  test("QUANTA_ATTENTION_NAV unset ⇒ /attention is NOT registered", () => {
    withEnv("QUANTA_ATTENTION_NAV", undefined, () => {
      expect(names()).not.toContain("/attention")
    })
  })
  test("QUANTA_ATTENTION_NAV=1 ⇒ /attention IS registered (red-on-injection anchor)", () => {
    withEnv("QUANTA_ATTENTION_NAV", "1", () => {
      expect(names()).toContain("/attention")
    })
  })
})

/** Build a real authority graph (gate ON) with a deterministic clock/id so the
 *  opaque requestId is stable and askedAt ordering is pinned. */
const buildRig = () => {
  const tasks = new TaskRegistry()
  tasks.register({ id: "A", description: "db-migrator" })
  tasks.register({ id: "B", description: "log-cleaner" })
  let idN = 0
  const authorities = buildSessionAuthorities({
    tasks,
    env: { QUANTA_ATTENTION_NAV: "1" },
    questionDeps: { now: () => 1_000, mintId: () => `q_fixed_${idN++}` },
  })
  const broker = authorities.questions
  const attention = authorities.attention
  if (broker === undefined || attention === undefined) {
    throw new Error("gate ON must construct broker + attention")
  }
  const state = buildAttentionSlashState(attention, broker)
  return { tasks, broker, attention, state }
}

const capture = (state: ReturnType<typeof buildRig>["state"], tasks: TaskRegistry) => {
  const box = { out: "", err: "" }
  const ctx: Partial<SlashContext> & Pick<SlashContext, "out" | "err"> = {
    out: (s) => {
      box.out += s
    },
    err: (s) => {
      box.err += s
    },
    now: () => 5_000,
    attention: state,
    agents: () => tasks.list().map(toAgentFleetRow),
  }
  return { box, ctx: ctx as SlashContext }
}

describe("RFC-01 A4 — /attention real front-door receipt", () => {
  test("child question → list → next(drill) → answer → resume → clears", async () => {
    const { tasks, broker, state } = buildRig()

    // REAL A3 producer: child A raises `request_user_input`, bound to task A.
    const askA = bindBrokerUserInputPort(broker, questionOwnerFor("A"))
    const childAResumed = askA({ promptId: "p_a", prompt: "Which database should I target?" })

    // Anti-vacuum: a ROOT question (owner = root) must NEVER become a fleet row.
    const askRoot = bindBrokerUserInputPort(broker, questionOwnerFor(undefined))
    const rootResumed = askRoot({ promptId: "p_root", prompt: "root-level question" })

    // (1) list — ONLY A appears (B is clean; root question is excluded).
    const rid = state.list()[0]?.requestId
    expect(state.list()).toHaveLength(1)
    expect(rid).toBe("q_fixed_0")
    {
      const { box, ctx } = capture(state, tasks)
      const code = await attentionCmd.run(["list"], ctx)
      expect(code).toBe(0)
      expect(box.out).toContain("A") // the awaiting task id
      expect(box.out).toContain("q_fixed_0") // the opaque requestId
      expect(box.out).not.toContain("q_fixed_1") // the root question id is NOT a row
    }

    // (2) next — REAL select+drill: the awaiting agent's inspect view.
    {
      const { box, ctx } = capture(state, tasks)
      const code = await attentionCmd.run(["next"], ctx)
      expect(code).toBe(0)
      expect(box.out).toContain("next needing attention")
      expect(box.out).toContain("q_fixed_0")
      // Drill = renderAgentInspect of A (the fleet detail), not just the id line.
      expect(box.out).toContain("db-migrator")
    }

    // (3) answer by opaque requestId → child A resumes with the exact text.
    {
      const { box, ctx } = capture(state, tasks)
      const code = await attentionCmd.run(["answer", rid as string, "use", "postgres"], ctx)
      expect(code).toBe(0)
      // Unified ✅ success receipt (CLI-render polish): "✅ Answered <id> — …".
      expect(box.out).toContain("Answered")
      expect(box.out).toContain(rid as string) // still echoes the FULL routing id
    }
    const outcomeA = await childAResumed
    expect(outcomeA).toEqual({ decision: "answer", text: "use postgres" })

    // (4) pending clears — the marker disappears from the live projection.
    expect(state.list()).toHaveLength(0)

    // Cleanup the still-parked root waiter.
    broker.cancelAll("teardown")
    await rootResumed
  })

  test("foreign/unknown requestId is rejected, never delivered", async () => {
    const { tasks, broker, state } = buildRig()
    const askA = bindBrokerUserInputPort(broker, questionOwnerFor("A"))
    const childAResumed = askA({ promptId: "p_a2", prompt: "still waiting" })

    const { box, ctx } = capture(state, tasks)
    const code = await attentionCmd.run(["answer", "q_not_a_real_id", "hi"], ctx)
    expect(code).toBe(1)
    expect(box.err).toContain("no pending question")
    // The waiting child is untouched — still exactly one pending row.
    expect(state.list()).toHaveLength(1)

    broker.cancelAll("teardown")
    await childAResumed
  })

  test("all caught up when nothing awaits", async () => {
    const { tasks, state } = buildRig()
    const { box, ctx } = capture(state, tasks)
    const code = await attentionCmd.run(["next"], ctx)
    expect(code).toBe(0)
    expect(box.out).toContain("all caught up")
  })
})

// ── focus-next-attention KEY_ACTION (operator-bindable, NO default chord) ─────
class FakeStdin extends EventEmitter {
  readonly isTTY = false
  resume(): void {}
  pause(): void {}
  key(str: string | undefined, key: Record<string, unknown> = {}): void {
    this.emit("keypress", str, key)
  }
}
class FakeStdout {
  chunks: string[] = []
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
}
const makeIO = (): { io: ReadLineTestIO; stdin: FakeStdin } => {
  const stdin = new FakeStdin()
  return {
    io: {
      stdin: stdin as unknown as ReadLineTestIO["stdin"],
      stdout: new FakeStdout(),
      skipKeypressSetup: true,
    },
    stdin,
  }
}

describe("RFC-01 A4 — focus-next-attention KEY_ACTION", () => {
  test("is a valid bindable action in the closed enum", () => {
    expect(ACTION_SET.has("focus-next-attention")).toBe(true)
  })

  test("a chord bound to focus-next-attention fires the hook once, no submit, buffer unchanged", async () => {
    const { io, stdin } = makeIO()
    const keybindings = new Map([["alt+a", "focus-next-attention" as const]])
    let fired = 0
    const p = readLine(
      {
        prompt: "› ",
        keybindings,
        onFocusNextAttention: () => {
          fired += 1
        },
      },
      io,
    )
    stdin.key("h", { name: "h", sequence: "h" })
    stdin.key("i", { name: "i", sequence: "i" })
    stdin.key(undefined, { name: "a", meta: true, sequence: "\x1ba" })
    stdin.key(undefined, { name: "a", meta: true, sequence: "\x1ba" })
    stdin.key(undefined, { name: "return" })
    // Buffer preserved; the chord never inserted a char nor submitted.
    expect(await p).toBe("hi")
    expect(fired).toBe(2)
  })

  test("ABSENT hook ⇒ a bound chord is an inert no-op (byte-identical)", async () => {
    const run = async (withHook: boolean): Promise<string> => {
      const { io, stdin } = makeIO()
      const keybindings = new Map([["alt+a", "focus-next-attention" as const]])
      const p = readLine(
        {
          prompt: "› ",
          keybindings,
          ...(withHook ? { onFocusNextAttention: () => {} } : {}),
        },
        io,
      )
      stdin.key(undefined, { name: "a", meta: true, sequence: "\x1ba" })
      stdin.key("q", { name: "q", sequence: "q" })
      stdin.key(undefined, { name: "return" })
      return p
    }
    expect(await run(false)).toBe("q")
    expect(await run(true)).toBe("q")
  })
})
