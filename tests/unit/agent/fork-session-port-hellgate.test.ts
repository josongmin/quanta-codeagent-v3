/**
 * ForkSessionPort hellgate (ADR-0226).
 *
 * Seals 17 invariants:
 *   FP-01  fork from valid checkpoint → ok + populated ForkResult
 *   FP-02  fork from missing checkpoint → Err("checkpoint-not-found")
 *   FP-03  branch-id uniqueness across multiple forks
 *   FP-04  parent-link round-trip (record → resolveParent / listBranches)
 *   FP-05  listBranches({sessionId: empty}) → []
 *   FP-06  multi-fork same checkpoint → both succeed, both in listBranches
 *   FP-07  cancellation BEFORE start → Err("aborted"), zero state mutation
 *   FP-08  cancellation BETWEEN base + link → Err("aborted"), still zero links
 *   FP-09  OFF (no base) → Err("fork-not-configured")
 *   FP-10  shadow ODB throwing → Err("shadow-odb-failed") but link kept
 *   FP-11  conversation store absent (base errors propagate) → Err passthrough
 *   FP-12  invalid branch name → Err("invalid-branch-name")
 *   FP-13  branchName preserved through ForkResult AND ParentLink
 *   FP-14  resolveParent unknown id → null
 *   FP-15  ParentLinkStore LRU cap respected at 1000 inserts
 *   FP-16  ALL_FORK_ERROR_CODES coverage proves new 4 arms exist
 *   FP-17  branchId is URL-safe (only A-Z, a-z, 0-9, -, _)
 */

import { describe, expect, test } from "bun:test"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import {
  ALL_FORK_ERROR_CODES,
  BRANCH_ID_ALPHABET,
  defaultBranchIdMinter,
  defaultForker,
  defaultParentLinkStore,
  defaultSessionForker,
  type ForkSessionPort,
  isWellFormedBranchId,
  type ShadowOdbLike,
} from "@/agent/fork-session"
import type { Message } from "@/llm"

const mkMsg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}
const resetTick = (start = 1_000): void => {
  tickValue = start
}

// Deterministic UUID minter (re-used across tests).
let uuidCounter = 0
const mintUuid = (): string => {
  uuidCounter += 1
  const c = uuidCounter.toString(16).padStart(8, "0")
  return `${c}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
}

// Deterministic branch-id minter (counter-based bytes). The counter is
// converted to a multi-byte little-endian view so each `n`-byte read at a
// distinct call index produces a UNIQUE bit pattern — this matters for FP-03
// which spins 50 forks and asserts no branch-id collision under the
// fake-bytes seed (real `crypto.randomBytes` is collision-resistant by
// construction; the fake has to model that too).
let branchCallCounter = 0
const fakeRandomBytes = (n: number): Uint8Array => {
  branchCallCounter += 1
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) {
    // Mix the call counter into every byte so the (length=12) output covers
    // a different 6-bit slice on every invocation. Shift by `i * 5` gives a
    // pseudo-stream of distinct bytes per call without wrapping prematurely.
    out[i] = (branchCallCounter * 31 + i * 7 + (branchCallCounter >> (i % 8))) & 0xff
  }
  return out
}

const freshPort = (
  opts: { withShadow?: ShadowOdbLike; withWorkspace?: string; noBase?: boolean } = {},
): {
  port: ForkSessionPort
  store: ReturnType<typeof defaultConversationCheckpointStore>
  links: ReturnType<typeof defaultParentLinkStore>
} => {
  resetTick()
  uuidCounter = 0
  branchCallCounter = 0
  const store = defaultConversationCheckpointStore({ maxEntries: 50, now: tick })
  const links = defaultParentLinkStore({ maxEntries: 50 })
  const base =
    opts.noBase === true
      ? undefined
      : defaultSessionForker(store, { now: tick, mintSessionId: mintUuid })
  const mintBranchId = defaultBranchIdMinter({ randomBytes: fakeRandomBytes, length: 12 })
  const port = defaultForker({
    ...(base !== undefined ? { base } : {}),
    links,
    now: tick,
    mintBranchId,
    ...(opts.withShadow !== undefined ? { shadowOdb: opts.withShadow } : {}),
    ...(opts.withWorkspace !== undefined ? { workspaceRoot: opts.withWorkspace } : {}),
  })
  return { port, store, links }
}

describe("ForkSessionPort hellgate (ADR-0226)", () => {
  test("FP-01: fork from valid checkpoint → ok + populated ForkResult", async () => {
    const { port, store } = freshPort()
    const msgs = [mkMsg("user", "hi"), mkMsg("assistant", "hello")]
    store.record("session-A", msgs)
    const r = await port.fork({ fromCheckpointRef: "session-A" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.parentSessionId).toBe("session-A")
    expect(r.value.branchPoint).toBe("session-A")
    expect(r.value.newSessionId).not.toBe("session-A")
    expect(r.value.messages.length).toBe(2)
    expect(typeof r.value.branchId).toBe("string")
    expect(r.value.branchId.length).toBeGreaterThan(0)
    expect(r.value.forkedAt).toBeGreaterThan(0)
  })

  test("FP-02: fork from missing checkpoint → Err('checkpoint-not-found')", async () => {
    const { port } = freshPort()
    const r = await port.fork({ fromCheckpointRef: "does-not-exist" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("checkpoint-not-found")
  })

  test("FP-03: branch-id uniqueness across 50 forks of the same checkpoint", async () => {
    const { port, store } = freshPort()
    store.record("session-A", [mkMsg("user", "x")])
    const seen = new Set<string>()
    for (let i = 0; i < 50; i += 1) {
      const r = await port.fork({ fromCheckpointRef: "session-A" })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(seen.has(r.value.branchId)).toBe(false)
      seen.add(r.value.branchId)
    }
    expect(seen.size).toBe(50)
  })

  test("FP-04: parent-link round-trip via resolveParent + listBranches", async () => {
    const { port, store } = freshPort()
    store.record("session-A", [mkMsg("user", "x")])
    const r = await port.fork({ fromCheckpointRef: "session-A", branchName: "feat-x" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(port.resolveParent({ sessionId: r.value.newSessionId })).toBe("session-A")
    const branches = port.listBranches({ sessionId: "session-A" })
    expect(branches.length).toBe(1)
    const first = branches[0]
    if (first === undefined) throw new Error("unreachable")
    expect(first.childSessionId).toBe(r.value.newSessionId)
    expect(first.branchName).toBe("feat-x")
    expect(first.branchPoint).toBe("session-A")
  })

  test("FP-05: listBranches({sessionId: ''}) → [] (no throw)", () => {
    const { port } = freshPort()
    expect(port.listBranches({ sessionId: "" }).length).toBe(0)
    expect(port.listBranches({ sessionId: "unknown" }).length).toBe(0)
  })

  test("FP-06: multi-fork same checkpoint → both succeed, both in listBranches", async () => {
    const { port, store } = freshPort()
    store.record("session-A", [mkMsg("user", "x")])
    const r1 = await port.fork({ fromCheckpointRef: "session-A", branchName: "v1" })
    const r2 = await port.fork({ fromCheckpointRef: "session-A", branchName: "v2" })
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) throw new Error("unreachable")
    expect(r1.value.newSessionId).not.toBe(r2.value.newSessionId)
    const branches = port.listBranches({ sessionId: "session-A" })
    expect(branches.length).toBe(2)
    const names = new Set(branches.map((b) => b.branchName))
    expect(names.has("v1")).toBe(true)
    expect(names.has("v2")).toBe(true)
    // newest-first ordering (forkedAt descending).
    expect(branches[0]?.forkedAt).toBeGreaterThanOrEqual(branches[1]?.forkedAt ?? -1)
  })

  test("FP-07: cancellation BEFORE start → Err('aborted'), zero state mutation", async () => {
    const { port, store, links } = freshPort()
    store.record("session-A", [mkMsg("user", "x")])
    const linksBefore = links.size()
    const ac = new AbortController()
    ac.abort()
    const r = await port.fork({ fromCheckpointRef: "session-A", signal: ac.signal })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("aborted")
    // Zero new links recorded.
    expect(links.size()).toBe(linksBefore)
    // Parent snapshot unchanged.
    expect(store.restore("session-A")).not.toBe(null)
  })

  test("FP-08: cancellation BETWEEN base + link → Err('aborted'), no link recorded", async () => {
    // Wrap the base forker so the AbortController fires right after the
    // sync `fork()` returns but before the link record runs.
    resetTick()
    uuidCounter = 0
    branchCallCounter = 0
    const store = defaultConversationCheckpointStore({ maxEntries: 50, now: tick })
    const links = defaultParentLinkStore({ maxEntries: 50 })
    const realBase = defaultSessionForker(store, { now: tick, mintSessionId: mintUuid })
    const ac = new AbortController()
    const sneakyBase = {
      fork(id: string): ReturnType<typeof realBase.fork> {
        const r = realBase.fork(id)
        // Fire the abort signal between base success and link.record.
        ac.abort()
        return r
      },
    }
    const mintBranchId = defaultBranchIdMinter({ randomBytes: fakeRandomBytes, length: 12 })
    const port = defaultForker({
      base: sneakyBase,
      links,
      now: tick,
      mintBranchId,
    })
    store.record("session-A", [mkMsg("user", "x")])
    const r = await port.fork({ fromCheckpointRef: "session-A", signal: ac.signal })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("aborted")
    // Sneaky base DID succeed and clone, but the link MUST NOT be recorded —
    // the user-visible state stays consistent (no orphan link rows).
    expect(links.size()).toBe(0)
  })

  test("FP-09: OFF (no base) → Err('fork-not-configured')", async () => {
    const { port } = freshPort({ noBase: true })
    const r = await port.fork({ fromCheckpointRef: "anything" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("fork-not-configured")
  })

  test("FP-10: shadow ODB throwing → Err('shadow-odb-failed') but link kept", async () => {
    const throwingShadow: ShadowOdbLike = {
      async registerHead(_w: string): Promise<string> {
        throw new Error("disk full")
      },
    }
    const { port, store, links } = freshPort({
      withShadow: throwingShadow,
      withWorkspace: "/tmp/x",
    })
    store.record("session-A", [mkMsg("user", "x")])
    const r = await port.fork({ fromCheckpointRef: "session-A", branchName: "rescue" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("shadow-odb-failed")
    expect(r.error.message).toContain("disk full")
    // Critically — the LINK is still recorded (the new session is usable;
    // only the tag is missing). User-visible result: session exists, branch
    // tree shows it, surface decides whether to retry the tag.
    expect(links.size()).toBe(1)
    // resolveParent works — link is durable.
    const branches = port.listBranches({ sessionId: "session-A" })
    expect(branches.length).toBe(1)
    expect(branches[0]?.branchName).toBe("rescue")
  })

  test("FP-11: store-full + checkpoint-not-found pass-through from base", async () => {
    // Use a real base whose store can be cleared mid-test to reproduce
    // checkpoint-not-found.
    const { port, store } = freshPort()
    store.record("session-A", [mkMsg("user", "x")])
    store.clear()
    const r = await port.fork({ fromCheckpointRef: "session-A" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("checkpoint-not-found")
  })

  test("FP-12: invalid branch name → Err('invalid-branch-name')", async () => {
    const { port, store, links } = freshPort()
    store.record("session-A", [mkMsg("user", "x")])
    const invalidNames = [
      "with space",
      "with/slash",
      "with..dots",
      "",
      "x".repeat(65),
      "with#hash",
      "with\nnewline",
    ]
    for (const name of invalidNames) {
      const r = await port.fork({ fromCheckpointRef: "session-A", branchName: name })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error(`unreachable for ${name}`)
      expect(r.error.code).toBe("invalid-branch-name")
    }
    // No link recorded for any of them.
    expect(links.size()).toBe(0)
  })

  test("FP-13: branchName preserved through ForkResult AND ParentLink (and absent stays absent)", async () => {
    const { port, store } = freshPort()
    store.record("session-A", [mkMsg("user", "x")])
    const r1 = await port.fork({ fromCheckpointRef: "session-A", branchName: "labeled" })
    expect(r1.ok).toBe(true)
    if (!r1.ok) throw new Error("unreachable")
    expect(r1.value.branchName).toBe("labeled")
    const r2 = await port.fork({ fromCheckpointRef: "session-A" })
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("unreachable")
    // exactOptionalPropertyTypes — absent, NOT undefined-set.
    expect("branchName" in r2.value).toBe(false)
    const branches = port.listBranches({ sessionId: "session-A" })
    expect(branches.length).toBe(2)
    const labeled = branches.find((b) => b.childSessionId === r1.value.newSessionId)
    const unlabeled = branches.find((b) => b.childSessionId === r2.value.newSessionId)
    expect(labeled?.branchName).toBe("labeled")
    expect(unlabeled !== undefined && "branchName" in unlabeled).toBe(false)
  })

  test("FP-14: resolveParent unknown id → null", () => {
    const { port } = freshPort()
    expect(port.resolveParent({ sessionId: "" })).toBe(null)
    expect(port.resolveParent({ sessionId: "never-recorded" })).toBe(null)
  })

  test("FP-15: ParentLinkStore LRU cap respected at 1000 inserts", async () => {
    // Configure links cap = 10. Insert 1000. Size never exceeds 10.
    resetTick()
    uuidCounter = 0
    branchCallCounter = 0
    const store = defaultConversationCheckpointStore({ maxEntries: 2000, now: tick })
    const links = defaultParentLinkStore({ maxEntries: 10 })
    const base = defaultSessionForker(store, { now: tick, mintSessionId: mintUuid })
    const mintBranchId = defaultBranchIdMinter({ randomBytes: fakeRandomBytes, length: 12 })
    const port = defaultForker({ base, links, now: tick, mintBranchId })
    store.record("session-A", [mkMsg("user", "x")])
    for (let i = 0; i < 1000; i += 1) {
      const r = await port.fork({ fromCheckpointRef: "session-A" })
      expect(r.ok).toBe(true)
    }
    expect(links.size()).toBeLessThanOrEqual(10)
  })

  test("FP-16: ALL_FORK_ERROR_CODES contains the 4 new ADR-0226 arms", () => {
    const codes = new Set<string>(ALL_FORK_ERROR_CODES)
    expect(codes.has("fork-not-configured")).toBe(true)
    expect(codes.has("aborted")).toBe(true)
    expect(codes.has("invalid-branch-name")).toBe(true)
    expect(codes.has("shadow-odb-failed")).toBe(true)
    // Original 4 ADR-0201 arms still present.
    expect(codes.has("checkpoint-not-found")).toBe(true)
    expect(codes.has("duplicate-id")).toBe(true)
    expect(codes.has("lineage-cycle")).toBe(true)
    expect(codes.has("store-full")).toBe(true)
  })

  test("FP-17: branchId is URL-safe (alphabet check) and well-formed", async () => {
    const { port, store } = freshPort()
    store.record("session-A", [mkMsg("user", "x")])
    const allowed = new Set<string>(BRANCH_ID_ALPHABET)
    for (let i = 0; i < 20; i += 1) {
      const r = await port.fork({ fromCheckpointRef: "session-A" })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      for (const ch of r.value.branchId) {
        expect(allowed.has(ch)).toBe(true)
      }
      expect(isWellFormedBranchId(r.value.branchId)).toBe(true)
    }
  })
})
