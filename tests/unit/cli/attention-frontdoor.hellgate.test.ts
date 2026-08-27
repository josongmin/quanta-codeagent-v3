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

/**
 * 5. SSOT PROJECTOR — the front-door receipt above hands `ctx.attention` to the
 *    command DIRECTLY, which is exactly why the live REPL path could be broken
 *    while this file stayed green: `dispatchReplSlash` and `buildLiveSlashContext`
 *    both funnel through `projectSlashCtx`, and that projector enumerated its
 *    keys by hand and never listed `attention`. Measured before the fix: the
 *    builder assigned the slot, the projector dropped it, so `/attention`
 *    printed "not wired in this surface" for list/next/answer in every session
 *    — while the bound `focus-next-attention` chord worked, because it reads
 *    `slashCtx.attention` without going through the projector.
 *
 *    The sibling slot landed in the same commit (`skillActions`) carries the
 *    projector line and a comment naming this trap. This pins the pair.
 */
describe("A4-5 the SSOT projector carries the /attention wire", () => {
  test("a present attention slot survives projectSlashCtx", async () => {
    const { projectSlashCtx } = await import("@/apps/cli/repl/slash-surface")
    const sentinel = { list: () => [], next: () => undefined, answer: () => undefined }
    const projected = projectSlashCtx({ attention: sentinel } as never)
    expect(Object.hasOwn(projected, "attention")).toBe(true)
    expect(projected.attention).toBe(sentinel)
  })

  test("PAIRED CONTROL — an absent attention slot stays omitted (OFF byte-identity)", async () => {
    const { projectSlashCtx } = await import("@/apps/cli/repl/slash-surface")
    expect(Object.hasOwn(projectSlashCtx({} as never), "attention")).toBe(false)
    expect(Object.hasOwn(projectSlashCtx(undefined), "attention")).toBe(false)
  })

  test("the projector carries the sibling slot the same commit wired, so the pair cannot drift", async () => {
    const { projectSlashCtx } = await import("@/apps/cli/repl/slash-surface")
    const both = projectSlashCtx({ attention: {}, skillActions: {} } as never)
    expect([Object.hasOwn(both, "attention"), Object.hasOwn(both, "skillActions")]).toEqual([
      true,
      true,
    ])
  })
})

/**
 * 6. EXHAUSTIVE PROJECTION — the class fix, not just the `attention` instance.
 *
 * `projectLegacySlots` / `projectAdr0291Slots` enumerated their keys BY HAND,
 * so a slot could be declared on `ReplSlashCtx`, assigned by the builder, and
 * silently dropped by the projector — with nothing failing. That is how
 * `/attention` shipped "not wired" in every session.
 *
 * This pins the invariant behaviourally: every key a caller can put on the ctx
 * survives the projection. The production construction is
 * `Record<keyof ReplSlashCtx, SlotProjector>`, which additionally makes an
 * omission a COMPILE error naming the missing key — but a compile guard cannot
 * catch a projector wired to the WRONG key, and this can.
 *
 * `cwd` is the one deliberate exclusion: `dispatchReplSlash` reads it directly
 * (`slashCtx?.cwd ?? process.cwd()`) and passes it as its own argument, so it is
 * not part of the contract-shape projection.
 */
describe("A4-6 every declared ctx slot survives projectSlashCtx", () => {
  const NOT_PROJECTED = new Set(["cwd"])

  test("a fully-populated ctx loses no slot", async () => {
    const { projectSlashCtx } = await import("@/apps/cli/repl/slash-surface")
    // `side` is a FACTORY on the ctx and a VALUE in the contract shape, so it is
    // the one slot whose projected value legitimately differs from its input.
    const sentinel = (k: string) => ({ __slot: k })
    const keys = [
      "skills",
      "reloadSkills",
      "idle",
      "repoRules",
      "imageQueue",
      "rewindSession",
      "mcp",
      "cost",
      "planSnapshot",
      "history",
      "branchSearch",
      "side",
      "debug",
      "why",
      "inspect",
      "replay",
      "effort",
      "brief",
      "contextUsage",
      "agents",
      "attention",
      "skillActions",
      "activityStore",
      "itemStreamSink",
      "radar",
      "radarPruneOlderThanMs",
      "planEdit",
      "composerEdit",
      "forkSession",
      "perToolCheckpoint",
      "profile",
      "identity",
      "stickyModel",
      "focusChain",
      "textInbox",
      "hunkUndo",
      "activityItems",
      "projectsKb",
      "mcpResources",
      "browserNet",
      "automation",
    ] as const
    const ctx: Record<string, unknown> = {}
    for (const k of keys) ctx[k] = k === "side" ? () => sentinel(k) : sentinel(k)
    const projected = projectSlashCtx(ctx as never)
    const dropped = keys.filter((k) => !Object.hasOwn(projected, k))
    expect(dropped).toEqual([])
  })

  test("ANTI-VACUITY — the key list is the real one, so the test cannot pass by listing nothing", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    // ANCHORED ON THIS FILE, never on the ambient cwd: a repo path built from
    // `process.cwd()` resolves to nothing when the suite runs from a foreign
    // working directory, and an empty read is indistinguishable from a clean
    // one — which would make this anti-vacuity arm itself vacuous.
    const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
    const src = readFileSync(join(REPO_ROOT, "src/apps/cli/repl/slash-surface.ts"), "utf8")
    const block = src.slice(
      src.indexOf("export type ReplSlashCtx = Partial<{"),
      src.indexOf("export interface BuildReplSlashCtxArgs"),
    )
    const declared = [...block.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(30)
    const { projectSlashCtx } = await import("@/apps/cli/repl/slash-surface")
    const ctx: Record<string, unknown> = {}
    for (const k of declared) {
      if (k === undefined || NOT_PROJECTED.has(k)) continue
      ctx[k] = k === "side" ? () => ({ v: k }) : { v: k }
    }
    const projected = projectSlashCtx(ctx as never)
    const missing = declared.filter(
      (k) => k !== undefined && !NOT_PROJECTED.has(k) && !Object.hasOwn(projected, k),
    )
    expect(missing).toEqual([])
  })
})
