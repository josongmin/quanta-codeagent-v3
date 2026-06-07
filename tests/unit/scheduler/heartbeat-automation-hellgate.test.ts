/**
 * H8 hellgate — heartbeat automation: creation-boundary invariants (pure) +
 * JSONL round-trip of the new `kind`/`targetThreadId`/`inheritedPolicy` fields.
 *
 * `cron` (absent kind) MUST stay byte-identical: no `kind` key on the wire, and
 * `validateHeartbeatCandidate` always passes it. A `heartbeat` MUST carry a
 * target thread + posture snapshot, and only ONE active heartbeat may occupy a
 * thread.
 */

import { describe, expect, test } from "bun:test"
import {
  type Automation,
  activeHeartbeatForThread,
  type HeartbeatPolicySnapshot,
  validateHeartbeatCandidate,
} from "@/scheduler"
import { createAutomation } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { defaultJsonlAutomationStore, type JsonlAutomationStoreOpts } from "@/scheduler/store-jsonl"

const ruleOf = (s: string) => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error("bad rule")
  const { ok: _ok, ...rest } = r
  return rest
}

const POLICY: HeartbeatPolicySnapshot = {
  approvalPolicy: "on-request",
  sandboxPolicy: "workspace-write",
  collaborationMode: "default",
}

const base = (over?: Partial<Automation>): Automation => ({
  ...createAutomation({
    id: "a1",
    title: "t",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "p",
    modelPreference: "gpt-5",
    modelFallbacks: [],
    createdAt: 1000,
  }),
  ...over,
})

const heartbeat = (over?: Partial<Automation>): Automation =>
  base({ kind: "heartbeat", targetThreadId: "thread-1", inheritedPolicy: POLICY, ...over })

describe("H8 — heartbeat creation-boundary validation (pure)", () => {
  test("cron candidate is always ok (no heartbeat constraints)", () => {
    expect(validateHeartbeatCandidate(base(), [])).toEqual({ ok: true })
    expect(validateHeartbeatCandidate(base({ kind: "cron" }), [])).toEqual({ ok: true })
  })

  test("heartbeat without targetThreadId → missing-target-thread", () => {
    const cand = base({ kind: "heartbeat", inheritedPolicy: POLICY })
    expect(validateHeartbeatCandidate(cand, [])).toEqual({
      ok: false,
      reason: "missing-target-thread",
    })
  })

  test("heartbeat without inheritedPolicy → missing-policy", () => {
    const cand = base({ kind: "heartbeat", targetThreadId: "thread-1" })
    expect(validateHeartbeatCandidate(cand, [])).toEqual({ ok: false, reason: "missing-policy" })
  })

  test("a second active heartbeat on an occupied thread → thread-occupied", () => {
    const existing = [heartbeat({ id: "a1" })]
    const cand = heartbeat({ id: "a2" })
    expect(validateHeartbeatCandidate(cand, existing)).toEqual({
      ok: false,
      reason: "thread-occupied",
    })
  })

  test("updating the SAME heartbeat (same id) re-occupies its own slot → ok", () => {
    const existing = [heartbeat({ id: "a1" })]
    expect(validateHeartbeatCandidate(heartbeat({ id: "a1" }), existing)).toEqual({ ok: true })
  })

  test("a paused/deleted heartbeat does NOT occupy the thread", () => {
    const existing = [heartbeat({ id: "a1", status: "paused" })]
    expect(validateHeartbeatCandidate(heartbeat({ id: "a2" }), existing)).toEqual({ ok: true })
    expect(activeHeartbeatForThread(existing, "thread-1")).toBeUndefined()
  })

  test("activeHeartbeatForThread finds exactly the active occupant", () => {
    const occupant = heartbeat({ id: "a1" })
    expect(activeHeartbeatForThread([occupant], "thread-1")?.id).toBe("a1")
    expect(activeHeartbeatForThread([occupant], "thread-2")).toBeUndefined()
  })
})

// In-memory store seam (reader/appender) so the round-trip needs no real FS.
const memStore = (): { store: ReturnType<typeof defaultJsonlAutomationStore>; lines: string[] } => {
  const lines: string[] = []
  const opts: JsonlAutomationStoreOpts = {
    baseDir: "/mem",
    reader: async () => lines.join(""),
    appender: async (_f, line) => void lines.push(line),
    mkdirer: async () => {},
  }
  return { store: defaultJsonlAutomationStore(opts), lines }
}

describe("H8 — JSONL round-trip of heartbeat fields", () => {
  test("heartbeat kind/targetThreadId/inheritedPolicy survive save → load", async () => {
    const { store } = memStore()
    await store.save("/w", heartbeat())
    const [loaded] = await store.load("/w")
    expect(loaded?.kind).toBe("heartbeat")
    expect(loaded?.targetThreadId).toBe("thread-1")
    expect(loaded?.inheritedPolicy).toEqual(POLICY)
  })

  test("cron automation has NO kind/target/policy keys (byte-identical legacy)", async () => {
    const { store, lines } = memStore()
    await store.save("/w", base())
    expect(lines.join("")).not.toContain("kind")
    expect(lines.join("")).not.toContain("targetThreadId")
    const [loaded] = await store.load("/w")
    expect(loaded?.kind).toBeUndefined()
    expect(loaded?.targetThreadId).toBeUndefined()
    expect(loaded?.inheritedPolicy).toBeUndefined()
  })

  test("a partial inheritedPolicy (missing a field) is dropped on load (never half-inherited)", async () => {
    const { store, lines } = memStore()
    // Hand-write a row with a 2-field policy (missing collaborationMode).
    const bad = { ...heartbeat(), inheritedPolicy: { approvalPolicy: "x", sandboxPolicy: "y" } }
    lines.push(`${JSON.stringify(bad)}\n`)
    const [loaded] = await store.load("/w")
    expect(loaded?.inheritedPolicy).toBeUndefined()
  })
})
