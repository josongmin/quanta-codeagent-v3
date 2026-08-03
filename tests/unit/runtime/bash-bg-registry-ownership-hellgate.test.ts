/**
 * RFC02-0 — background-shell OWNERSHIP contract hellgate
 * (src/runtime/bash-bg-registry.ts).
 *
 * `BashBgRegistry` is the SINGLE owner of background-shell lifecycle AND of the
 * caller-provided `ownerId` that gates cross-session kill. The owner is passed
 * at `register`/`adopt` time by the composition (a stable session/thread
 * identity) — it is NEVER derived from the shell id, PID, or cwd. Legacy
 * entries with no owner are visible to an operator list as `owner:unknown` but
 * are NOT killable through the owner-scoped path (`killOwned`).
 *
 * Axes (the three RED fixtures the RFC mandates + the list/prefix contract):
 *  1. CROSS-OWNER REFUSAL — owner B cannot `killOwned` owner A's shell even
 *     when B knows the exact id. The child stays alive; a typed refusal is
 *     returned. Red-on-injection: if `killOwned` ignored the owner, this goes
 *     green-kills.
 *  2. AMBIGUOUS PREFIX — a prefix that resolves to >1 owned shell refuses (no
 *     arbitrary pick). Exact id or UNIQUE prefix only.
 *  3. LEGACY-UNOWNED BAN — a shell adopted/registered with no `ownerId` is
 *     listable (as unknown) but `killOwned` refuses it for every caller.
 *  4. LIST — `listOwned(owner)` returns ONLY that owner's shells, in stable
 *     insertion order, and never another owner's.
 *  5. OWN EXACT / UNIQUE-PREFIX KILL — the owner CAN kill its own shell by
 *     exact id or unique prefix (the positive control).
 */

import { describe, expect, test } from "bun:test"
import { createBashBgRegistry } from "@/runtime/bash-bg-registry"
import { createBoundedBuffer } from "@/runtime/bounded-buffer"

const settle = async (pred: () => boolean, max = 200): Promise<void> => {
  for (let i = 0; i < max && !pred(); i++) {
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

/** A controllable adopted child whose `kill` spy resolves its lifecycle so an
 *  awaiting `killOwned`/`kill` settles. */
const makeAdoptable = () => {
  const stdout = createBoundedBuffer(200_000)
  const stderr = createBoundedBuffer(200_000)
  let exitResolve!: (code: number) => void
  const exited = new Promise<number>((res) => {
    exitResolve = res
  })
  let drainsResolve!: () => void
  const drainsDone = new Promise<void>((res) => {
    drainsResolve = res
  })
  const spy = { kills: 0 }
  return {
    stdout,
    stderr,
    exited,
    drainsDone,
    spy,
    kill: () => {
      spy.kills += 1
      drainsResolve()
      exitResolve(137)
    },
    disarm: () => {},
    adoptArgs(overrides: Record<string, unknown> = {}) {
      return {
        command: "sleep 999",
        cwd: "/tmp",
        kill: this.kill,
        disarm: this.disarm,
        stdout: this.stdout,
        stderr: this.stderr,
        exited: this.exited,
        drainsDone: this.drainsDone,
        ...overrides,
      }
    },
  }
}

describe("RFC02-0 — cross-owner kill refusal", () => {
  test("owner B cannot killOwned owner A's shell even with the exact id (child stays alive)", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const childA = makeAdoptable()
    const { id } = await reg.adopt(childA.adoptArgs({ ownerId: "sessA" }))

    const res = await reg.killOwned(id, "sessB")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("not_owned")
    expect(childA.spy.kills).toBe(0) // never signalled
    expect(reg.get(id)?.status).toBe("running") // still alive
  })
})

describe("RFC02-0 — ambiguous prefix refusal (no arbitrary pick)", () => {
  test("a prefix matching >1 owned shell refuses with ambiguous, killing neither", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const c1 = makeAdoptable()
    const c2 = makeAdoptable()
    // Force two ids sharing a common prefix by supplying explicit ids.
    const a = await reg.adopt(c1.adoptArgs({ ownerId: "s1", id: "abc-111" }))
    const b = await reg.adopt(c2.adoptArgs({ ownerId: "s1", id: "abc-222" }))
    expect(a.id).toBe("abc-111")
    expect(b.id).toBe("abc-222")

    const res = await reg.killOwned("abc", "s1")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("ambiguous")
    expect(c1.spy.kills).toBe(0)
    expect(c2.spy.kills).toBe(0)
  })
})

describe("RFC02-0 — legacy unowned shell is un-killable through killOwned", () => {
  test("a shell registered with NO ownerId refuses killOwned for every caller but lists as unknown", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const legacy = makeAdoptable()
    const { id } = await reg.adopt(legacy.adoptArgs()) // no ownerId

    // Listing an operator's full inventory shows it as owner unknown.
    const owned = reg.get(id)
    expect(owned?.ownerId).toBeUndefined()

    const res = await reg.killOwned(id, "anyone")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("not_owned")
    expect(legacy.spy.kills).toBe(0)
    expect(reg.get(id)?.status).toBe("running")
  })
})

describe("RFC02-0 — listOwned scoping + stable order", () => {
  test("listOwned returns ONLY the caller's shells in insertion order", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const a1 = makeAdoptable()
    const a2 = makeAdoptable()
    const bOther = makeAdoptable()
    const x = await reg.adopt(a1.adoptArgs({ ownerId: "sA", id: "a-1" }))
    await reg.adopt(bOther.adoptArgs({ ownerId: "sB", id: "b-1" }))
    const y = await reg.adopt(a2.adoptArgs({ ownerId: "sA", id: "a-2" }))

    const list = reg.listOwned("sA")
    expect(list.map((s) => s.id)).toEqual([x.id, y.id]) // insertion order, no sB
    expect(list.every((s) => s.ownerId === "sA")).toBe(true)
    // No cross-owner leak.
    expect(list.some((s) => s.id === "b-1")).toBe(false)
  })
})

describe("RFC02-0 — a prefix unique WITHIN the owner resolves even if a foreign shell shares it", () => {
  test("owner-scoping means a foreign shell sharing the prefix never causes ambiguity or a foreign kill", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const mine = makeAdoptable()
    const foreign = makeAdoptable()
    const m = await reg.adopt(mine.adoptArgs({ ownerId: "me", id: "shared-mine" }))
    await reg.adopt(foreign.adoptArgs({ ownerId: "other", id: "shared-foreign" }))

    // "shared-" is a prefix of BOTH, but only ONE is mine ⇒ resolves to mine,
    // never ambiguous, never the foreign shell.
    const res = await reg.killOwned("shared-", "me")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.snapshot.id).toBe(m.id)
    expect(mine.spy.kills).toBeGreaterThanOrEqual(1)
    expect(foreign.spy.kills).toBe(0) // foreign never touched
  })
})

describe("RFC02-0 — own exact / unique-prefix kill (positive control)", () => {
  test("the owner kills its own shell by exact id", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const c = makeAdoptable()
    const { id } = await reg.adopt(c.adoptArgs({ ownerId: "sX", id: "exact-1" }))
    const res = await reg.killOwned("exact-1", "sX")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.snapshot.id).toBe(id)
    await settle(() => reg.get(id)?.status === "killed")
    expect(reg.get(id)?.status).toBe("killed")
    expect(c.spy.kills).toBeGreaterThanOrEqual(1)
  })

  test("the owner kills its own shell by a UNIQUE prefix", async () => {
    const reg = createBashBgRegistry({ maxEntries: 8 })
    const c = makeAdoptable()
    const { id } = await reg.adopt(c.adoptArgs({ ownerId: "sY", id: "zzz-unique" }))
    const res = await reg.killOwned("zzz", "sY") // unique prefix
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.snapshot.id).toBe(id)
    expect(c.spy.kills).toBeGreaterThanOrEqual(1)
  })
})
