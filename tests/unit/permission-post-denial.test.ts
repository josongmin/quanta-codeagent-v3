/**
 * Unit tests for the post-denial state machine (ADR-0046).
 *
 *   - hasPostDenialOverride returns false on empty state
 *   - returns true ONLY after the full sequence
 *   - sequence enforcement: seenRiskAt MUST precede userOverrideAt
 *   - per-(threadId, action) isolation: a sibling thread doesn't inherit
 *   - a fresh recordDenial resets the override sequence
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeActionSignature,
  createPermissionStore,
  hasPostDenialOverride,
  type PermissionStore,
  recordDenial,
  recordRiskSeen,
  recordUserOverride,
} from "@/permission"

let tmp: string
let store: PermissionStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "quanta-postdenial-"))
  store = createPermissionStore({ filePath: join(tmp, "state.json"), debounceMs: 0 })
  await store.load()
})

afterEach(async () => {
  await store.flush()
  await rm(tmp, { recursive: true, force: true })
})

const ACTION = {
  threadId: "t1",
  tool: "edit",
  workdir: "/repo",
  args: { path: "secret.env" },
}

describe("post-denial — empty state", () => {
  test("hasPostDenialOverride is false when no record exists", () => {
    expect(hasPostDenialOverride(ACTION, { store })).toBe(false)
  })

  test("recording risk-seen without prior denial is a no-op", () => {
    recordRiskSeen(ACTION, { store, clock: { now: () => 100 } })
    expect(hasPostDenialOverride(ACTION, { store })).toBe(false)
  })

  test("recording override without prior denial is a no-op", () => {
    recordUserOverride(ACTION, { store, clock: { now: () => 100 } })
    expect(hasPostDenialOverride(ACTION, { store })).toBe(false)
  })
})

describe("post-denial — sequence enforcement", () => {
  test("denial alone ⇒ no override", () => {
    recordDenial(ACTION, "test", { store, clock: { now: () => 100 } })
    expect(hasPostDenialOverride(ACTION, { store })).toBe(false)
  })

  test("denial + risk-seen alone ⇒ no override (missing user step)", () => {
    recordDenial(ACTION, "test", { store, clock: { now: () => 100 } })
    recordRiskSeen(ACTION, { store, clock: { now: () => 200 } })
    expect(hasPostDenialOverride(ACTION, { store })).toBe(false)
  })

  test("denial + risk-seen + user override ⇒ override active", () => {
    recordDenial(ACTION, "test", { store, clock: { now: () => 100 } })
    recordRiskSeen(ACTION, { store, clock: { now: () => 200 } })
    recordUserOverride(ACTION, { store, clock: { now: () => 300 } })
    expect(hasPostDenialOverride(ACTION, { store })).toBe(true)
  })

  test("user-override BEFORE risk-seen ⇒ rejected (ordering violation)", () => {
    recordDenial(ACTION, "test", { store, clock: { now: () => 100 } })
    // Recording the override first then the risk-seen reverses the sequence —
    // store keeps both timestamps but `hasPostDenialOverride` enforces the
    // ordering at read time.
    recordUserOverride(ACTION, { store, clock: { now: () => 150 } })
    recordRiskSeen(ACTION, { store, clock: { now: () => 200 } })
    expect(hasPostDenialOverride(ACTION, { store })).toBe(false)
  })

  test("recordDenial RESETS prior override sequence", () => {
    recordDenial(ACTION, "first", { store, clock: { now: () => 100 } })
    recordRiskSeen(ACTION, { store, clock: { now: () => 200 } })
    recordUserOverride(ACTION, { store, clock: { now: () => 300 } })
    expect(hasPostDenialOverride(ACTION, { store })).toBe(true)
    // A fresh denial clears the sequence.
    recordDenial(ACTION, "second", { store, clock: { now: () => 400 } })
    expect(hasPostDenialOverride(ACTION, { store })).toBe(false)
  })
})

describe("post-denial — (threadId, actionSignature) isolation", () => {
  test("different threads have independent override state", () => {
    recordDenial({ ...ACTION, threadId: "t1" }, "test", {
      store,
      clock: { now: () => 100 },
    })
    recordRiskSeen({ ...ACTION, threadId: "t1" }, { store, clock: { now: () => 200 } })
    recordUserOverride({ ...ACTION, threadId: "t1" }, { store, clock: { now: () => 300 } })
    expect(hasPostDenialOverride({ ...ACTION, threadId: "t1" }, { store })).toBe(true)
    expect(hasPostDenialOverride({ ...ACTION, threadId: "t2" }, { store })).toBe(false)
  })

  test("different actions have independent override state", () => {
    recordDenial(ACTION, "test", { store, clock: { now: () => 100 } })
    recordRiskSeen(ACTION, { store, clock: { now: () => 200 } })
    recordUserOverride(ACTION, { store, clock: { now: () => 300 } })
    expect(hasPostDenialOverride(ACTION, { store })).toBe(true)
    expect(hasPostDenialOverride({ ...ACTION, args: { path: "different.env" } }, { store })).toBe(
      false,
    )
  })

  test("actionSignature is the unit of isolation (not tool name alone)", () => {
    const sigA = computeActionSignature({
      tool: "edit",
      workdir: "/repo",
      args: { path: "a" },
    })
    const sigB = computeActionSignature({
      tool: "edit",
      workdir: "/repo",
      args: { path: "b" },
    })
    expect(sigA).not.toBe(sigB)
  })
})
