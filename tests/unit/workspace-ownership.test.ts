import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isTerminalWorkspaceState,
  isValidWorkspaceTransition,
  loadSessionById,
  makeWorkspaceCreateIntent,
  type SessionMeta,
  saveSessionById,
  staticSessionRootProvider,
  transitionWorkspaceState,
  WORKSPACE_OWNERSHIP_VERSION,
  type WorkspaceOwnership,
  type WorkspaceOwnershipState,
  workspaceOwnershipSchema,
} from "@/session"

/* RFC-06 §RFC06-0 — persisted WorkspaceOwnership: schema, closed lifecycle
 * transition rule, and restart-durability round-trip through the EXISTING
 * atomic snapshot. No new store — proves ownership survives a reload. */

const intentFacts = {
  ownershipId: "own-1",
  ownerThreadId: "thread-1",
  repoRoot: "/abs/repo",
  repoId: "origin://repo",
  path: "/abs/repo/.quanta/worktrees/own-1",
  branch: "fork-own-1",
  baseSha: "deadbeefcafe",
}

const makeMeta = (id: string, ownership?: WorkspaceOwnership): SessionMeta => ({
  id,
  title: "t",
  cwd: intentFacts.path,
  createdAt: 100,
  lastTouched: 100,
  archived: false,
  ...(ownership !== undefined ? { workspaceOwnership: ownership } : {}),
})

describe("workspaceOwnershipSchema (fail-closed migration)", () => {
  const base = makeWorkspaceCreateIntent({ ...intentFacts, now: 1000 })

  test("accepts a well-formed creating record", () => {
    const parsed = workspaceOwnershipSchema.safeParse(base)
    expect(parsed.success).toBe(true)
  })

  test("fail-closes on an UNKNOWN recordVersion (never half-read)", () => {
    const forward = { ...base, recordVersion: 999 }
    const parsed = workspaceOwnershipSchema.safeParse(forward)
    expect(parsed.success).toBe(false)
  })

  test("fail-closes on an UNKNOWN lifecycle state", () => {
    const bogus = { ...base, state: "adopted" }
    const parsed = workspaceOwnershipSchema.safeParse(bogus)
    expect(parsed.success).toBe(false)
  })

  test("fail-closes on a blank path/branch/ownershipId (corrupt target)", () => {
    for (const field of ["path", "branch", "ownershipId"] as const) {
      const corrupt = { ...base, [field]: "" }
      const parsed = workspaceOwnershipSchema.safeParse(corrupt)
      expect(parsed.success).toBe(false)
    }
  })

  test("makeWorkspaceCreateIntent stamps version + creating state + clock", () => {
    expect(base.recordVersion).toBe(WORKSPACE_OWNERSHIP_VERSION)
    expect(base.state).toBe("creating")
    expect(base.createdAt).toBe(1000)
    expect(base.updatedAt).toBe(1000)
    // identity is caller-supplied, never derived from PID/path.
    expect(base.ownershipId).toBe("own-1")
    expect(base.ownerThreadId).toBe("thread-1")
  })
})

describe("closed lifecycle transition rule", () => {
  const base = makeWorkspaceCreateIntent({ ...intentFacts, now: 1000 })

  test("creating → ready is valid and stamps updatedAt (create effect published)", () => {
    const r = transitionWorkspaceState(base, "ready", 2000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.record.state).toBe("ready")
      expect(r.record.updatedAt).toBe(2000)
      expect(r.record.createdAt).toBe(1000) // unchanged
    }
  })

  test("REJECTS creating → active (must publish ready first — no skipping intent effect)", () => {
    const r = transitionWorkspaceState(base, "active", 2000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("invalid transition")
  })

  test("REJECTS a repeated/self transition (must observe a real state change)", () => {
    const r = transitionWorkspaceState(base, "creating", 2000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("repeated")
  })

  test("REJECTS resurrection from a terminal state (removed → ready)", () => {
    const removed = transitionWorkspaceState(
      transitionWorkspaceState(base, "closing", 2000).ok
        ? (transitionWorkspaceState(base, "closing", 2000) as { record: WorkspaceOwnership }).record
        : base,
      "removed",
      3000,
    )
    expect(removed.ok).toBe(true)
    if (removed.ok) {
      expect(isTerminalWorkspaceState(removed.record.state)).toBe(true)
      const resurrect = transitionWorkspaceState(removed.record, "ready", 4000)
      expect(resurrect.ok).toBe(false)
    }
  })

  test("failed carries the errorCode; quarantined reachable from creating", () => {
    const failed = transitionWorkspaceState(base, "failed", 2000, "git_add_failed")
    expect(failed.ok).toBe(true)
    if (failed.ok) expect(failed.record.lastErrorCode).toBe("git_add_failed")
    const quar = transitionWorkspaceState(base, "quarantined", 2000, "ambiguous_crash")
    expect(quar.ok).toBe(true)
    if (quar.ok) expect(quar.record.state).toBe("quarantined")
  })

  test("isValidWorkspaceTransition table is anti-vacuous (a known-bad pair is false)", () => {
    // If the table were a tautology (everything true), this would fail — proves
    // the guard actually discriminates.
    expect(isValidWorkspaceTransition("creating", "ready")).toBe(true)
    expect(isValidWorkspaceTransition("removed", "active")).toBe(false)
    expect(isValidWorkspaceTransition("active", "creating")).toBe(false)
  })

  test("every terminal state has zero outgoing transitions", () => {
    const terminals: WorkspaceOwnershipState[] = ["removed", "failed", "quarantined"]
    for (const s of terminals) expect(isTerminalWorkspaceState(s)).toBe(true)
    const nonTerminals: WorkspaceOwnershipState[] = ["creating", "ready", "active", "closing"]
    for (const s of nonTerminals) expect(isTerminalWorkspaceState(s)).toBe(false)
  })
})

describe("restart durability round-trip (existing atomic snapshot, no new store)", () => {
  const withRoot = async (
    fn: (provider: ReturnType<typeof staticSessionRootProvider>) => Promise<void>,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "wo-root-"))
    try {
      await fn(staticSessionRootProvider(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("ownership survives save → reload (restart reconciliation input)", async () => {
    await withRoot(async (provider) => {
      const ownership = transitionWorkspaceState(
        makeWorkspaceCreateIntent({ ...intentFacts, now: 1000 }),
        "ready",
        2000,
      )
      expect(ownership.ok).toBe(true)
      if (!ownership.ok) return
      const meta = makeMeta("sess-a", ownership.record)
      await saveSessionById(meta, { reason: "x", turns: 1, messages: [] }, provider)

      const loaded = await loadSessionById("sess-a", provider)
      expect(loaded).toBeDefined()
      expect(loaded?.meta.workspaceOwnership).toBeDefined()
      expect(loaded?.meta.workspaceOwnership?.ownershipId).toBe("own-1")
      expect(loaded?.meta.workspaceOwnership?.state).toBe("ready")
      expect(loaded?.meta.workspaceOwnership?.branch).toBe("fork-own-1")
      expect(loaded?.meta.workspaceOwnership?.path).toBe(intentFacts.path)
    })
  })

  test("a session that never owned a worktree serializes WITHOUT the field (byte-identical)", async () => {
    await withRoot(async (provider) => {
      const meta = makeMeta("sess-b")
      await saveSessionById(meta, { reason: "x", turns: 0, messages: [] }, provider)
      const path = join(await provider.resolve(), "sess-b.json")
      const raw = await Bun.file(path).text()
      expect(raw).not.toContain("workspaceOwnership")
      const loaded = await loadSessionById("sess-b", provider)
      expect(loaded?.meta.workspaceOwnership).toBeUndefined()
    })
  })

  test("a snapshot carrying an UNKNOWN ownership state fail-closes the whole load", async () => {
    await withRoot(async (provider) => {
      const path = join(await provider.resolve(), "sess-c.json")
      const poisoned = {
        version: 2,
        meta: {
          ...makeMeta("sess-c"),
          workspaceOwnership: {
            ...makeWorkspaceCreateIntent({ ...intentFacts, now: 1000 }),
            state: "adopted", // unknown → fail closed
          },
        },
        reason: "x",
        turns: 0,
        messages: [],
      }
      await Bun.write(path, JSON.stringify(poisoned))
      const loaded = await loadSessionById("sess-c", provider)
      // Whole file refused — NOT partially applied with the field stripped.
      expect(loaded).toBeUndefined()
    })
  })
})
