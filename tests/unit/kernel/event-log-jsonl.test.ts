/**
 * W4-b substrate battery — JsonlSessionEventLog (on-disk KernelEventLogPort).
 *
 * Contract under test (ADR-0540 W2 item 0; consumer = transport-unified-sdk 05):
 *   (a) append → re-open → list/readFrom round-trip, event equality THROUGH the
 *       @/protocol/session codec (the file format IS `encodeSessionEvent` lines
 *       — no self-invented format), proven by decoding the raw file directly.
 *   (c) torn FINAL line (crash-mid-write: unterminated, invalid JSON) →
 *       skip + warn + self-heal (truncate), later appends land on a clean tail.
 *   (d) corruption ANYWHERE ELSE → fail-loud (no silent data loss):
 *       mid-file garbage, TERMINATED corrupt last line (not a torn write),
 *       and an unterminated tail that parses as JSON but is not a valid
 *       envelope (torn writes of our writer can never produce parseable JSON —
 *       a proper prefix of a JSON object never balances its braces).
 *   (e) missing dir is created; empty/missing log ⇒ tip 0, empty reads.
 *   (h) 10k events append → re-open → full ordered equality (deterministic
 *       assertions only, no wall-clock bounds).
 *   (i) single-writer guard: double-open (live pid) throws; graceful close
 *       releases; STALE lock (dead pid — the crash-restart path) is reclaimed
 *       with a warn; unreadable lock content fails closed.
 *   (+) sessionId path-safety, append-after-close, tip() = max-seq high-water.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  JsonlSessionEventLog,
  JsonlSessionEventLogCorruptionError,
  JsonlSessionEventLogLockError,
} from "@/kernel/session"
import { decodeSessionEvent, encodeSessionEvent, type SessionEvent } from "@/protocol/session"

const tmpDirs: string[] = []
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-w4b-jsonl-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Minimal REAL SessionEvent (passes the codec's envelope + type assertions). */
const deltaEvent = (seq: number, delta: string): SessionEvent => ({
  eventId: `e-${seq}`,
  seq,
  revision: seq,
  emittedAt: "2026-07-17T00:00:00.000Z",
  type: "turn.output.delta",
  delta,
})

const openLog = (
  dir: string,
  sessionId = "s1",
  warn?: (message: string) => void,
): JsonlSessionEventLog =>
  new JsonlSessionEventLog({ dir, sessionId, ...(warn !== undefined ? { warn } : {}) })

const logFile = (dir: string, sessionId = "s1"): string => join(dir, `${sessionId}.jsonl`)

describe("JsonlSessionEventLog substrate", () => {
  test("(a) append → re-open → list/readFrom round-trip through the protocol codec", () => {
    const dir = freshDir()
    const first = openLog(dir)
    const events = [deltaEvent(1, "alpha"), deltaEvent(2, "beta"), deltaEvent(3, "gamma")]
    for (const event of events) first.append(event)
    expect(first.list()).toEqual(events)
    expect(first.tip()).toBe(3)
    first.close()

    // Fresh instance, same dir — decoded state must be equal, not merely similar.
    const second = openLog(dir)
    expect(second.list()).toEqual(events)
    expect(second.tip()).toBe(3)
    expect(second.readFrom(0)).toEqual(events)
    expect(second.readFrom(2)).toEqual([events[2]!])
    expect(second.readFrom(3)).toEqual([])
    second.close()

    // Codec-reuse proof: the raw file lines decode via decodeSessionEvent and
    // re-encode byte-identically via encodeSessionEvent (no private format).
    const lines = readFileSync(logFile(dir), "utf8")
      .split("\n")
      .filter((line) => line !== "")
    expect(lines.map((line) => decodeSessionEvent(line))).toEqual(events)
    expect(lines).toEqual(events.map((event) => encodeSessionEvent(event)))
  })

  test("(e) missing dir is created; empty log reads as tip 0 / empty lists", () => {
    const dir = join(freshDir(), "not", "yet", "created")
    expect(existsSync(dir)).toBe(false)
    const log = openLog(dir)
    expect(existsSync(logFile(dir))).toBe(true)
    expect(log.tip()).toBe(0)
    expect(log.list()).toEqual([])
    expect(log.readFrom(0)).toEqual([])
    log.close()

    // Empty EXISTING file (created above, zero appends) re-opens the same way.
    const again = openLog(dir)
    expect(again.tip()).toBe(0)
    expect(again.list()).toEqual([])
    again.close()
  })

  test("(c) torn final line (unterminated, crash-mid-write) → skip + warn + self-heal", () => {
    const dir = freshDir()
    const good = [deltaEvent(1, "one"), deltaEvent(2, "two")]
    const torn = encodeSessionEvent(deltaEvent(3, "three")).slice(0, 25)
    writeFileSync(
      logFile(dir),
      `${good.map((event) => encodeSessionEvent(event)).join("\n")}\n${torn}`,
    )

    const warnings: string[] = []
    const log = openLog(dir, "s1", (message) => warnings.push(message))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("torn")
    expect(log.list()).toEqual(good)
    expect(log.tip()).toBe(2)

    // Self-heal: the torn bytes were truncated, so the next append produces a
    // clean 3-line file a fresh open reads WITHOUT any warning.
    const appended = deltaEvent(3, "three-retry")
    log.append(appended)
    log.close()
    const rewarnings: string[] = []
    const reopened = openLog(dir, "s1", (message) => rewarnings.push(message))
    expect(rewarnings).toEqual([])
    expect(reopened.list()).toEqual([...good, appended])
    reopened.close()
    const rawLines = readFileSync(logFile(dir), "utf8").split("\n")
    expect(rawLines.length).toBe(4) // 3 records + trailing newline
    expect(rawLines[3]).toBe("")
  })

  test("(c) tear that ate ONLY the trailing newline: event kept, newline repaired, no line-merge", () => {
    // write("json\n") can persist all bytes except the final "\n" — the event
    // is COMPLETE, so recovery must keep it and terminate the line before the
    // next append (otherwise the next append would merge into the same line
    // and corrupt the log for every future open).
    const dir = freshDir()
    const kept = deltaEvent(1, "kept-despite-missing-newline")
    writeFileSync(logFile(dir), encodeSessionEvent(kept)) // NO trailing newline
    const warnings: string[] = []
    const log = openLog(dir, "s1", (message) => warnings.push(message))
    expect(log.list()).toEqual([kept])
    expect(log.tip()).toBe(1)
    expect(warnings.some((message) => message.includes("newline repaired"))).toBe(true)
    const next = deltaEvent(2, "after-repair")
    log.append(next)
    log.close()
    const reopened = openLog(dir)
    expect(reopened.list()).toEqual([kept, next])
    reopened.close()
    // Raw shape: exactly two records on two lines, properly terminated.
    const rawLines = readFileSync(logFile(dir), "utf8").split("\n")
    expect(rawLines.length).toBe(3)
    expect(rawLines[2]).toBe("")
  })

  test("(c) file that is ONLY a torn line recovers to an empty log", () => {
    const dir = freshDir()
    writeFileSync(logFile(dir), '{"version":"1","kind":"ev')
    const warnings: string[] = []
    const log = openLog(dir, "s1", (message) => warnings.push(message))
    expect(warnings.length).toBe(1)
    expect(log.tip()).toBe(0)
    expect(log.list()).toEqual([])
    log.append(deltaEvent(1, "fresh"))
    expect(log.tip()).toBe(1)
    log.close()
  })

  test("(d) mid-file corruption fails loud with the offending line number", () => {
    const dir = freshDir()
    writeFileSync(
      logFile(dir),
      `${encodeSessionEvent(deltaEvent(1, "ok"))}\nNOT-JSON-{{{\n${encodeSessionEvent(deltaEvent(3, "later"))}\n`,
    )
    expect(() => openLog(dir)).toThrow(JsonlSessionEventLogCorruptionError)
    expect(() => openLog(dir)).toThrow(/line 2/)
  })

  test("(d-control) TERMINATED corrupt final line is NOT a torn write → fail-loud", () => {
    // A single write() of `json\n` can only tear into a strict PREFIX — a
    // corrupt line that still ends in `\n` cannot come from our writer's
    // crash model, so tolerating it would be silent data loss.
    const dir = freshDir()
    writeFileSync(logFile(dir), `${encodeSessionEvent(deltaEvent(1, "ok"))}\nGARBAGE-TAIL\n`)
    expect(() => openLog(dir)).toThrow(JsonlSessionEventLogCorruptionError)
  })

  test("(d-control) unterminated tail that parses as JSON but is no envelope → fail-loud", () => {
    // Parseable-but-invalid can never be a torn prefix of our own writer
    // (prefixes of a JSON object never balance) — treat as real corruption.
    const dir = freshDir()
    writeFileSync(logFile(dir), `${encodeSessionEvent(deltaEvent(1, "ok"))}\n{"a":1}`)
    expect(() => openLog(dir)).toThrow(JsonlSessionEventLogCorruptionError)
  })

  test("(i) single-writer guard: double-open throws; close releases; dead-pid lock is reclaimed", () => {
    const dir = freshDir()
    const first = openLog(dir)
    expect(() => openLog(dir)).toThrow(JsonlSessionEventLogLockError)
    first.close()
    const second = openLog(dir)
    second.close()

    // Stale lock (crash-restart path): a lock owned by a DEAD pid must be
    // reclaimed (warn, not throw). `spawnSync` guarantees the child already
    // exited, so its pid is dead (modulo astronomically-unlikely reuse).
    const dead = spawnSync("true", { stdio: "ignore" })
    expect(typeof dead.pid).toBe("number")
    writeFileSync(join(dir, "s1.jsonl.lock"), String(dead.pid))
    const warnings: string[] = []
    const reclaimed = openLog(dir, "s1", (message) => warnings.push(message))
    expect(warnings.some((message) => message.includes("stale"))).toBe(true)
    reclaimed.append(deltaEvent(1, "after-reclaim"))
    reclaimed.close()

    // Unreadable lock content fails CLOSED (never silently steal the file).
    writeFileSync(join(dir, "s1.jsonl.lock"), "not-a-pid")
    expect(() => openLog(dir)).toThrow(JsonlSessionEventLogLockError)
  })

  test("(h) 10k events append → re-open → full ordered integrity", () => {
    const dir = freshDir()
    const log = openLog(dir)
    for (let seq = 1; seq <= 10_000; seq += 1) {
      log.append(deltaEvent(seq, `payload-${seq}`))
    }
    expect(log.tip()).toBe(10_000)
    log.close()

    const reopened = openLog(dir)
    const all = reopened.list()
    expect(all.length).toBe(10_000)
    for (let i = 0; i < all.length; i += 1) {
      expect(all[i]!.seq).toBe(i + 1)
    }
    // Deterministic deep spot-checks (first / middle / last).
    expect(all[0]).toEqual(deltaEvent(1, "payload-1"))
    expect(all[4241]).toEqual(deltaEvent(4242, "payload-4242"))
    expect(all[9999]).toEqual(deltaEvent(10_000, "payload-10000"))
    const tail = reopened.readFrom(9_990)
    expect(tail.length).toBe(10)
    expect(tail[0]!.seq).toBe(9_991)
    expect(reopened.tip()).toBe(10_000)
    reopened.close()
  })

  test("tip() is the max-seq high-water mark (locally reordered commit pairs)", () => {
    // The scheduler emits some commit batches as [seq n, seq n-1]-shaped pairs
    // (e.g. turn.completed + trailing session.state.updated) — tip must be the
    // high-water mark, not merely the last-appended seq.
    const dir = freshDir()
    const log = openLog(dir)
    log.append(deltaEvent(5, "high"))
    log.append(deltaEvent(4, "trailing"))
    expect(log.tip()).toBe(5)
    log.close()
    const reopened = openLog(dir)
    expect(reopened.tip()).toBe(5)
    expect(reopened.readFrom(4)).toEqual([deltaEvent(5, "high")])
    reopened.close()
  })

  test("sessionId path-safety: traversal / separator / empty ids are rejected", () => {
    const dir = freshDir()
    for (const bad of ["../evil", "a/b", "a\\b", "", ".", "..", "id with space"]) {
      expect(() => new JsonlSessionEventLog({ dir, sessionId: bad })).toThrow(/sessionId/)
    }
    // Nothing was created for any rejected id.
    expect(readFileSync !== undefined && existsSync(join(dir, "evil.jsonl"))).toBe(false)
  })

  test("append after close fails loud; close is idempotent", () => {
    const dir = freshDir()
    const log = openLog(dir)
    log.append(deltaEvent(1, "only"))
    log.close()
    log.close() // idempotent
    expect(() => log.append(deltaEvent(2, "late"))).toThrow(/closed/)
    // The failed append must not have corrupted the file.
    const reopened = openLog(dir)
    expect(reopened.list()).toEqual([deltaEvent(1, "only")])
    reopened.close()
  })
})
