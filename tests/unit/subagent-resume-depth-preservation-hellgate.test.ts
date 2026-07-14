/**
 * Subagent resume DEPTH-PRESERVATION hellgate — INV-09 / INV-10.
 *
 * Context (traced re-derivation path):
 *   resumer.ts:~291  scheduler.fork(buildResumedSpec(handle, replayMetadata))
 *     → subagent-background/engine.ts:257  specToRequest(spec, signal, parentDepth)
 *          where `parentDepth` is captured at scheduler CONSTRUCTION
 *          (engine.ts:287 `opts.parentDepth ?? 0`), NOT from the persisted handle
 *     → subagent-background.ts:331  req.depth = parentDepth + 1        (ADVISORY)
 *     → subagent-runner.ts:654  depth: childDepthOf(parent)            (AUTHORITY)
 *
 * So a resumed child's REAL depth is re-derived from the RESUME-TIME parent,
 * never the depth the child originally ran at. Under cap>=2 a persisted
 * depth-2 child could be re-derived to a shallower depth and gain spawn
 * authority it should not have.
 *
 * Because the runner's depth authority is `childDepthOf(resume-time-parent)`
 * (fixed by the injected scheduler's construction-time parentDepth) and the
 * resumer's ONLY seam is `scheduler.fork(spec)` (req.depth is advisory-only),
 * the resumer CANNOT force the fork to run at the persisted depth. The
 * fail-closed lever it DOES own: compare the persisted lineage depth against
 * the depth the injected scheduler will actually run a resumed fork at
 * (`lineageGuard.resumeForkDepth`) and DENY the auto-resume on any divergence.
 *
 *   INV-09: persisted depth != resumeForkDepth  → DENY (would re-derive; a
 *           shallower re-derivation grants spawn authority).
 *   INV-10: persisted depth ABSENT (legacy record) → DENY (fail-closed; do NOT
 *           silently resume at the re-derived — possibly root — depth).
 *
 * Default-OFF: when `lineageGuard` is ABSENT the orchestrator is byte-identical
 * to the pre-INV-09 path (the shipping cap=1 path never sets a guard).
 */

import { describe, expect, test } from "bun:test"
import type {
  BackgroundSubagentScheduler,
  SubagentHandleId,
  SubagentResult,
  SubagentSpec,
} from "@/agent/subagent-background"
import type { PersistedHandle, PersistentSchedulerStore } from "@/agent/subagent-persistence-store"
import { alwaysResumePolicy, resumeInterruptedHandles } from "@/agent/subagent-resume"

/* ====================================================================== */
/* fakes                                                                   */
/* ====================================================================== */

const mkHandle = (over: Partial<PersistedHandle> & { id: string }): PersistedHandle => ({
  id: over.id,
  spec: over.spec ?? { task: "saved" },
  status: over.status ?? "interrupted",
  startedAt: over.startedAt ?? 1000,
  turns: over.turns ?? 0,
  outputSummary: over.outputSummary ?? "(interrupted)",
  workspace: over.workspace ?? "/ws/R",
  ...(over.depth !== undefined ? { depth: over.depth } : {}),
  ...(over.endedAt !== undefined ? { endedAt: over.endedAt } : {}),
})

interface FakeScheduler {
  scheduler: BackgroundSubagentScheduler
  forks: SubagentSpec[]
}

const fakeScheduler = (): FakeScheduler => {
  const forks: SubagentSpec[] = []
  let counter = 0
  const scheduler: BackgroundSubagentScheduler = {
    fork(spec) {
      forks.push(spec)
      counter += 1
      return `bg-new-${counter.toString().padStart(4, "0")}` as SubagentHandleId
    },
    poll: (): SubagentResult | null => null,
    await: async (): Promise<SubagentResult | null> => null,
    cancel: (): boolean => false,
    list: () => [],
    prune: (): number => 0,
    serialize: (): string => "",
    hydrate: (): number => 0,
    hydrateWithPrune: () => ({ restored: 0, pruned: 0 }),
    forceBackground: () => "not_found",
  }
  return { scheduler, forks }
}

const fakeStore = (
  handles: PersistedHandle[],
): PersistentSchedulerStore & { saved: PersistedHandle[] } => {
  const saved: PersistedHandle[] = []
  return {
    saved,
    async save(h) {
      saved.push(h)
    },
    async load() {
      return null
    },
    async list() {
      return handles
    },
    async delete() {},
    async prune() {
      return 0
    },
  }
}

/* ====================================================================== */
/* codec round-trip (types + jsonl)                                        */
/* ====================================================================== */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultJsonlSchedulerStore } from "@/agent/subagent-persistence-store"

describe("PersistedHandle.depth codec round-trip", () => {
  test("depth survives save → list (jsonl codec preserves the lineage depth)", async () => {
    const base = await mkdtemp(join(tmpdir(), "resume-depth-"))
    try {
      const store = defaultJsonlSchedulerStore({ baseDir: base })
      const h = mkHandle({ id: "bg-d2", depth: 2, workspace: "/ws/D", status: "interrupted" })
      await store.save(h)
      const back = await store.list("/ws/D")
      expect(back).toHaveLength(1)
      // RED before impl: parseHandle drops the depth field.
      expect(back[0]?.depth).toBe(2)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("legacy record with NO depth still parses (backward compatible)", async () => {
    const base = await mkdtemp(join(tmpdir(), "resume-depth-"))
    try {
      const store = defaultJsonlSchedulerStore({ baseDir: base })
      const h = mkHandle({ id: "bg-legacy", workspace: "/ws/L", status: "interrupted" })
      await store.save(h)
      const back = await store.list("/ws/L")
      expect(back).toHaveLength(1)
      expect(back[0]?.id).toBe("bg-legacy")
      expect(back[0]?.depth).toBeUndefined()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

/* ====================================================================== */
/* CODEC FAIL-CLOSED TRUTH TABLE — parseHandle read-path (jsonl-store.ts)   */
/*                                                                          */
/* The lever under test is the READ-path guard in `parseHandle`:            */
/*   ...(typeof r.depth === "number" && Number.isInteger(r.depth)           */
/*        && r.depth >= 0 ? { depth: r.depth } : {})                        */
/* We exercise it through the REAL jsonl store by writing RAW JSONL lines    */
/* (so we can express malformed depths JSON.stringify would otherwise       */
/* normalise) and reading them back via `store.list`. A fixed workspace     */
/* hasher pins the on-disk directory so we can drop raw per-handle files.   */
/*                                                                          */
/* Every REJECT case asserts BOTH depth===undefined AND that the rest of    */
/* the handle still parsed (the malformed depth is DROPPED, not the whole   */
/* record) — proving fail-CLOSED-on-depth, not fail-loud-drop-everything.   */
/* ====================================================================== */

import { mkdir, writeFile } from "node:fs/promises"

const FIXED_HASH = "codecfixedhash00"

/** Build a raw JSONL object line with `depth` spliced in verbatim (so callers
 *  can inject values `JSON.stringify` would rewrite, e.g. a bare `null`). When
 *  `depthLiteral` is undefined the `depth` key is omitted entirely (legacy). */
const rawHandleLine = (id: string, depthLiteral: string | undefined): string => {
  const fields: string[] = [
    `"id":${JSON.stringify(id)}`,
    `"spec":{"task":"codec"}`,
    `"status":"interrupted"`,
    `"startedAt":1000`,
    `"turns":0`,
    `"outputSummary":"(codec)"`,
    `"workspace":"/ws/codec"`,
  ]
  if (depthLiteral !== undefined) fields.push(`"depth":${depthLiteral}`)
  return `{${fields.join(",")}}\n`
}

describe("CODEC fail-closed truth table — PersistedHandle.depth read path", () => {
  test("ACCEPT: non-negative integers round-trip (0, and a large int); REJECT: NaN/Inf/neg/frac/string/null → depth ABSENT (rest of handle intact)", async () => {
    const base = await mkdtemp(join(tmpdir(), "resume-depth-codec-"))
    try {
      const store = defaultJsonlSchedulerStore({
        baseDir: base,
        workspaceHasher: () => FIXED_HASH,
      })
      const dir = join(base, FIXED_HASH)
      await mkdir(dir, { recursive: true })

      // id → { depthLiteral written raw, expected depth after read } .
      // NaN / Infinity are not valid JSON literals, so a producer that tried to
      // stringify them lands `null` on disk (JSON.stringify(NaN)==="null"); we
      // assert that `null` reads back as ABSENT — the exact fail-closed the
      // codec owes. A distinct `"NaN"`/`"Infinity"` string literal is a further
      // string-typed reject case.
      const cases: ReadonlyArray<{
        id: string
        raw: string
        expect: number | undefined
      }> = [
        { id: "bg-accept-zero", raw: "0", expect: 0 }, // root boundary
        { id: "bg-accept-one", raw: "1", expect: 1 },
        { id: "bg-accept-large", raw: "9007199254740991", expect: 9007199254740991 },
        { id: "bg-rej-neg", raw: "-1", expect: undefined },
        { id: "bg-rej-neg-big", raw: "-42", expect: undefined },
        { id: "bg-rej-frac", raw: "1.5", expect: undefined },
        { id: "bg-rej-frac-small", raw: "0.0001", expect: undefined },
        { id: "bg-rej-string-num", raw: '"2"', expect: undefined },
        { id: "bg-rej-string-nan", raw: '"NaN"', expect: undefined },
        { id: "bg-rej-string-inf", raw: '"Infinity"', expect: undefined },
        { id: "bg-rej-null", raw: "null", expect: undefined }, // == stringify(NaN|Inf)
        { id: "bg-rej-bool", raw: "true", expect: undefined },
        { id: "bg-rej-array", raw: "[2]", expect: undefined },
        { id: "bg-rej-object", raw: '{"n":2}', expect: undefined },
      ]

      for (const c of cases) {
        await writeFile(join(dir, `${c.id}.jsonl`), rawHandleLine(c.id, c.raw))
      }
      const back = await store.list("/ws/codec")
      const byId = new Map(back.map((h) => [h.id, h]))

      // Every case survived as a handle (fail-closed on DEPTH only, never on the
      // whole record). RED if a rejected depth aborted the parse (drop-record).
      expect(back).toHaveLength(cases.length)
      for (const c of cases) {
        const h = byId.get(c.id)
        expect(h).toBeDefined()
        // Rest-of-handle intact — proves the record parsed, only depth was gated.
        expect(h?.status).toBe("interrupted")
        expect(h?.spec.task).toBe("codec")
        // The load-bearing assertion. RED under any of these production mutations:
        //   - drop `Number.isInteger(r.depth)`   → 1.5 / 0.0001 leak through
        //   - drop `r.depth >= 0`                → -1 / -42 leak through
        //   - drop `typeof r.depth === "number"` → "2" / null / [2] leak through
        //   - relax to `r.depth != null`         → every reject leaks
        expect(h?.depth).toBe(c.expect)
      }
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("ROUND-TRIP via public save(): a producer's NaN/Infinity depth serialises to null and reads back ABSENT (fail-closed end-to-end)", async () => {
    const base = await mkdtemp(join(tmpdir(), "resume-depth-codec-rt-"))
    try {
      const store = defaultJsonlSchedulerStore({ baseDir: base })
      // Force a poisoned depth past the write-side omission by constructing the
      // handle object directly (the public port type says number; a buggy
      // producer could hand NaN). save() JSON.stringify's it → "null" on disk →
      // the read codec must fail-close it to ABSENT.
      const poisoned = {
        ...mkHandle({ id: "bg-nan", workspace: "/ws/NAN", status: "interrupted" }),
        depth: Number.NaN,
      } as PersistedHandle
      await store.save(poisoned)
      const backNan = await store.list("/ws/NAN")
      expect(backNan).toHaveLength(1)
      expect(backNan[0]?.id).toBe("bg-nan")
      // RED if the codec accepted a non-integer/NaN depth on read.
      expect(backNan[0]?.depth).toBeUndefined()

      const infPoisoned = {
        ...mkHandle({ id: "bg-inf", workspace: "/ws/INF", status: "interrupted" }),
        depth: Number.POSITIVE_INFINITY,
      } as PersistedHandle
      await store.save(infPoisoned)
      const backInf = await store.list("/ws/INF")
      expect(backInf).toHaveLength(1)
      expect(backInf[0]?.depth).toBeUndefined()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("WRITE-SIDE omission: liveToPersisted drops a non-integer/negative childDepth (defense-in-depth twin of the read guard)", async () => {
    // Capture through the REAL hydrating wrapper with a poisoned childDepth and
    // assert the persisted running snapshot has NO depth. RED if the wrapper's
    // liveToPersisted omission guard (Number.isInteger && >= 0) is weakened.
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { inner } = innerWithOneRunning()
      const store = capturingStore()
      const sched = await persistentBackgroundSubagentScheduler({
        inner,
        store,
        workspace: "/ws/cap",
        childDepth: bad,
      })
      sched.fork({ task: "work" })
      await Promise.resolve()
      await Promise.resolve()
      const running = store.saved.find((h) => h.status === "running")
      expect(running).toBeDefined()
      expect(running?.depth).toBeUndefined()
    }
  })
})

/* ====================================================================== */
/* PERSIST-TIME CAPTURE: hydrating-scheduler writes handle.depth            */
/* ====================================================================== */

import type {
  BackgroundSubagentScheduler as BgSched,
  SubagentHandleId as HId,
} from "@/agent/subagent-background"
import {
  type PersistentSchedulerStore as PStore,
  persistentBackgroundSubagentScheduler,
} from "@/agent/subagent-persistence-store"

/** A minimal in-memory inner scheduler whose `fork` immediately registers a
 *  running entry (so the wrapper's fork-time `saveLiveHandle` has a live record
 *  to project). `await` never settles within the test window — we only observe
 *  the fork-time running snapshot the wrapper persists. */
const innerWithOneRunning = (): { inner: BgSched; forkedId: HId } => {
  const id = "bg-cap-0001" as HId
  const spec: SubagentSpec = { task: "work" }
  const result: SubagentResult = {
    status: "running",
    outputSummary: "(running)",
    startedAt: 5000,
    turns: 0,
  }
  const entries = [{ id, spec, result }]
  const inner: BgSched = {
    fork: () => id,
    poll: (q) => (q === id ? result : null),
    await: () => new Promise<SubagentResult | null>(() => {}), // never settles
    cancel: () => false,
    list: () => entries,
    prune: () => 0,
    serialize: () => "",
    hydrate: () => 0,
    hydrateWithPrune: () => ({ restored: 0, pruned: 0 }),
    forceBackground: () => "not_found",
  }
  return { inner, forkedId: id }
}

const capturingStore = (): PStore & { saved: PersistedHandle[] } => {
  const saved: PersistedHandle[] = []
  return {
    saved,
    async save(h) {
      saved.push(h)
    },
    async load() {
      return null
    },
    async list() {
      return []
    },
    async delete() {},
    async prune() {
      return 0
    },
  }
}

describe("persist-time capture — hydrating scheduler records lineage depth", () => {
  test("RED before wire: fork persists handle.depth = injected childDepth", async () => {
    const { inner } = innerWithOneRunning()
    const store = capturingStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner,
      store,
      workspace: "/ws/cap",
      childDepth: 2, // the REAL depth bg children run at (= parentDepth+1)
    })
    sched.fork({ task: "work" })
    // Let the fire-and-forget fork-time save drain.
    await Promise.resolve()
    await Promise.resolve()
    const running = store.saved.find((h) => h.status === "running")
    expect(running).toBeDefined()
    // RED until liveToPersisted threads the injected childDepth.
    expect(running?.depth).toBe(2)
  })

  test("backward-compatible: no childDepth ⇒ handle.depth ABSENT", async () => {
    const { inner } = innerWithOneRunning()
    const store = capturingStore()
    const sched = await persistentBackgroundSubagentScheduler({
      inner,
      store,
      workspace: "/ws/cap",
      // childDepth omitted
    })
    sched.fork({ task: "work" })
    await Promise.resolve()
    await Promise.resolve()
    const running = store.saved.find((h) => h.status === "running")
    expect(running).toBeDefined()
    expect(running?.depth).toBeUndefined()
  })
})

describe("full round-trip — capture (wrapper+jsonl) → resume guard", () => {
  test("depth-2 child persisted via wrapper → matching resume allowed, divergent+legacy denied", async () => {
    const base = await mkdtemp(join(tmpdir(), "resume-depth-rt-"))
    try {
      const store = defaultJsonlSchedulerStore({ baseDir: base })
      // 1) Persist a bg child at depth 2 through the REAL hydrating wrapper +
      //    jsonl store (capture wire), then flip it to interrupted so the
      //    resumer will consider it.
      const { inner } = innerWithOneRunning()
      const sched = await persistentBackgroundSubagentScheduler({
        inner,
        store,
        workspace: "/ws/rt",
        childDepth: 2,
      })
      sched.fork({ task: "work" })
      // The wrapper's fork-time running save is fire-and-forget through an async
      // jsonl disk write; poll deterministically until it lands (bounded).
      let persistedRunning: PersistedHandle | null = null
      for (let i = 0; i < 200 && persistedRunning === null; i += 1) {
        persistedRunning = await store.load("bg-cap-0001")
        if (persistedRunning === null) await new Promise((r) => setTimeout(r, 5))
      }
      // Read back the running snapshot the wrapper persisted and assert depth
      // round-tripped through the jsonl codec.
      expect(persistedRunning?.depth).toBe(2)
      // Mark it interrupted (as hydration-on-restart would) so the resumer picks
      // it up — preserving the captured depth.
      await store.save({
        ...(persistedRunning as PersistedHandle),
        status: "interrupted",
        endedAt: 6000,
        outputSummary: "(interrupted)",
      })

      const forkSpy = fakeScheduler()

      // 2a) Resume under a scheduler whose resume-fork depth MATCHES (2) → allowed.
      const okOutcomes = await resumeInterruptedHandles({
        scheduler: forkSpy.scheduler,
        store,
        policy: alwaysResumePolicy,
        workspace: "/ws/rt",
        lineageGuard: { resumeForkDepth: 2 },
      })
      expect(okOutcomes).toHaveLength(1)
      expect(forkSpy.forks).toHaveLength(1)
      expect(okOutcomes[0]?.newId).toBeDefined()

      // Re-seed the interrupted record (the allowed resume flipped it to
      // "resumed") so the divergent/legacy legs start from interrupted again.
      const reseed = async (depth: number | undefined): Promise<void> => {
        await store.save({
          ...(persistedRunning as PersistedHandle),
          status: "interrupted",
          endedAt: 6000,
          outputSummary: "(interrupted)",
          ...(depth !== undefined ? { depth } : {}),
        })
      }

      // 2b) Divergent resume-fork depth (1) → DENIED, no fork.
      await reseed(2)
      const divergent = fakeScheduler()
      const divOutcomes = await resumeInterruptedHandles({
        scheduler: divergent.scheduler,
        store,
        policy: alwaysResumePolicy,
        workspace: "/ws/rt",
        lineageGuard: { resumeForkDepth: 1 },
      })
      expect(divergent.forks).toHaveLength(0)
      expect(divOutcomes[0]?.newId).toBeUndefined()
      expect(divOutcomes[0]?.errorMessage).toBeDefined()

      // 2c) Legacy (no depth) handle → DENIED even when resume-fork depth = 2.
      // Build a fresh legacy interrupted handle (jsonl codec drops depth when
      // absent — verified elsewhere).
      const legacyStore = fakeStore([mkHandle({ id: "bg-legacy-rt", status: "interrupted" })])
      const legacyFork = fakeScheduler()
      const legacyOutcomes = await resumeInterruptedHandles({
        scheduler: legacyFork.scheduler,
        store: legacyStore,
        policy: alwaysResumePolicy,
        workspace: "/ws/R",
        lineageGuard: { resumeForkDepth: 2 },
      })
      expect(legacyFork.forks).toHaveLength(0)
      expect(legacyOutcomes[0]?.errorMessage).toBeDefined()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

/* ====================================================================== */
/* INV-09: preserve persisted depth (deny divergent re-derivation)         */
/* ====================================================================== */

describe("INV-09 — resume preserves persisted lineage depth", () => {
  test("RED: persisted depth-2 resumed where fork would run at a SHALLOWER depth → DENIED (no fork)", async () => {
    // Persisted child ran at depth 2. The resume-time scheduler would fork at
    // depth 1 (shallower) — that grants spawn authority it should not have.
    const handle = mkHandle({ id: "bg-d2", depth: 2, status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      lineageGuard: { resumeForkDepth: 1 },
    })

    expect(outcomes).toHaveLength(1)
    // MUST NOT re-fork at a re-derived shallower depth.
    expect(fs.forks).toHaveLength(0)
    expect(outcomes[0]?.newId).toBeUndefined()
    expect(outcomes[0]?.errorMessage).toBeDefined()
    // OLD handle must NOT be flipped to "resumed".
    expect(store.saved).toHaveLength(0)
  })

  test("GREEN path: persisted depth-2 resumed where fork runs at EXACTLY depth 2 → RESUMED", async () => {
    const handle = mkHandle({ id: "bg-d2ok", depth: 2, status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      lineageGuard: { resumeForkDepth: 2 },
    })

    expect(outcomes).toHaveLength(1)
    expect(fs.forks).toHaveLength(1)
    expect(outcomes[0]?.newId).toBeDefined()
    expect(outcomes[0]?.errorMessage).toBeUndefined()
    // OLD flipped to resumed.
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]?.status).toBe("resumed")
  })

  test("depth-2 resumed where fork would run DEEPER (depth 3) → also DENIED (any divergence)", async () => {
    const handle = mkHandle({ id: "bg-d2deep", depth: 2, status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      lineageGuard: { resumeForkDepth: 3 },
    })

    expect(fs.forks).toHaveLength(0)
    expect(outcomes[0]?.newId).toBeUndefined()
    expect(outcomes[0]?.errorMessage).toBeDefined()
    // OLD handle must NOT be flipped to "resumed" on a DEEPER divergence either
    // (symmetric side-effect to the shallower leg). RED if the guard forks-then-
    // denies or writes markResumed before the depth check.
    expect(store.saved).toHaveLength(0)
  })
})

/* ====================================================================== */
/* INV-10: legacy no-depth handle → fail-closed (NOT root)                 */
/* ====================================================================== */

describe("INV-10 — legacy no-depth handle fails closed under a lineage guard", () => {
  test("no-depth handle + guard → DENIED (must NOT silently resume at re-derived/root depth)", async () => {
    const handle = mkHandle({ id: "bg-legacy", status: "interrupted" }) // NO depth
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
      // Even if the resume-time fork depth is 0 (root) — must NOT auto-resume.
      lineageGuard: { resumeForkDepth: 0 },
    })

    expect(fs.forks).toHaveLength(0)
    expect(outcomes[0]?.newId).toBeUndefined()
    expect(outcomes[0]?.errorMessage).toBeDefined()
    expect(store.saved).toHaveLength(0)
  })

  test("in-memory MALFORMED persisted depth (fractional) + guard → DENIED as legacy (resumer's own defense-in-depth, not just the codec)", async () => {
    // The codec fail-closes malformed depths on disk read, but an in-memory port
    // could hand the resumer a raw handle whose depth is a non-integer. The
    // resumer's lineageDenyReason has its OWN `Number.isInteger && >= 0` gate
    // (resumer.ts:282) that must treat such a value as ABSENT → INV-10 DENY,
    // NOT compare 1.5 === resumeForkDepth (which would be a silent allow-miss).
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const handle = { ...mkHandle({ id: "bg-badd", status: "interrupted" }), depth: bad }
      const fs = fakeScheduler()
      const store = fakeStore([handle])
      const outcomes = await resumeInterruptedHandles({
        scheduler: fs.scheduler,
        store,
        policy: alwaysResumePolicy,
        workspace: "/ws/R",
        // A guard whose depth EQUALS the malformed value's numeric form would
        // wrongly allow if the resumer skipped the integer gate.
        lineageGuard: { resumeForkDepth: bad },
      })
      expect(fs.forks).toHaveLength(0)
      expect(outcomes[0]?.newId).toBeUndefined()
      expect(outcomes[0]?.errorMessage).toBeDefined()
      expect(store.saved).toHaveLength(0)
    }
  })
})

/* ====================================================================== */
/* Default-OFF: no lineageGuard → byte-identical legacy resume             */
/* ====================================================================== */

describe("default-OFF — no lineageGuard preserves legacy behavior", () => {
  test("no guard: depth-2 handle still resumes (byte-identical to pre-INV-09)", async () => {
    const handle = mkHandle({ id: "bg-d2", depth: 2, status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
    })

    expect(fs.forks).toHaveLength(1)
    expect(outcomes[0]?.newId).toBeDefined()
  })

  test("no guard: legacy no-depth handle still resumes (unchanged)", async () => {
    const handle = mkHandle({ id: "bg-legacy", status: "interrupted" })
    const fs = fakeScheduler()
    const store = fakeStore([handle])

    const outcomes = await resumeInterruptedHandles({
      scheduler: fs.scheduler,
      store,
      policy: alwaysResumePolicy,
      workspace: "/ws/R",
    })

    expect(fs.forks).toHaveLength(1)
    expect(outcomes[0]?.newId).toBeDefined()
  })
})
