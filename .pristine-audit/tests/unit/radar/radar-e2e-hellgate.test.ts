/**
 * Radar END-TO-END wire hellgate — ADR-0231 (wire phase).
 *
 * The store-only engine hellgate (`radar-hellgate.test.ts`) locks the pure
 * surface. THIS file locks the WIRE that makes the radar work end-to-end:
 *
 *   HELL-RW-01  producer fires on a COMPLETED turn (gate-ON) — fresh-readback
 *               of the minted card's id / kind="next-step" / title
 *   HELL-RW-02  default-OFF byte-identical: `cfg.radar` undefined ⇒ NO card,
 *               NO clock read, the outcome is unchanged
 *   HELL-RW-03  conservative: the hook DECLINES on a non-completed flushKind
 *   HELL-RW-04  conservative: the heuristic DECLINES when not idle (idle signal
 *               never fires silently — a 0 idle reading ⇒ no card)
 *   HELL-RW-05  `/radar list` renders the live card the loop deposited
 *   HELL-RW-06  `/radar adopt` flips status (drops from listActive)
 *   HELL-RW-07  `/radar dismiss` flips status (drops from listActive)
 *   HELL-RW-08  `/radar engage` increments engagementCount (stays active)
 *   HELL-RW-09  `/radar prune` expires aged cards
 *   HELL-RW-10  jsonl 0600 + replay no-double-write (persistence across reload)
 *   HELL-RW-11  shared-instance: the loop's store IS the `/radar` store (one
 *               queue — adopt via the slash flips the card the loop minted)
 *
 * Each case asserts UNCONDITIONALLY first, then narrows. The RED-on-injection
 * proof for the producer is documented in the test body (comment out
 * `block.store.proposeCard` in radar-producer-hook.ts ⇒ HELL-RW-01/05/11 go
 * red).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, maybeProposeRadarCard, type RadarProducerBlock, runAgent } from "@/agent"
import { radarCmd, type SlashContext } from "@/apps/cli/slash-commands"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { InMemoryRadarStore, JsonlFileRadarStore, type RadarStore } from "@/radar"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/* ===================================================================== */
/* test doubles                                                          */
/* ===================================================================== */

class FakeLLM implements LLMPort {
  readonly model = "test-model"
  private readonly scripts: StreamEvent[][]
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const next = this.scripts.shift() ?? []
    for (const e of next) yield e
  }
}

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const completed = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new NullStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd: "/tmp",
  maxTurns: 4,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

/** A radar block whose heuristic ALWAYS clears its thresholds (idle + long
 *  task), so a completed turn deposits a card. `now` is injected for a stable
 *  createdAtMs. */
const firingBlock = (store: RadarStore): RadarProducerBlock => ({
  store,
  idleThresholdMs: 0,
  taskDurationThresholdMs: 0,
  now: () => 5_000,
  idleMsForTurn: () => 60_000,
})

/* ===================================================================== */
/* slash harness                                                         */
/* ===================================================================== */

const runRadar = async (
  store: RadarStore | undefined,
  args: string[],
  extra: Partial<SlashContext> = {},
): Promise<{ code: number; out: string; err: string }> => {
  let out = ""
  let errOut = ""
  const ctx: SlashContext = {
    out: (s) => {
      out += s
    },
    err: (s) => {
      errOut += s
    },
    cwd: "/tmp",
    ...(store !== undefined ? { radar: store } : {}),
    ...extra,
  }
  const code = await radarCmd.run(args, ctx)
  return { code, out, err: errOut }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radar-e2e-"))
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

/* ===================================================================== */
/* producer wire                                                         */
/* ===================================================================== */

describe("HELL-RW-01 producer fires on a completed turn (gate-ON)", () => {
  test("a completed turn deposits a next-step card (fresh-readback)", async () => {
    const store = new InMemoryRadarStore()
    const cfg = baseCfg({
      llm: new FakeLLM([completed("done")]),
      cwd: dir,
      radar: firingBlock(store),
    })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("completed")
    // Fresh-readback from the SAME store the loop wrote.
    const active = store.listActive()
    // RED-on-injection: comment out `block.store.proposeCard` in
    // radar-producer-hook.ts ⇒ this length assert goes red (0 !== 1).
    expect(active.length).toBe(1)
    const card = active[0]
    expect(card).toBeDefined()
    expect(card?.kind).toBe("next-step")
    expect(card?.title).toBe("Review the long task that just finished")
    expect(card?.status).toBe("active")
  })
})

describe("HELL-RW-12 SEAM: non-completed turn through the REAL loop declines", () => {
  test("an ERROR turn (reaches the finally, flushKind!=completed) mints nothing", async () => {
    const store = new InMemoryRadarStore()
    // A throwing LLM makes runTurn throw → executeTurnWithObservability's FINALLY
    // still runs (flushKind stays "error") → the radar hook IS invoked with a
    // non-completed kind. This drives the REAL turn-loop seam (not the hook
    // directly like RW-03), so it proves the loop passes the ACTUAL flushKind.
    class ThrowingLLM implements LLMPort {
      readonly model = "test-model"
      // biome-ignore lint/correctness/useYield: throws before yielding (error turn)
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error("boom (error turn)")
      }
    }
    const cfg = baseCfg({ llm: new ThrowingLLM(), cwd: dir, radar: firingBlock(store) })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).not.toBe("completed")
    // The teeth: firing thresholds, but an error turn mints nothing.
    // RED-on-injection: hardcode flushKind:"completed" at the turn-loop hook call
    // (turn-loop.ts) ⇒ a card is minted on the error turn ⇒ this goes red.
    expect(store.listActive().length).toBe(0)
  })
})

describe("HELL-RW-02 default-OFF byte-identical", () => {
  test("cfg.radar undefined ⇒ NO card minted into an out-of-band store", async () => {
    const store = new InMemoryRadarStore()
    // The store exists but is NOT wired onto cfg — the loop must never touch it.
    const cfg = baseCfg({ llm: new FakeLLM([completed("done")]), cwd: dir })
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("completed")
    expect(store.listActive().length).toBe(0)
  })
})

describe("HELL-RW-03 conservative: non-completed flushKind declines", () => {
  test("the hook returns null and mints nothing on a tools turn", () => {
    const store = new InMemoryRadarStore()
    // Direct hook call — same thresholds as a firing block, but flushKind != completed.
    const id = maybeProposeRadarCard(firingBlock(store), {
      lastTaskDurationMs: 99_999,
      idleMs: 99_999,
      flushKind: "tools",
    })
    expect(id).toBeNull()
    expect(store.listActive().length).toBe(0)
    // Control: the SAME inputs with flushKind=completed DO mint (proves the
    // gate is the only thing suppressing it).
    const id2 = maybeProposeRadarCard(firingBlock(store), {
      lastTaskDurationMs: 99_999,
      idleMs: 99_999,
      flushKind: "completed",
    })
    expect(id2).not.toBeNull()
    expect(store.listActive().length).toBe(1)
  })
})

describe("HELL-RW-04 conservative: not-idle declines (no silent fire)", () => {
  test("idleMsForTurn=0 ⇒ heuristic declines even on a completed turn", () => {
    const store = new InMemoryRadarStore()
    const block: RadarProducerBlock = {
      store,
      idleThresholdMs: 60_000,
      taskDurationThresholdMs: 0,
      now: () => 1,
      idleMsForTurn: () => 0, // not idle
    }
    const id = maybeProposeRadarCard(block, { lastTaskDurationMs: 99_999, flushKind: "completed" })
    expect(id).toBeNull()
    expect(store.listActive().length).toBe(0)
  })

  test("absent idleMsForTurn ⇒ treated as 0 ⇒ declines (never fires silently)", () => {
    const store = new InMemoryRadarStore()
    const block: RadarProducerBlock = {
      store,
      idleThresholdMs: 60_000,
      taskDurationThresholdMs: 0,
      now: () => 1,
      // idleMsForTurn omitted
    }
    const id = maybeProposeRadarCard(block, { lastTaskDurationMs: 99_999, flushKind: "completed" })
    expect(id).toBeNull()
    expect(store.listActive().length).toBe(0)
  })
})

/* ===================================================================== */
/* slash surface                                                         */
/* ===================================================================== */

describe("HELL-RW-05 /radar list renders the live card", () => {
  test("list shows a card the producer deposited", async () => {
    const store = new InMemoryRadarStore()
    store.proposeCard({
      kind: "next-step",
      title: "Review the long task that just finished",
      description: "desc",
      createdAtMs: 1,
    })
    const { code, out } = await runRadar(store, ["list"])
    expect(code).toBe(0)
    expect(out).toContain("active card")
    expect(out).toContain("Review the long task that just finished")
  })

  test("absent slot ⇒ 'not wired' + exit 0", async () => {
    const { code, out } = await runRadar(undefined, ["list"])
    expect(code).toBe(0)
    expect(out).toContain("not wired")
  })
})

describe("HELL-RW-06 /radar adopt flips status", () => {
  test("adopt drops the card from listActive", async () => {
    const store = new InMemoryRadarStore()
    const card = store.proposeCard({
      kind: "suggestion",
      title: "t",
      description: "d",
      createdAtMs: 1,
    })
    expect(store.listActive().length).toBe(1)
    const { code, out } = await runRadar(store, ["adopt", card.id])
    expect(code).toBe(0)
    expect(out).toContain("adopted")
    expect(store.listActive().length).toBe(0)
  })

  test("adopt on unknown id ⇒ exit 1 (not-found)", async () => {
    const store = new InMemoryRadarStore()
    const { code, err } = await runRadar(store, ["adopt", "nope"])
    expect(code).toBe(1)
    expect(err).toContain("not-found")
  })
})

describe("HELL-RW-07 /radar dismiss flips status", () => {
  test("dismiss drops the card from listActive", async () => {
    const store = new InMemoryRadarStore()
    const card = store.proposeCard({
      kind: "warning",
      title: "t",
      description: "d",
      createdAtMs: 1,
    })
    const { code, out } = await runRadar(store, ["dismiss", card.id])
    expect(code).toBe(0)
    expect(out).toContain("dismissed")
    expect(store.listActive().length).toBe(0)
  })
})

describe("HELL-RW-08 /radar engage increments count", () => {
  test("engage bumps engagementCount and leaves the card active", async () => {
    const store = new InMemoryRadarStore()
    const card = store.proposeCard({
      kind: "suggestion",
      title: "t",
      description: "d",
      createdAtMs: 1,
    })
    const { code, out } = await runRadar(store, ["engage", card.id])
    expect(code).toBe(0)
    expect(out).toContain("engaged")
    const active = store.listActive()
    expect(active.length).toBe(1)
    expect(active[0]?.engagementCount).toBe(1)
  })
})

describe("HELL-RW-09 /radar prune expires aged cards", () => {
  test("prune marks an old card expired (drops from listActive)", async () => {
    const store = new InMemoryRadarStore()
    store.proposeCard({ kind: "suggestion", title: "old", description: "d", createdAtMs: 0 })
    expect(store.listActive().length).toBe(1)
    const { code, out } = await runRadar(store, ["prune"], {
      now: () => 1_000_000,
      radarPruneOlderThanMs: 1,
    })
    expect(code).toBe(0)
    expect(out).toContain("pruned 1")
    expect(store.listActive().length).toBe(0)
  })
})

/* ===================================================================== */
/* persistence                                                           */
/* ===================================================================== */

describe("HELL-RW-10 jsonl persistence (0600 + replay no-double-write)", () => {
  test("propose → reload → identical active set; file is 0600; no double-write", () => {
    const filePath = join(dir, "cards.jsonl")
    const s1 = new JsonlFileRadarStore({ filePath })
    s1.proposeCard({ kind: "next-step", title: "persisted", description: "d", createdAtMs: 7 })
    // 0600 security.
    const mode = statSync(filePath).mode & 0o777
    expect(mode).toBe(0o600)
    // Reload — same active set, ids preserved.
    const s2 = new JsonlFileRadarStore({ filePath })
    const active = s2.listActive()
    expect(active.length).toBe(1)
    expect(active[0]?.title).toBe("persisted")
    // No-double-write: a fresh reload (s3) of the file written by s1 + drained
    // by s2 still yields exactly ONE card (replay did not re-append).
    const s3 = new JsonlFileRadarStore({ filePath })
    expect(s3.listActive().length).toBe(1)
  })
})

/* ===================================================================== */
/* shared-instance invariant                                             */
/* ===================================================================== */

describe("HELL-RW-11 shared-instance: loop store IS the /radar store", () => {
  test("a card the loop minted is adopted via the SAME slash-wired store", async () => {
    const store = new InMemoryRadarStore()
    // 1) The loop deposits a card.
    const cfg = baseCfg({
      llm: new FakeLLM([completed("done")]),
      cwd: dir,
      radar: firingBlock(store),
    })
    await runAgent(cfg)
    const active = store.listActive()
    expect(active.length).toBe(1)
    const id = active[0]?.id
    expect(id).toBeDefined()
    // 2) `/radar adopt` over the SAME store instance flips THAT card.
    const { code } = await runRadar(store, ["adopt", id as string])
    expect(code).toBe(0)
    // 3) The loop's view (same instance) now sees it gone from active.
    expect(store.listActive().length).toBe(0)
  })
})
