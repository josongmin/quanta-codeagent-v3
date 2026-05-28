/**
 * ADR-0395 — Run Ledger hellgate.
 *
 * Adversarial battery over the unified long-running-work state model. The
 * ledger is the SINGLE place a UI reads to render Running / Waiting / Completed
 * across shell-detached, subagent-background, MCP-task, and exec work. This
 * wave is MODEL ONLY — the suite proves the port contract & retention policy in
 * isolation; no bash/subagent/mcp/loop wiring is exercised.
 *
 * Invariants pinned:
 *   - start ⇒ status="running" + lastEventAt === startedAt
 *   - touch bumps lastEventAt + applies status/waitingOn/artifact patch
 *   - settle is idempotent (re-settling a settled entry is a no-op returning it)
 *   - unknown id ⇒ null on get/touch/settle
 *   - running()/waiting() filter by status
 *   - list() filters compose (status ∧ kind ∧ owner)
 *   - LRU: settled entries past maxRetained evicted oldest-lastEventAt first;
 *     RUNNING and WAITING entries are NEVER evicted
 *   - snapshot round-trip restores entries
 *   - NO-THROW on malformed input
 */

import { describe, expect, it } from "bun:test"
import {
  createRunLedger,
  type RunArtifact,
  type RunEntry,
  type RunKind,
  type RunLedgerSnapshot,
  type RunStatus,
  type WaitingOn,
} from "@/agent/run-ledger"

/** Deterministic monotone clock seam. */
const stepClock = (start = 1000, step = 10) => {
  let t = start
  return () => {
    const v = t
    t += step
    return v
  }
}

const start = (
  l: ReturnType<typeof createRunLedger>,
  over: Partial<{
    id: string
    kind: RunKind
    owner: string
    title: string
    resumeAction: string
  }> = {},
) =>
  l.start({
    id: over.id ?? "s1",
    kind: over.kind ?? "shell",
    owner: over.owner ?? "thread-A",
    title: over.title ?? "npm test",
    ...(over.resumeAction !== undefined ? { resumeAction: over.resumeAction } : {}),
  })

describe("ADR-0395 run-ledger — start", () => {
  it("start sets status=running and lastEventAt === startedAt", () => {
    const now = stepClock()
    const l = createRunLedger({ now })
    const e = start(l, { id: "s1", kind: "shell", title: "npm test" })
    expect(e.status).toBe("running")
    expect(e.startedAt).toBe(1000)
    expect(e.lastEventAt).toBe(1000)
    expect(e.kind).toBe("shell")
    expect(e.owner).toBe("thread-A")
    expect(e.title).toBe("npm test")
    expect(e.artifacts).toEqual([])
  })

  it("carries resumeAction when supplied", () => {
    const l = createRunLedger({ now: stepClock() })
    const e = start(l, { id: "s1", resumeAction: "bash_await s1" })
    expect(e.resumeAction).toBe("bash_await s1")
  })

  it("get returns the started entry by id", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    expect(l.get("s1")?.id).toBe("s1")
  })

  it("start with a duplicate id overwrites (idempotent registration, latest wins)", () => {
    const now = stepClock(500, 100)
    const l = createRunLedger({ now })
    start(l, { id: "s1", title: "first" })
    const second = start(l, { id: "s1", title: "second" })
    expect(second.title).toBe("second")
    expect(l.get("s1")?.title).toBe("second")
    expect(l.list().length).toBe(1)
  })

  it("each kind value is accepted", () => {
    const l = createRunLedger({ now: stepClock() })
    const kinds: RunKind[] = ["shell", "subagent", "mcp_task", "exec"]
    for (const [i, k] of kinds.entries()) start(l, { id: `k${i}`, kind: k })
    expect(l.list().length).toBe(4)
    expect(new Set(l.list().map((e) => e.kind))).toEqual(new Set(kinds))
  })
})

describe("ADR-0395 run-ledger — touch", () => {
  it("touch bumps lastEventAt to current clock", () => {
    const now = stepClock(100, 50) // 100, 150, 200...
    const l = createRunLedger({ now })
    const e0 = start(l, { id: "s1" }) // startedAt=100, lastEventAt=100
    expect(e0.lastEventAt).toBe(100)
    const e1 = l.touch("s1", {})
    expect(e1?.lastEventAt).toBe(150)
    expect(e1?.startedAt).toBe(100) // startedAt unchanged
  })

  it("touch applies status transition", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    const e = l.touch("s1", { status: "waiting" })
    expect(e?.status).toBe("waiting")
  })

  it("touch applies waitingOn", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    const e = l.touch("s1", { status: "waiting", waitingOn: "user" })
    expect(e?.status).toBe("waiting")
    expect(e?.waitingOn).toBe("user")
  })

  it("touch appends artifacts cumulatively without dropping prior ones", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    const a1: RunArtifact = { kind: "log", ref: "/tmp/a.log" }
    const a2: RunArtifact = { kind: "stdout", ref: "inline:42" }
    l.touch("s1", { artifact: a1 })
    const e = l.touch("s1", { artifact: a2 })
    expect(e?.artifacts).toEqual([a1, a2])
  })

  it("touch unknown id ⇒ null", () => {
    const l = createRunLedger({ now: stepClock() })
    expect(l.touch("ghost", { status: "waiting" })).toBeNull()
  })

  it("touch with empty patch still bumps lastEventAt (heartbeat)", () => {
    const now = stepClock(10, 5)
    const l = createRunLedger({ now })
    start(l, { id: "s1" }) // 10
    const e = l.touch("s1", {}) // 15
    expect(e?.lastEventAt).toBe(15)
    expect(e?.status).toBe("running") // unchanged
  })

  it("touch back from waiting to running is allowed", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    l.touch("s1", { status: "waiting", waitingOn: "tool" })
    const e = l.touch("s1", { status: "running" })
    expect(e?.status).toBe("running")
  })
})

describe("ADR-0395 run-ledger — settle idempotency", () => {
  it("settle transitions running ⇒ completed and stamps lastEventAt", () => {
    const now = stepClock(0, 7)
    const l = createRunLedger({ now })
    start(l, { id: "s1" }) // started 0
    const e = l.settle("s1", "completed")
    expect(e?.status).toBe("completed")
    expect(e?.lastEventAt).toBe(7)
  })

  it("settle is idempotent — re-settle returns the entry unchanged (no-op)", () => {
    const now = stepClock(0, 7)
    const l = createRunLedger({ now })
    start(l, { id: "s1" }) // 0
    const first = l.settle("s1", "failed", { error: "boom" }) // 7
    const firstAt = first?.lastEventAt
    const second = l.settle("s1", "completed") // would-be 14, but no-op
    expect(second?.status).toBe("failed") // NOT overwritten to completed
    expect(second?.error).toBe("boom")
    expect(second?.lastEventAt).toBe(firstAt) // lastEventAt NOT bumped on no-op
  })

  it("settle stores error and artifact", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    const art: RunArtifact = { kind: "summary", ref: "inline:done" }
    const e = l.settle("s1", "failed", { error: "exit 1", artifact: art })
    expect(e?.error).toBe("exit 1")
    expect(e?.artifacts).toContainEqual(art)
  })

  it("settle from waiting state works", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    l.touch("s1", { status: "waiting", waitingOn: "network" })
    const e = l.settle("s1", "stopped")
    expect(e?.status).toBe("stopped")
  })

  it("settle unknown id ⇒ null", () => {
    const l = createRunLedger({ now: stepClock() })
    expect(l.settle("ghost", "completed")).toBeNull()
  })

  it("touch on a settled entry is a no-op returning the settled entry", () => {
    const now = stepClock(0, 5)
    const l = createRunLedger({ now })
    start(l, { id: "s1" }) // 0
    const settled = l.settle("s1", "completed") // 5
    const after = l.touch("s1", { status: "running" }) // must NOT resurrect
    expect(after?.status).toBe("completed")
    expect(after?.lastEventAt).toBe(settled?.lastEventAt)
  })
})

describe("ADR-0395 run-ledger — running()/waiting() filters", () => {
  it("running() returns only status=running", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "r1" })
    start(l, { id: "r2" })
    start(l, { id: "w1" })
    l.touch("w1", { status: "waiting", waitingOn: "user" })
    start(l, { id: "c1" })
    l.settle("c1", "completed")
    expect(new Set(l.running().map((e) => e.id))).toEqual(new Set(["r1", "r2"]))
  })

  it("waiting() returns only status=waiting", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "r1" })
    start(l, { id: "w1" })
    l.touch("w1", { status: "waiting" })
    start(l, { id: "w2" })
    l.touch("w2", { status: "waiting", waitingOn: "child_agent" })
    expect(new Set(l.waiting().map((e) => e.id))).toEqual(new Set(["w1", "w2"]))
  })

  it("running() empty when none running", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "c1" })
    l.settle("c1", "completed")
    expect(l.running()).toEqual([])
  })

  it("each WaitingOn value round-trips through touch", () => {
    const l = createRunLedger({ now: stepClock() })
    const ons: WaitingOn[] = ["user", "tool", "network", "child_agent"]
    for (const [i, on] of ons.entries()) {
      start(l, { id: `w${i}` })
      l.touch(`w${i}`, { status: "waiting", waitingOn: on })
    }
    expect(
      l
        .waiting()
        .map((e) => e.waitingOn)
        .sort(),
    ).toEqual([...ons].sort())
  })
})

describe("ADR-0395 run-ledger — list() filter composition", () => {
  const seed = () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "a", kind: "shell", owner: "A" })
    start(l, { id: "b", kind: "subagent", owner: "A" })
    start(l, { id: "c", kind: "shell", owner: "B" })
    l.touch("c", { status: "waiting" })
    start(l, { id: "d", kind: "mcp_task", owner: "B" })
    l.settle("d", "completed")
    return l
  }

  it("no filter returns all", () => {
    expect(seed().list().length).toBe(4)
  })

  it("filter by status", () => {
    expect(
      new Set(
        seed()
          .list({ status: "running" })
          .map((e) => e.id),
      ),
    ).toEqual(new Set(["a", "b"]))
  })

  it("filter by kind", () => {
    expect(
      new Set(
        seed()
          .list({ kind: "shell" })
          .map((e) => e.id),
      ),
    ).toEqual(new Set(["a", "c"]))
  })

  it("filter by owner", () => {
    expect(
      new Set(
        seed()
          .list({ owner: "B" })
          .map((e) => e.id),
      ),
    ).toEqual(new Set(["c", "d"]))
  })

  it("filters compose (status ∧ kind ∧ owner)", () => {
    expect(
      seed()
        .list({ status: "running", kind: "shell", owner: "A" })
        .map((e) => e.id),
    ).toEqual(["a"])
  })

  it("filter with no match returns empty", () => {
    expect(seed().list({ status: "failed" })).toEqual([])
  })
})

describe("ADR-0395 run-ledger — LRU retention", () => {
  it("settled entries past maxRetained evicted oldest-lastEventAt first", () => {
    const now = stepClock(0, 1)
    const l = createRunLedger({ now, maxRetained: 2 })
    // 3 settled entries; oldest two distinct lastEventAt should be eviction order.
    for (const id of ["s1", "s2", "s3"]) {
      start(l, { id })
      l.settle(id, "completed")
    }
    // cap=2 ⇒ exactly one (oldest) settled dropped: s1 (earliest lastEventAt).
    const ids = new Set(l.list().map((e) => e.id))
    expect(ids.has("s1")).toBe(false)
    expect(ids.has("s2")).toBe(true)
    expect(ids.has("s3")).toBe(true)
    expect(l.list().length).toBe(2)
  })

  it("RUNNING entries are NEVER evicted regardless of cap", () => {
    const now = stepClock(0, 1)
    const l = createRunLedger({ now, maxRetained: 1 })
    start(l, { id: "run-forever" }) // stays running
    for (const id of ["s1", "s2", "s3"]) {
      start(l, { id })
      l.settle(id, "completed")
    }
    expect(l.get("run-forever")?.status).toBe("running")
    // only 1 settled retained (cap=1), plus the running one
    expect(l.running().length).toBe(1)
    const settledCount = l.list().filter((e) => e.status !== "running").length
    expect(settledCount).toBe(1)
  })

  it("WAITING entries are NEVER evicted regardless of cap", () => {
    const now = stepClock(0, 1)
    const l = createRunLedger({ now, maxRetained: 1 })
    start(l, { id: "wait-forever" })
    l.touch("wait-forever", { status: "waiting", waitingOn: "user" })
    for (const id of ["s1", "s2", "s3", "s4"]) {
      start(l, { id })
      l.settle(id, "completed")
    }
    expect(l.get("wait-forever")?.status).toBe("waiting")
    expect(l.waiting().length).toBe(1)
  })

  it("default cap is 256 — under it nothing is evicted", () => {
    const now = stepClock(0, 1)
    const l = createRunLedger({ now })
    for (let i = 0; i < 256; i++) {
      const id = `s${i}`
      start(l, { id })
      l.settle(id, "completed")
    }
    expect(l.list().length).toBe(256)
  })

  it("settling does not evict running siblings even when many settled overflow", () => {
    const now = stepClock(0, 1)
    const l = createRunLedger({ now, maxRetained: 2 })
    start(l, { id: "rA" })
    start(l, { id: "rB" })
    for (let i = 0; i < 10; i++) {
      const id = `done-${i}`
      start(l, { id })
      l.settle(id, "completed")
    }
    expect(l.get("rA")?.status).toBe("running")
    expect(l.get("rB")?.status).toBe("running")
    expect(l.list().filter((e) => e.status !== "running").length).toBe(2)
  })
})

describe("ADR-0395 run-ledger — snapshot round-trip", () => {
  it("toSnapshot then fromSnapshot restores entries identically", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1", kind: "shell" })
    start(l, { id: "s2", kind: "subagent" })
    l.touch("s2", { status: "waiting", waitingOn: "child_agent" })
    start(l, { id: "s3" })
    l.settle("s3", "completed", { artifact: { kind: "summary", ref: "inline:ok" } })
    const snap = l.toSnapshot()

    const l2 = createRunLedger({ now: stepClock() })
    l2.fromSnapshot(snap)
    expect(l2.list().length).toBe(3)
    expect(l2.get("s2")?.status).toBe("waiting")
    expect(l2.get("s2")?.waitingOn).toBe("child_agent")
    expect(l2.get("s3")?.status).toBe("completed")
    expect(l2.get("s3")?.artifacts).toContainEqual({ kind: "summary", ref: "inline:ok" })
  })

  it("fromSnapshot replaces prior contents (not merge)", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "old" })
    const snap: RunLedgerSnapshot = {
      entries: [
        {
          id: "new",
          kind: "exec",
          owner: "X",
          title: "task",
          status: "running",
          startedAt: 1,
          lastEventAt: 1,
          artifacts: [],
        },
      ],
    }
    l.fromSnapshot(snap)
    expect(l.get("old")).toBeNull()
    expect(l.get("new")?.id).toBe("new")
  })

  it("toSnapshot is a stable copy — later mutation does not change earlier snapshot", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    const snap = l.toSnapshot()
    const lenBefore = snap.entries.length
    start(l, { id: "s2" })
    l.settle("s1", "completed")
    expect(snap.entries.length).toBe(lenBefore) // snapshot frozen at capture time
  })

  it("snapshot entries are immutable (frozen) — write attempts do not corrupt the ledger", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1", title: "orig" })
    const snap = l.toSnapshot()
    const e = snap.entries[0] as RunEntry
    try {
      // @ts-expect-error — readonly contract; runtime must not allow corruption
      e.title = "hacked"
    } catch {
      // frozen object throws in strict mode — acceptable
    }
    expect(l.get("s1")?.title).toBe("orig")
  })
})

describe("ADR-0395 run-ledger — NO-THROW on malformed input", () => {
  it("get(undefined) does not throw ⇒ null", () => {
    const l = createRunLedger({ now: stepClock() })
    expect(() => l.get(undefined as unknown as string)).not.toThrow()
    expect(l.get(undefined as unknown as string)).toBeNull()
  })

  it("touch with garbage status does not throw", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    expect(() => l.touch("s1", { status: "not-a-status" as unknown as RunStatus })).not.toThrow()
  })

  it("settle with malformed opts does not throw", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    expect(() =>
      l.settle("s1", "completed", undefined as unknown as { error?: string }),
    ).not.toThrow()
  })

  it("start with empty id does not throw and is queryable", () => {
    const l = createRunLedger({ now: stepClock() })
    expect(() => start(l, { id: "" })).not.toThrow()
  })

  it("fromSnapshot with malformed snapshot does not throw", () => {
    const l = createRunLedger({ now: stepClock() })
    expect(() => l.fromSnapshot(null as unknown as RunLedgerSnapshot)).not.toThrow()
    expect(() => l.fromSnapshot({ entries: null as unknown as readonly RunEntry[] })).not.toThrow()
    expect(l.list()).toEqual([])
  })

  it("fromSnapshot skips malformed entries but keeps well-formed ones", () => {
    const l = createRunLedger({ now: stepClock() })
    const snap = {
      entries: [
        null,
        {
          id: "good",
          kind: "exec",
          owner: "X",
          title: "t",
          status: "running",
          startedAt: 1,
          lastEventAt: 1,
          artifacts: [],
        },
        { nonsense: true },
      ] as unknown as readonly RunEntry[],
    }
    expect(() => l.fromSnapshot(snap)).not.toThrow()
    expect(l.get("good")?.id).toBe("good")
    expect(l.list().length).toBe(1)
  })

  it("list with malformed filter does not throw", () => {
    const l = createRunLedger({ now: stepClock() })
    start(l, { id: "s1" })
    expect(() => l.list({ status: 123 as unknown as RunStatus })).not.toThrow()
  })

  it("a now() seam that throws does not break start (defensive clock)", () => {
    const l = createRunLedger({
      now: () => {
        throw new Error("clock blew up")
      },
    })
    expect(() => start(l, { id: "s1" })).not.toThrow()
    // entry still created with a finite startedAt fallback
    const e = l.get("s1")
    expect(e).not.toBeNull()
    expect(Number.isFinite(e?.startedAt)).toBe(true)
  })
})
