/**
 * FINAL ADVERSARIAL PROBE — archive-vs-stale-save resurrection + rollback drop.
 *
 * saveSessionById(meta, payload) trusts the CALLER's in-memory `meta.archived`
 * to pick the target path; it never re-reads the on-disk archived/active state.
 * The per-turn auto-save (persist-turn.ts) reuses an `idMeta` snapshot captured
 * at session-switch time — so its `archived` flag can be STALE (false) after
 * another surface archives the session mid-turn.
 *
 * The R3/R4 save lock only orders same-id writers; it does NOT make
 * saveSessionById observe an archive that already committed. The rollback-preserve
 * fix reads the ledger from the path derived from the stale meta (the now-empty
 * active file), so the archived file's ledger is preserved as {} = LOST.
 *
 * DEMONSTRATES: after archive-then-stale-save the session is resurrected ACTIVE
 * (un-archived) AND its durable rollback ledger is gone.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveSession, loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"

let root: string
let priorEnv: string | undefined

beforeEach(() => {
  priorEnv = process.env.QUANTA_SESSIONS_DIR
  root = mkdtempSync(join(tmpdir(), "archive-resurrect-"))
  process.env.QUANTA_SESSIONS_DIR = root
  __resetRuntimeConfig()
})

afterEach(() => {
  if (priorEnv === undefined) delete process.env.QUANTA_SESSIONS_DIR
  else process.env.QUANTA_SESSIONS_DIR = priorEnv
  __resetRuntimeConfig()
  rmSync(root, { recursive: true, force: true })
})

const makeMeta = (id: string, archived: boolean): SessionMeta => ({
  id,
  title: "t",
  cwd: "/tmp",
  createdAt: 1,
  lastTouched: 1,
  archived,
})

test("archive-then-stale-save resurrects the session and DROPS its rollback ledger", async () => {
  const id = "sess-archive-resurrect"

  // 1) An ACTIVE session that already carries a durable rollback ledger (a real
  //    rollback op the coordinator folded in — recovery-critical state).
  await saveSessionById(makeMeta(id, false), {
    reason: "fresh",
    turns: 1,
    messages: [],
    rollbackOperations: [
      {
        recordVersion: 1,
        operationId: "op-1",
        targetTurnId: "turn-1",
        state: "requested",
        requestedAt: 10,
      } as never,
    ],
    rollbackCheckpoints: [
      {
        recordVersion: 1,
        turnId: "turn-1",
        messageId: "msg-1",
        checkpointSha: "deadbeef",
        expectedFileHashes: {},
      } as never,
    ],
  })

  // Sanity: the ledger is durable on the active file.
  const before = await loadSessionById(id)
  expect(before?.rollbackOperations?.length).toBe(1)
  expect(before?.meta.archived).toBe(false)

  // 2) Another surface ARCHIVES the session (e.g. user /archive from the web
  //    daemon while a CLI turn is in flight). This moves the file — WITH the
  //    ledger — to <root>/archived/<id>.json and deletes the active file.
  await archiveSession(id)
  expect(existsSync(join(root, `${id}.json`))).toBe(false)
  expect(existsSync(join(root, "archived", `${id}.json`))).toBe(true)

  // 3) The in-flight turn finishes and the per-turn auto-save fires with the
  //    STALE idMeta snapshot captured before the archive (archived === false).
  //    This is the EXACT shape persist-turn.ts builds: no rollback fields.
  const staleIdMeta = makeMeta(id, false)
  await saveSessionById(staleIdMeta, { reason: "final", turns: 2, messages: [] })

  // ---- OUTCOME (R6 fix: saveSessionById is now DISK-authoritative) ----
  const after = await loadSessionById(id)

  // FIX 1 — the stale save does NOT resurrect the session onto the active path;
  //         it writes where the file actually is (the archived file).
  expect(existsSync(join(root, `${id}.json`))).toBe(false)
  expect(existsSync(join(root, "archived", `${id}.json`))).toBe(true)
  // FIX 2 — meta.archived is reconciled from disk (stays archived, not resurrected).
  expect(after?.meta.archived).toBe(true)
  // FIX 3 — the recovery-critical rollback ledger SURVIVES (read from the real
  //         file, not the now-absent active path). Red-on-injection: revert the
  //         disk-authoritative path selection and all three flip.
  expect(after?.rollbackOperations?.length).toBe(1)
  expect(after?.rollbackOperations?.[0]?.operationId).toBe("op-1")
})
