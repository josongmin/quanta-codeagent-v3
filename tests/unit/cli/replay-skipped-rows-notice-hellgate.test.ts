/**
 * WS-G item 2 (UUX-1-27) — `/replay` silently skipped malformed JSONL rows.
 *
 * `buildReplaySlashState().iterate` un-wraps `iterateSessionFile` Results and
 * used to DROP `!r.ok` rows with zero signal — a truncated / hand-edited /
 * older-version session file replayed as if complete. Fix: count the skips and
 * emit ONE warn notice with the count when the iteration finishes.
 *
 * Red-on-injection: a fixture file with 2 valid + 3 malformed rows must yield
 * the 2 valid records AND exactly one warn notice naming 3 skipped rows. A
 * fully-valid file must emit NO notice (paired control).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"
import { buildReplaySlashState } from "../../../src/apps/cli/repl/surface-compose/wire-builders"

const VALID_ROW = JSON.stringify({
  type: "event_msg",
  schema_version: 1,
  ts: "2026-07-10T00:00:00.000Z",
  turn_id: "t1",
  kind: "user_message",
  content: "hello",
})

const collect = async (iter: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = []
  for await (const r of iter) out.push(r)
  return out
}

describe("/replay skipped-row operator notice (UUX-1-27)", () => {
  let dir: string | undefined
  const notices: OperatorNotice[] = []

  afterEach(() => {
    __resetOperatorNoticeSinkForTest()
    notices.length = 0
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  test("malformed rows are skipped AND counted in one warn notice", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    dir = mkdtempSync(join(tmpdir(), "replay-notice-"))
    const path = join(dir, "session.jsonl")
    writeFileSync(
      path,
      [
        VALID_ROW,
        "{not json at all",
        JSON.stringify({ type: "event_msg", but: "schema-invalid" }),
        VALID_ROW,
        "garbage-row",
      ].join("\n"),
    )
    const rows = await collect(buildReplaySlashState().iterate(path))
    expect(rows).toHaveLength(2)
    const warns = notices.filter((n) => n.source === "/replay")
    expect(warns).toHaveLength(1)
    expect(warns[0]?.severity).toBe("warn")
    expect(warns[0]?.message).toContain("3")
  })

  test("paired control: a fully-valid file emits NO notice", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    dir = mkdtempSync(join(tmpdir(), "replay-notice-"))
    const path = join(dir, "session.jsonl")
    writeFileSync(path, [VALID_ROW, VALID_ROW].join("\n"))
    const rows = await collect(buildReplaySlashState().iterate(path))
    expect(rows).toHaveLength(2)
    expect(notices).toHaveLength(0)
  })
})
