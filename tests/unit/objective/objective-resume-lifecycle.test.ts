/**
 * RFC-03 C2 (aug-22) — objective DURABLE-RESUME LIFECYCLE integration test.
 *
 * The roundtrip test (`persistence-roundtrip.test.ts`) proves the encode/decode
 * ADAPTER round-trips a snapshot when a caller MANUALLY wires
 * `encode → save → load → restoreFrom`. This test pins the SEPARATE, previously-
 * MISSING wire: the REAL CLI session lifecycle. It drives the ACTUAL production
 * functions —
 *
 *   • `resolveGatedObjectiveAuthority` — the ONE gated authority every surface
 *     builds (save-side: the `/goal` + `objective_*` authority; restore-side:
 *     the reopened authority),
 *   • `encodeObjectiveSnapshot` — what the turn-runner hands `persistTurn`,
 *   • `persistTurn` — the CLI id-mode per-turn auto-save (the durable write),
 *   • `resolveResume` — the CLI `--resume <id>` load,
 *
 * — so that a goal created in one process SURVIVES a fresh-runtime reopen.
 *
 * RED (pre-fix): `persistTurn` never attaches the objective, `resolveResume`
 * never returns it, and `resolveGatedObjectiveAuthority` ignores a restore
 * snapshot ⇒ the reopened authority is EMPTY (goal/criterion-id/revision/
 * provenance LOST). GREEN once the three production wires are threaded.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentOutcome } from "@/agent"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import { StructuredLogger } from "@/observability"
import { encodeObjectiveSnapshot } from "@/runner/assemble/session-authorities"
import { persistTurn, resolveResume } from "@/runner/orchestrate"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { seedObjective, settleUsage } from "./v2-helpers"

const slog = (): StructuredLogger => new StructuredLogger({ level: "info", sink: () => {} })

const OBJ_ENV = { QUANTA_OBJECTIVE_TOOLS: "1" } as Record<string, string | undefined>

const mkMeta = (id: string, cwd: string): SessionMeta => ({
  id,
  title: `T-${id}`,
  cwd,
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

const outcome = (): AgentOutcome => ({ reason: "completed", turns: 1, messages: [] })

describe("RFC-03 C2 — objective durable-resume LIFECYCLE (real production wires)", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "obj-resume-life-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  test("create objective → persistTurn save → resolveResume reopen → restore SURVIVES ids/revision/provenance", async () => {
    // --- SAVE SIDE: the ONE gated authority the CLI surface builds (`/goal`). ---
    const authority = resolveGatedObjectiveAuthority(OBJ_ENV, { confirmationAvailable: true })
    expect(authority).toBeDefined()
    if (authority === undefined) return

    authority.create("thr-1", {
      goal: "ship the feature",
      successCriteria: ["compiles", "tests pass"],
    })
    authority.setExplicitStatus("thr-1", "paused") // EXPLICIT provenance (must not default to active)
    // GOAL-01: usage is HOST-settled — bumps the per-thread revision like any mutation.
    settleUsage(authority, "thr-1", { tokens: 10 })
    authority.setNextActions("thr-1", ["wire it", "test it"])

    const critIds = authority.get("thr-1")?.successCriteria.map((c) => c.id) ?? []
    expect(critIds).toHaveLength(2)
    const objectiveId = authority.get("thr-1")?.objectiveId ?? ""
    expect(objectiveId).not.toBe("")
    // The snapshot the turn-runner encodes from the live authority.
    const expectedSnapshot = encodeObjectiveSnapshot(authority)

    // Mint the on-disk session (as `--new-session` would), then run the CLI
    // per-turn auto-save with the objective-snapshot provider the turn-runner
    // supplies. THIS is the production durable write.
    const idMeta = mkMeta("s-life", dir)
    await saveSessionById(idMeta, { reason: "fresh", turns: 0, messages: [] })
    await persistTurn({
      state: undefined,
      idMeta,
      sessionId: idMeta.id,
      messages: [],
      outcome: outcome(),
      objectiveSnapshot: () => encodeObjectiveSnapshot(authority),
    })

    // --- REOPEN in a FRESH runtime: the CLI `--resume <id>` load path. ---
    const resolved = await resolveResume({
      resume: idMeta.id,
      newSession: false,
      title: undefined,
      cwd: dir,
      initialSessionId: "unused",
      slog: slog(),
    })
    // The resume resolution must carry the persisted objective snapshot.
    expect(resolved.objective).toEqual(expectedSnapshot)

    // --- RESTORE: the reopened surface builds the authority WITH the snapshot. ---
    const reopened = resolveGatedObjectiveAuthority(OBJ_ENV, {
      confirmationAvailable: true,
      restoreFrom: resolved.objective,
    })
    expect(reopened).toBeDefined()
    if (reopened === undefined) return
    const after = reopened.get("thr-1")

    // ids preserved EXACTLY (never re-minted) — the GOAL-01 generation id included.
    expect(after?.successCriteria.map((c) => c.id)).toEqual(critIds)
    expect(after?.objectiveId).toBe(objectiveId)
    // provenance preserved (explicit paused, not defaulted to active).
    expect(after?.status).toBe("paused")
    // goal + next actions survive.
    expect(after?.goal).toBe("ship the feature")
    expect(after?.nextActions).toEqual(["wire it", "test it"])
    // REVISION preserved EXACTLY: re-encoding the RESTORED authority through the
    // real wire reproduces the identical snapshot (revision is part of the DTO).
    expect(encodeObjectiveSnapshot(reopened)).toEqual(expectedSnapshot)
  })

  test("default-OFF byte-identical: NO objective ⇒ persistTurn writes NO objective field", async () => {
    const idMeta = mkMeta("s-legacy", dir)
    await saveSessionById(idMeta, { reason: "fresh", turns: 0, messages: [] })
    // A per-turn save with NO objectiveSnapshot provider (the byte-identical
    // legacy path — no live objective authority).
    await persistTurn({
      state: undefined,
      idMeta,
      sessionId: idMeta.id,
      messages: [],
      outcome: outcome(),
    })
    const loaded = await loadSessionById(idMeta.id)
    expect(loaded).toBeDefined()
    expect(loaded?.objective).toBeUndefined()
    expect(Object.hasOwn(loaded ?? {}, "objective")).toBe(false)

    // Reopen: an absent snapshot ⇒ a FRESH (empty) authority (no restore).
    const resolved = await resolveResume({
      resume: idMeta.id,
      newSession: false,
      title: undefined,
      cwd: dir,
      initialSessionId: "unused",
      slog: slog(),
    })
    expect(resolved.objective).toBeUndefined()
    const reopened = resolveGatedObjectiveAuthority(OBJ_ENV, {
      confirmationAvailable: true,
      restoreFrom: resolved.objective,
    })
    expect(reopened?.list() ?? []).toHaveLength(0)
  })

  test("empty live authority (zero threads) round-trips to an empty reopen", async () => {
    // A live-but-empty authority: the provider returns a snapshot with zero
    // threads. It must not crash the save and reopens empty.
    const authority = resolveGatedObjectiveAuthority(OBJ_ENV, { confirmationAvailable: true })
    const idMeta = mkMeta("s-empty", dir)
    await saveSessionById(idMeta, { reason: "fresh", turns: 0, messages: [] })
    await persistTurn({
      state: undefined,
      idMeta,
      sessionId: idMeta.id,
      messages: [],
      outcome: outcome(),
      objectiveSnapshot: () =>
        authority === undefined ? undefined : encodeObjectiveSnapshot(authority),
    })
    const loaded = await loadSessionById(idMeta.id)
    const reopened = resolveGatedObjectiveAuthority(OBJ_ENV, {
      confirmationAvailable: true,
      restoreFrom: loaded?.objective,
    })
    expect(reopened?.list() ?? []).toHaveLength(0)
  })

  test("forged checked-completion stays FAIL-CLOSED across the real save→reopen→restore", async () => {
    const authority = resolveGatedObjectiveAuthority(OBJ_ENV, { confirmationAvailable: true })
    if (authority === undefined) return
    const set = seedObjective(authority, "forge", {
      goal: "guarded",
      criteria: [
        {
          text: "must verify",
          check: { kind: "command", argv: ["true"], timeoutMs: 1_000, successExitCodes: [0] },
        },
      ],
    })
    const critId = set.successCriteria[0]?.id ?? ""
    const idMeta = mkMeta("s-forge", dir)
    await saveSessionById(idMeta, { reason: "fresh", turns: 0, messages: [] })
    await persistTurn({
      state: undefined,
      idMeta,
      sessionId: idMeta.id,
      messages: [],
      outcome: outcome(),
      objectiveSnapshot: () => encodeObjectiveSnapshot(authority),
    })

    // Forge the on-disk file: flip the checked criterion to met WITHOUT a
    // verifier receipt (a hand-edited session).
    const path = join(dir, "s-forge.json")
    const raw = JSON.parse(await Bun.file(path).text())
    // GOAL-01: the v2 envelope nests the body under `objective`.
    const crit = raw.objective.threads[0].objective.successCriteria[0]
    crit.met = true
    delete crit.completion
    await Bun.write(path, JSON.stringify(raw))

    const resolved = await resolveResume({
      resume: idMeta.id,
      newSession: false,
      title: undefined,
      cwd: dir,
      initialSessionId: "unused",
      slog: slog(),
    })
    const reopened = resolveGatedObjectiveAuthority(OBJ_ENV, {
      confirmationAvailable: true,
      restoreFrom: resolved.objective,
    })
    // M8 — a forged met:true with no verifier receipt is DOWNGRADED on decode,
    // never admitted as a real completion.
    const restoredCrit = reopened?.get("forge")?.successCriteria.find((c) => c.id === critId)
    expect(restoredCrit?.met).toBe(false)
  })
})
