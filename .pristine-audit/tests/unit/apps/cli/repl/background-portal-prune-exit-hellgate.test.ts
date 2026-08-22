/**
 * ★ HELLGATE — WS-H / UUX-3-12: portal Map hygiene + REPL-exit honesty.
 *
 * At HEAD the portal Map is NEVER pruned (every detach leaks an entry for the
 * session's lifetime) and REPL exit says NOTHING about live background turns
 * (they are silently abandoned/killed).
 *
 *  (A) prune-on-settle — settled entries are LRU-capped by the named
 *      `BG_SETTLED_ENTRIES_MAX` const (injectable for tests): when a settle
 *      pushes the settled population over the cap, the OLDEST-settled entry is
 *      evicted. RUNNING entries are NEVER evicted (they own a live body).
 *      Recently settled entries remain reattachable (the whole point of the
 *      buffer — settle must NOT mean instant deletion).
 *  (B) exit warning — `warnLiveBackgroundTurns` enumerates running entries and
 *      prints one warning line listing them; silent when none / portal absent;
 *      NO-THROW (it runs on the teardown path).
 */

import { describe, expect, test } from "bun:test"
import {
  BG_SETTLED_ENTRIES_MAX,
  createBackgroundTurnPortal,
} from "../../../../../src/apps/cli/repl/background-turn-portal"
import { warnLiveBackgroundTurns } from "../../../../../src/apps/cli/repl/session-loop/turn-helpers"

const settleMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const detachResolved = async (
  portal: ReturnType<typeof createBackgroundTurnPortal>,
  label: string,
): Promise<string> => {
  const id = portal.detach({
    label,
    promise: Promise.resolve("ok"),
    abort: new AbortController(),
  })
  await settleMicrotasks()
  return id
}

describe("(A) UUX-3-12 — settled entries are LRU-capped (RED at HEAD: never pruned)", () => {
  test("settling beyond the cap evicts the OLDEST settled entry", async () => {
    const portal = createBackgroundTurnPortal({ settledEntriesMax: 2 })
    const a = await detachResolved(portal, "a")
    const b = await detachResolved(portal, "b")
    const c = await detachResolved(portal, "c") // third settle ⇒ 'a' evicted
    expect(portal.get(a)).toBeUndefined() // ← RED at HEAD (entries leak forever)
    expect(portal.get(b)).toBeDefined()
    expect(portal.get(c)).toBeDefined()
    expect(portal.list()).toHaveLength(2)
  })

  test("a JUST-settled entry stays reattachable (settle ≠ instant deletion)", async () => {
    const portal = createBackgroundTurnPortal({ settledEntriesMax: 2 })
    const id = await detachResolved(portal, "recent")
    const re = portal.reattach(id)
    expect(re).toBeDefined()
    expect(re?.state).toBe("done")
  })

  test("RUNNING entries are never evicted — only settled entries count toward the cap", async () => {
    const portal = createBackgroundTurnPortal({ settledEntriesMax: 1 })
    const liveId = portal.detach({
      label: "live",
      promise: new Promise<string>(() => undefined), // never settles
      abort: new AbortController(),
    })
    await detachResolved(portal, "s1")
    await detachResolved(portal, "s2") // evicts s1, NOT the running entry
    expect(portal.get(liveId)?.state).toBe("running")
    expect(portal.list().filter((e) => e.state === "running")).toHaveLength(1)
    expect(portal.list()).toHaveLength(2) // live + 1 settled
  })

  test("default cap is the named constant (no magic number)", () => {
    expect(BG_SETTLED_ENTRIES_MAX).toBeGreaterThan(0)
  })

  test("failed/cancelled settles also prune (state-agnostic settled population)", async () => {
    const portal = createBackgroundTurnPortal({ settledEntriesMax: 1 })
    const failed = portal.detach({
      label: "boom",
      promise: Promise.reject(new Error("boom")),
      abort: new AbortController(),
    })
    await settleMicrotasks()
    await detachResolved(portal, "later")
    expect(portal.get(failed)).toBeUndefined() // oldest settled (failed) evicted
    expect(portal.list()).toHaveLength(1)
  })
})

describe("(B) UUX-3-12 — REPL exit warns about live background turns (RED at HEAD: silent)", () => {
  test("live entries ⇒ ONE warning line enumerating id + label", () => {
    const portal = createBackgroundTurnPortal()
    const id = portal.detach({
      label: "deploy the thing",
      promise: new Promise<string>(() => undefined),
      abort: new AbortController(),
    })
    const lines: string[] = []
    warnLiveBackgroundTurns(portal, (s) => lines.push(s))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(id)
    expect(lines[0]).toContain("deploy the thing")
    expect(lines[0]?.toLowerCase()).toContain("background")
  })

  test("no live entries ⇒ silent (settled-only portal writes nothing)", async () => {
    const portal = createBackgroundTurnPortal()
    await detachResolved(portal, "done already")
    const lines: string[] = []
    warnLiveBackgroundTurns(portal, (s) => lines.push(s))
    expect(lines).toHaveLength(0)
  })

  test("portal absent ⇒ silent no-op (default-OFF surface)", () => {
    const lines: string[] = []
    warnLiveBackgroundTurns(undefined, (s) => lines.push(s))
    expect(lines).toHaveLength(0)
  })

  test("NO-THROW on the teardown path — a throwing writer is swallowed", () => {
    const portal = createBackgroundTurnPortal()
    portal.detach({
      label: "live",
      promise: new Promise<string>(() => undefined),
      abort: new AbortController(),
    })
    expect(() =>
      warnLiveBackgroundTurns(portal, () => {
        throw new Error("stderr closed")
      }),
    ).not.toThrow()
  })
})
