/**
 * ALBB-19 — prompt / compaction / context-snapshot parity hard-gate.
 *
 * Two REAL defects, red-on-injection pinned:
 *
 *   #3 — `skill_activation` ContextEvents were structurally unreachable on
 *        the live path because the composition-root `getSnapshot` closure
 *        hardcoded `activeSkills: []`. The fix publishes the live per-turn
 *        skill ids to a structural side-channel cursor the closure reads
 *        (mirroring the `metricsEmitter` side-channel). This gate drives the
 *        assembled `cfg.contextEventsForTurn()` producer across two turns and
 *        asserts EXACTLY ONE `skill_activation` for the newly-added skill id.
 *        MUTATION pin: revert the closure to a frozen `[]` ⇒ turn-2 emits no
 *        skill_activation ⇒ this gate goes RED.
 *
 *   #1 — cache-metrics HONESTY (Option A — delete dead wiring). On the default
 *        live path `AgentConfig.system` is always set, so `prompt.ts`'s
 *        `input.system ?? resolveCachedSystemPrompt(...)` short-circuits and
 *        `getOrBuild` is NEVER reached ⇒ ZERO `codex_r2.cache.*` counters.
 *        Option A removes the `withCacheMetrics` wrap on the default path so we
 *        stop paying to build observability that never emits. This gate asserts
 *        NO `codex_r2.cache.*` counter is registered on the default live path.
 *        MUTATION pin: re-introducing the `withCacheMetrics` wrap AND exercising
 *        a live prompt build would fire zero counters anyway — so the honest
 *        assertion is "no cache.* metric ever lands", which the dead wrap
 *        cannot satisfy with real behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { prepareTurnContext } from "@/agent/loop/context-assembler"
import {
  getGlobalSessionResourceRegistry,
  resetGlobalSessionResourceRegistry,
} from "@/agent/session-resource-registry/global"
import type { AgentConfig } from "@/agent/types"
import { type AssembleRequest, assembleAgentConfig } from "@/apps/agent/assemble"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory/working"
import type { MetricsRegistry } from "@/observability/metrics/port"

const inertLLM: LLMPort & { readonly model: string } = {
  model: "gpt-5",
  // biome-ignore lint/correctness/useYield: never invoked
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream()")
  },
}

const baseFor = (over: Partial<AgentConfig> = {}): AssembleRequest["base"] => ({
  llm: inertLLM,
  registry: {
    register: () => undefined,
    get: () => undefined,
    list: () => [],
  } as unknown as AgentConfig["registry"],
  stream: { emit: () => undefined },
  permission: { mode: "default" },
  messages: [],
  system: "test-system-prompt",
  cwd: "/repo",
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId: "sess-albb19",
  ...over,
})

interface CapturedEmit {
  kind: "increment" | "gauge" | "observe"
  name: string
  value: number
}

const mkRegistry = (): { reg: MetricsRegistry; log: CapturedEmit[] } => {
  const log: CapturedEmit[] = []
  const reg: MetricsRegistry = {
    increment(name, delta = 1) {
      log.push({ kind: "increment", name, value: delta })
    },
    observe(name, value) {
      log.push({ kind: "observe", name, value })
    },
    gauge(name, value) {
      log.push({ kind: "gauge", name, value })
    },
    snapshot: () => [],
    reset: () => undefined,
    flush: () => Promise.resolve(),
  }
  return { reg, log }
}

let SAVED_DISK: string | undefined
let SAVED_SQLITE: string | undefined

beforeEach(() => {
  SAVED_DISK = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  SAVED_SQLITE = process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  resetGlobalSessionResourceRegistry()
})

afterEach(() => {
  if (SAVED_DISK !== undefined) process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = SAVED_DISK
  else delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  if (SAVED_SQLITE !== undefined) process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = SAVED_SQLITE
  else delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  resetGlobalSessionResourceRegistry()
})

// The structural side-channel the fix publishes to. Mirrors the `metricsEmitter`
// cast pattern (agent-config-assembler.ts). A mutable cursor whose `.ids` the
// captured `getSnapshot` closure reads each turn.
interface SkillCursorHolder {
  activeSkillCursor?: { ids: readonly string[] }
}

describe("ALBB-19 #3 — skill_activation reachable via live snapshot cursor", () => {
  test("two-turn drive: turn N (no new skill) → none; turn N+1 (skill added) → exactly one", () => {
    const req: AssembleRequest = { mode: "interactive", base: baseFor() }
    const cfg = assembleAgentConfig(req)

    // The producer wire must be present.
    expect(typeof cfg.contextEventsForTurn).toBe("function")

    // The composition root must expose a mutable skill cursor the closure reads.
    const holder = cfg as unknown as SkillCursorHolder
    expect(holder.activeSkillCursor).toBeDefined()
    if (holder.activeSkillCursor === undefined) throw new Error("no cursor")

    const producer = cfg.contextEventsForTurn
    if (producer === undefined) throw new Error("no producer")

    // Turn 1: seed with a stable skill set (no diff to emit — first turn seeds).
    holder.activeSkillCursor.ids = ["alpha"]
    const t1 = producer()
    expect(t1.filter((e) => e.kind === "skill_activation")).toHaveLength(0)

    // Turn 2: SAME skill set ⇒ no new activation.
    holder.activeSkillCursor.ids = ["alpha"]
    const t2 = producer()
    expect(t2.filter((e) => e.kind === "skill_activation")).toHaveLength(0)

    // Turn 3: a NEW skill activates ⇒ EXACTLY ONE skill_activation for it.
    holder.activeSkillCursor.ids = ["alpha", "beta"]
    const t3 = producer()
    const skillEvents = t3.filter((e) => e.kind === "skill_activation")
    expect(skillEvents).toHaveLength(1)
    const ev = skillEvents[0]
    if (ev?.kind === "skill_activation") {
      expect(ev.skillId).toBe("beta")
    } else {
      throw new Error("expected skill_activation event")
    }
  })
})

// ─── #3 REAL-WIRE pin ─────────────────────────────────────────────────────
// The `describe` above hand-sets `holder.activeSkillCursor.ids`, which does NOT
// exercise the publish WIRE (`publishActiveSkillCursor` at
// context-assembler.ts:394). Reverting that line keeps that gate GREEN (vacuous
// for the WIRE). This case drives the REAL `prepareTurnContext` with a live
// `activeSkills` set and asserts the cursor is populated BY THE WIRE — so
// DELETING context-assembler.ts:394 makes it RED (the closure reads a still-`[]`
// cursor ⇒ no `skill_activation`).
describe("ALBB-19 #3 — publish WIRE populates the cursor (prepareTurnContext)", () => {
  test("prepareTurnContext with a live activeSkills set ⇒ contextEventsForTurn emits skill_activation", async () => {
    const req: AssembleRequest = { mode: "interactive", base: baseFor() }
    const cfg = assembleAgentConfig(req)
    expect(typeof cfg.contextEventsForTurn).toBe("function")
    // The assembler must have installed the mutable cursor the closure reads.
    const holder = cfg as unknown as { activeSkillCursor?: { ids: readonly string[] } }
    expect(holder.activeSkillCursor).toBeDefined()
    // Pre-condition: cursor starts empty — nothing has published yet.
    expect(holder.activeSkillCursor?.ids ?? []).toHaveLength(0)

    const wm = createWorkingMemory<Message>([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ])

    // `prepareTurnContext` is the SOLE consumer of the diff-based producer
    // (`resolveContextEventsForTurn` at context-assembler.ts:395); the resulting
    // events are folded into the returned ctx's `promptPolicy.contextChangeCount`.
    // So we observe the WIRE'S effect via the RETURNED ctx — NOT by re-calling
    // the producer (which would see the already-advanced baseline).

    // Turn 1: NO active skills ⇒ the wire publishes `[]` ⇒ no skill_activation ⇒
    // the returned ctx carries zero context-change events (baseline seeds to []).
    const r1 = await prepareTurnContext({
      config: cfg,
      wm,
      recorder: undefined,
      breaker: undefined,
      activeSkills: undefined,
      workingState: undefined,
      archive: undefined,
      turn: 1,
      citations: [],
      hookPromptInjects: undefined,
      taskSpend: undefined,
      bgController: undefined,
      tokenBaselineBox: undefined,
    })
    expect(r1.ctx.promptPolicy.contextChangeCount).toBe(0)

    // Turn 2: a LIVE skill activates. The ONLY way the diff-producer sees "beta"
    // is the `publishActiveSkillCursor` wire (context-assembler.ts:394) writing
    // it to the cursor the closure reads. Deleting line 394 ⇒ cursor stays [] ⇒
    // no skill_activation ⇒ contextChangeCount stays 0 ⇒ this assertion RED.
    const r2 = await prepareTurnContext({
      config: cfg,
      wm,
      recorder: undefined,
      breaker: undefined,
      activeSkills: [{ name: "beta", description: "beta skill" }],
      workingState: undefined,
      archive: undefined,
      turn: 2,
      citations: [],
      hookPromptInjects: undefined,
      taskSpend: undefined,
      bgController: undefined,
      tokenBaselineBox: undefined,
    })
    // The wire wrote the live id to the cursor.
    expect(holder.activeSkillCursor?.ids ?? []).toContain("beta")
    // And the diff surfaced as a context-change event in the assembled ctx.
    expect(r2.ctx.promptPolicy.contextChangeCount).toBe(1)
  })
})

// NOTE: ALBB-19 #1 (cache-metrics "Option A: delete dead wiring") was NOT
// adopted. The withCacheMetrics wrap is an ADR-0358 feature with its own
// composition contract (composition-codex-r2-metrics-wire-hellgate §3/§6);
// deleting it to chase a live-path counter that never fires is disproportionate
// for a P2 and reds an ADR-backed contract. The wrap is kept; whether to engage
// caching on the live prompt path (make cfg.system lazy) is deferred as a
// measure-first product decision. This file gates the #3 skill_activation fix only.
