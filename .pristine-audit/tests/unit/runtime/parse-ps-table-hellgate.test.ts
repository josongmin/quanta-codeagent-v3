/**
 * D1 — `parsePsTable` (src/runtime/process-tree.ts) — pure `ps` output parser.
 *
 * WHY THIS MATTERS — `parsePsTable` is the ONLY thing turning the raw
 * `ps -A -o pid=,ppid=` text into the {@link ProcessRow}[] that feeds the
 * whole-tree kill BFS (`descendantsOf`). A row dropped here is a process that
 * LEAKS (it is never reached by the kill); a bad row admitted here could poison
 * the adjacency graph. These tests pin the parser's contract directly + drive a
 * malformed/self-parent table through the PUBLIC `createPpidWalkKiller` to prove
 * the parsed rows do not create a cycle / infinite loop in the consumer.
 *
 * `parsePsTable` IS exported (process-tree.ts:151), so it is tested directly;
 * the cycle/self-parent behaviour is exercised through the injected-`ps` kill
 * API exactly as the sibling `process-tree-kill-hellgate.test.ts` harness does.
 */

import { describe, expect, test } from "bun:test"
import { createPpidWalkKiller, parsePsTable } from "@/runtime/process-tree"

describe("parsePsTable — well-formed table", () => {
  test("parses each `<pid> <ppid>` line into a {pid, ppid} row", () => {
    const raw = "100 1\n200 100\n300 200\n"
    expect(parsePsTable(raw)).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
    ])
  })

  test("right-padded / extra-whitespace columns parse correctly (ps pads pid column)", () => {
    // `ps` right-pads pid/ppid into fixed-width columns — leading + interior
    // whitespace must collapse and not derail the integer parse.
    const raw = "   100      1\n  200    100\n\t300\t\t200\n"
    expect(parsePsTable(raw)).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
    ])
  })

  test("trailing extra columns beyond pid/ppid are ignored (only first two read)", () => {
    // Defensive: even if a future `-o` adds columns, the first two integers win.
    const raw = "100 1 someproc\n200 100 anotherproc\n"
    expect(parsePsTable(raw)).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
    ])
  })
})

describe("parsePsTable — malformed / short lines are skipped", () => {
  test("blank lines + whitespace-only lines are dropped", () => {
    const raw = "\n100 1\n   \n\t\n200 100\n\n"
    expect(parsePsTable(raw)).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
    ])
  })

  test("a single-column line (only a pid, no ppid) is skipped", () => {
    const raw = "100 1\n42\n200 100\n"
    expect(parsePsTable(raw)).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
    ])
  })

  test("non-numeric pid OR ppid lines are skipped (header / garbage rows)", () => {
    // A header row (`PID PPID`) or any garbage line must not produce a NaN row.
    const raw = "PID PPID\n100 1\nfoo bar\n200 xyz\n300 200\n"
    expect(parsePsTable(raw)).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 300, ppid: 200 },
    ])
  })

  test("empty input ⇒ empty table (no throw)", () => {
    expect(parsePsTable("")).toEqual([])
    expect(parsePsTable("\n\n   \n")).toEqual([])
  })
})

describe("parsePsTable rows drive the kill BFS without cycling", () => {
  test("a self-parent row (pid === ppid) does NOT create a cycle / infinite loop", () => {
    // A pathological `ps` snapshot where 200 is its own parent. The killer must
    // terminate (no hang) and never re-signal 200 forever. We assert the call
    // RETURNS (the test process would hang otherwise) and 200 is signalled at
    // most once as a descendant.
    const raw = "100 1\n200 100\n200 200\n300 200\n"
    const rows = parsePsTable(raw)
    expect(rows).toContainEqual({ pid: 200, ppid: 200 })

    const signalled: number[] = []
    const killer = createPpidWalkKiller({
      readTable: () => rows,
      sendSignal: (pid) => signalled.push(pid),
    })
    // Would never return if the self-parent row built a cycle the BFS chased.
    killer.signalTree(100, "SIGTERM")

    // Root first, then the subtree reached; 200 appears at most once.
    expect(signalled[0]).toBe(100)
    expect(signalled.filter((p) => p === 200).length).toBeLessThanOrEqual(1)
    // The grandchild under the self-parent node is still reached exactly once.
    expect(signalled.filter((p) => p === 300).length).toBe(1)
  })

  test("a mutual cycle in the parsed rows (A→B, B→A) still terminates", () => {
    // 400 ⇄ 500 cycle, both reachable from root 100 via 400. The `seen` guard in
    // descendantsOf must stop the BFS — no infinite loop, each signalled once.
    const raw = "100 1\n400 100\n500 400\n400 500\n"
    const killer = createPpidWalkKiller({
      readTable: () => parsePsTable(raw),
      sendSignal: () => {},
    })
    const seen: number[] = []
    const killer2 = createPpidWalkKiller({
      readTable: () => parsePsTable(raw),
      sendSignal: (pid) => seen.push(pid),
    })
    expect(() => killer.signalTree(100, "SIGKILL")).not.toThrow()
    killer2.signalTree(100, "SIGKILL")
    expect(seen.filter((p) => p === 400).length).toBe(1)
    expect(seen.filter((p) => p === 500).length).toBe(1)
  })
})
