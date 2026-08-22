/**
 * ADR-0463 — `quanta batch` subcommand WIRE hellgate.
 *
 * Proves the composition-root binding (not just the slice units):
 *
 *   A. Gate-OFF (module imported, never invoked) ⇒ ZERO subagent calls, ZERO
 *      FS writes, zero allocation beyond the import. The wire is inert until
 *      `runBatchCmd` is explicitly called.
 *   B. Gate-ON happy path ⇒ the RowDispatchPort adapter is constructed over the
 *      injected runner, ONE runner call PER ROW fires, and the results CSV is
 *      written with `_status`/`_result`/`_error` columns.
 *   C. Adapter failure is CAUGHT (a throwing runner never bubbles) — the row is
 *      surfaced as `failed` in the CSV; the command still returns no-throw.
 *   D. A subagent that returns `ok:false` ⇒ row `failed`, surfaced, no throw.
 *   E. Argument faults ⇒ exit 64 (EX_USAGE), no runner call, no FS write.
 *   F. An unreadable input file ⇒ exit 64, no runner call.
 *   G. `--help` ⇒ usage printed, exit 0, no runner call.
 *   H. Output schema enforced per-row: a row whose JSON misses a required field
 *      is marked `failed` (schema-rejected), surfaced, never aborts the job.
 */

import { describe, expect, test } from "bun:test"
import {
  batchUsage,
  buildRowDispatchAdapter,
  parseBatchArgs,
  runBatchCmd,
} from "@/apps/cli/batch-cmd"
import type { SubagentRequest, SubagentResult, SubagentRunner } from "@/subagent"

/** A counting/scriptable subagent runner. */
const makeRunner = (
  reply: (req: SubagentRequest) => SubagentResult | Promise<SubagentResult> | never,
): { runner: SubagentRunner; calls: SubagentRequest[] } => {
  const calls: SubagentRequest[] = []
  const runner: SubagentRunner = async (req) => {
    calls.push(req)
    return reply(req)
  }
  return { runner, calls }
}

/** In-memory IO double — captures writes, never touches disk. */
const makeIo = (files: Record<string, string>) => {
  const written: Record<string, string> = {}
  const out: string[] = []
  const errs: string[] = []
  return {
    io: {
      readFile: (path: string) => {
        const f = files[path]
        if (f === undefined) throw new Error(`ENOENT: ${path}`)
        return f
      },
      writeFile: (path: string, data: string) => {
        written[path] = data
      },
      out: (s: string) => {
        out.push(s)
      },
      err: (s: string) => {
        errs.push(s)
      },
    },
    written,
    out,
    errs,
  }
}

const okResult = (finalText: string): SubagentResult => ({ ok: true, finalText, turns: 1 })

const CSV = "name,city\nAda,London\nGrace,NYC\n"

describe("batch-cmd wire — gate-OFF inertness (A)", () => {
  test("importing the module makes ZERO subagent calls / FS writes", () => {
    // The mere import above ran. No runner exists, no FS happened. The only way
    // anything runs is an explicit runBatchCmd() call (proven in B+).
    const { calls } = makeRunner(() => okResult("{}"))
    expect(calls.length).toBe(0)
    // parse helpers are pure: calling them does not dispatch or write.
    expect(parseBatchArgs(["--in", "x", "--instruction", "do", "--out", "o"]).ok).toBe(true)
    expect(calls.length).toBe(0)
    expect(batchUsage()).toContain("quanta batch")
  })
})

describe("batch-cmd wire — happy path (B)", () => {
  test("one runner call per row + results CSV written", async () => {
    // The adapter embeds the row index in the prompt ("## Row N") — a
    // SubagentRequest has no `rowIndex` field (see the prompt-branch note below),
    // so derive it from the prompt.
    const { runner, calls } = makeRunner((req) =>
      okResult(`handled row ${req.prompt.match(/## Row (\d+)/)?.[1] ?? "?"}`),
    )
    const { io, written, out } = makeIo({ "in.csv": CSV })

    const code = await runBatchCmd(
      ["--in", "in.csv", "--instruction", "Summarise the person", "--out", "out.csv"],
      { runner, io, now: () => 1, newId: counterId() },
    )

    expect(code).toBe(0)
    expect(calls.length).toBe(2) // exactly one subagent per CSV row
    // The adapter appended the row JSON to the instruction (order-independent:
    // the pool may dispatch rows concurrently).
    expect(calls.every((c) => c.prompt.includes("Summarise the person"))).toBe(true)
    expect(calls.every((c) => c.depth === 1)).toBe(true)
    expect(calls.some((c) => c.prompt.includes("Ada"))).toBe(true)
    expect(calls.some((c) => c.prompt.includes("Grace"))).toBe(true)

    const csv = written["out.csv"]
    expect(csv).toBeDefined()
    expect(csv).toContain("_status")
    expect(csv).toContain("_result")
    expect(csv).toContain("done")
    expect(csv).toContain("Ada")
    expect(out.join("")).toContain("2/2 rows done")
  })
})

describe("batch-cmd wire — adapter failure caught (C)", () => {
  test("a throwing runner never bubbles; row surfaced as failed", async () => {
    const { runner } = makeRunner(() => {
      throw new Error("boom in child loop")
    })
    const { io, written } = makeIo({ "in.csv": CSV })

    // Must NOT reject — no-throw boundary.
    const code = await runBatchCmd(
      ["--in", "in.csv", "--instruction", "do", "--out", "out.csv", "--max-attempts", "1"],
      { runner, io, now: () => 1, newId: counterId() },
    )

    expect(code).toBe(0) // row failures are data, not a command fault
    const csv = written["out.csv"]
    expect(csv).toContain("failed")
    expect(csv).toContain("boom in child loop")
  })

  test("the adapter itself converts a throw to Err, never rejects", async () => {
    const adapter = buildRowDispatchAdapter(async () => {
      throw new Error("dispatch exploded")
    })
    const res = await adapter({ instruction: "i", rowJson: "{}", rowIndex: 0, attempt: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe("store-failed")
  })

  test("an already-aborted signal short-circuits to Err(aborted) with no runner call", async () => {
    const { runner, calls } = makeRunner(() => okResult("{}"))
    const ac = new AbortController()
    ac.abort()
    const adapter = buildRowDispatchAdapter(runner)
    const res = await adapter({
      instruction: "i",
      rowJson: "{}",
      rowIndex: 0,
      attempt: 1,
      signal: ac.signal,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe("aborted")
    expect(calls.length).toBe(0)
  })
})

describe("batch-cmd wire — subagent ok:false (D)", () => {
  test("ok:false dispatch ⇒ row failed, surfaced, no throw", async () => {
    const { runner } = makeRunner(() => ({ ok: false, finalText: "child refused", turns: 0 }))
    const { io, written } = makeIo({ "in.csv": CSV })
    const code = await runBatchCmd(["--in", "in.csv", "--instruction", "do", "--out", "out.csv"], {
      runner,
      io,
      now: () => 1,
      newId: counterId(),
    })
    expect(code).toBe(0)
    expect(written["out.csv"]).toContain("failed")
    expect(written["out.csv"]).toContain("child refused")
  })
})

describe("batch-cmd wire — argument + IO faults (E,F,G)", () => {
  test("missing required flag ⇒ exit 64, no runner call, no write", async () => {
    const { runner, calls } = makeRunner(() => okResult("{}"))
    const { io, written } = makeIo({ "in.csv": CSV })
    const code = await runBatchCmd(["--in", "in.csv"], { runner, io })
    expect(code).toBe(64)
    expect(calls.length).toBe(0)
    expect(Object.keys(written).length).toBe(0)
  })

  test("unknown flag ⇒ exit 64", async () => {
    const { runner, calls } = makeRunner(() => okResult("{}"))
    const { io } = makeIo({})
    const code = await runBatchCmd(["--bogus"], { runner, io })
    expect(code).toBe(64)
    expect(calls.length).toBe(0)
  })

  test("unreadable input ⇒ exit 64, no runner call", async () => {
    const { runner, calls } = makeRunner(() => okResult("{}"))
    const { io } = makeIo({}) // no in.csv
    const code = await runBatchCmd(
      ["--in", "missing.csv", "--instruction", "do", "--out", "out.csv"],
      { runner, io },
    )
    expect(code).toBe(64)
    expect(calls.length).toBe(0)
  })

  test("--help ⇒ usage printed, exit 0, no runner call", async () => {
    const { runner, calls } = makeRunner(() => okResult("{}"))
    const { io, out } = makeIo({})
    const code = await runBatchCmd(["--help"], { runner, io })
    expect(code).toBe(0)
    expect(calls.length).toBe(0)
    expect(out.join("")).toContain("USAGE")
  })

  test("--pool 0 rejected", () => {
    const res = parseBatchArgs(["--in", "i", "--instruction", "x", "--out", "o", "--pool", "0"])
    expect(res.ok).toBe(false)
  })
})

describe("batch-cmd wire — output schema enforced per-row (H)", () => {
  test("a row whose result misses a required field is failed, never aborts", async () => {
    // The Ada row returns valid JSON with `verdict`; the Grace row misses it.
    // The child only ever sees the prompt (row JSON appended by the adapter),
    // never a `rowIndex` field — so branch on the prompt content.
    const { runner } = makeRunner((req) =>
      req.prompt.includes("Ada")
        ? okResult(JSON.stringify({ verdict: "good" }))
        : okResult(JSON.stringify({ other: "x" })),
    )
    const { io, written } = makeIo({
      "in.csv": CSV,
      "schema.json": JSON.stringify({
        type: "object",
        fields: { verdict: "string" },
        required: ["verdict"],
      }),
    })
    const code = await runBatchCmd(
      ["--in", "in.csv", "--instruction", "judge", "--out", "out.csv", "--schema", "schema.json"],
      { runner, io, now: () => 1, newId: counterId() },
    )
    expect(code).toBe(0)
    const csv = written["out.csv"]
    expect(csv).toContain("done") // row 0 passed schema
    expect(csv).toContain("schema-rejected") // row 1 failed schema, surfaced
  })
})

/** Deterministic id minter for the tests. */
const counterId = (): (() => string) => {
  let n = 0
  return () => `id-${n++}`
}
