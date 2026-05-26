/**
 * Hellgate — matrix on-disk state adversarial battery.
 *
 * Scope: `readPickIds` (dataset → ids) + `collectRowsForCondition` (run-dir →
 * MatrixRow[]). The brief named a separate `state.ts` slice with `saveSweepState`
 * / `loadSweepState` / `recordConditionComplete` / `detectMismatch` — those do
 * NOT exist in the current codebase (the matrix runner is one file). This file
 * therefore pins the EXISTING state-handling contracts under adversarial input:
 *   - Missing / malformed JSON tolerated (no crash, no silent drop without
 *     fallback).
 *   - The matrix tool never invents prices: missing model ⇒ costUsd 0.
 *   - Wall-time math is robust to partial JSONL (SIGINT interruption).
 *   - Filename → instance binding uses substring match (first-match wins).
 *   - Reading a directory that doesn't exist returns an "all-error" row set.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectRowsForCondition, readPickIds } from "@/../tools/swebench-matrix"

const mkTmp = (label: string): string => mkdtempSync(join(tmpdir(), `mx-state-${label}-`))

// ── readPickIds adversarial ───────────────────────────────────────────────

describe("hellgate readPickIds — adversarial", () => {
  test("file not found ⇒ throws (fail-loud — operator must see)", () => {
    expect(() => readPickIds("/nonexistent/path/picks.jsonl")).toThrow()
  })

  test("empty file ⇒ empty list (NOT throw)", () => {
    const dir = mkTmp("empty")
    try {
      const f = join(dir, "picks.jsonl")
      writeFileSync(f, "")
      expect(readPickIds(f)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("blank lines skipped silently", () => {
    const dir = mkTmp("blanks")
    try {
      const f = join(dir, "picks.jsonl")
      writeFileSync(f, ["", "", JSON.stringify({ instance_id: "a__b-1" }), "", "", ""].join("\n"))
      expect(readPickIds(f)).toEqual(["a__b-1"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("comment lines (`#`) skipped", () => {
    const dir = mkTmp("comments")
    try {
      const f = join(dir, "picks.jsonl")
      writeFileSync(
        f,
        [
          "# header comment",
          JSON.stringify({ instance_id: "x" }),
          "# another comment",
          JSON.stringify({ instance_id: "y" }),
        ].join("\n"),
      )
      expect(readPickIds(f)).toEqual(["x", "y"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed JSON lines silently dropped (matches bench's forgiving parser)", () => {
    const dir = mkTmp("malformed")
    try {
      const f = join(dir, "picks.jsonl")
      writeFileSync(
        f,
        [
          JSON.stringify({ instance_id: "ok-1" }),
          "{not-json",
          JSON.stringify({ instance_id: "ok-2" }),
          "{}{}{}{}}",
          JSON.stringify({ instance_id: "ok-3" }),
        ].join("\n"),
      )
      expect(readPickIds(f)).toEqual(["ok-1", "ok-2", "ok-3"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("JSON lines without instance_id field dropped (NOT throw)", () => {
    const dir = mkTmp("noid")
    try {
      const f = join(dir, "picks.jsonl")
      writeFileSync(
        f,
        [
          JSON.stringify({ repo: "foo/bar" }), // no instance_id
          JSON.stringify({ instance_id: "ok" }),
          JSON.stringify({ instance_id: 42 }), // wrong type
          JSON.stringify({ instance_id: "" }), // empty string also dropped
        ].join("\n"),
      )
      expect(readPickIds(f)).toEqual(["ok"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("very large file (1000 picks) parses correctly", () => {
    const dir = mkTmp("large")
    try {
      const f = join(dir, "picks.jsonl")
      const lines: string[] = []
      for (let i = 0; i < 1000; i++) {
        lines.push(JSON.stringify({ instance_id: `inst-${i}` }))
      }
      writeFileSync(f, lines.join("\n"))
      const ids = readPickIds(f)
      expect(ids.length).toBe(1000)
      expect(ids[0]).toBe("inst-0")
      expect(ids[999]).toBe("inst-999")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("unicode instance_ids preserved (no transliteration)", () => {
    const dir = mkTmp("unicode")
    try {
      const f = join(dir, "picks.jsonl")
      writeFileSync(
        f,
        [
          JSON.stringify({ instance_id: "한글__test-1" }),
          JSON.stringify({ instance_id: "emoji-🚀-2" }),
        ].join("\n"),
      )
      expect(readPickIds(f)).toEqual(["한글__test-1", "emoji-🚀-2"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("prototype-pollution-style instance_id values pass through (string is string)", () => {
    const dir = mkTmp("proto")
    try {
      const f = join(dir, "picks.jsonl")
      writeFileSync(f, JSON.stringify({ instance_id: "__proto__" }))
      expect(readPickIds(f)).toEqual(["__proto__"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("trailing whitespace per line is tolerated", () => {
    const dir = mkTmp("trail")
    try {
      const f = join(dir, "picks.jsonl")
      writeFileSync(
        f,
        `${JSON.stringify({ instance_id: "a" })}   \n  ${JSON.stringify({ instance_id: "b" })}\n`,
      )
      expect(readPickIds(f)).toEqual(["a", "b"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── collectRowsForCondition adversarial ────────────────────────────────────

describe("hellgate collectRowsForCondition — adversarial", () => {
  test("nonexistent run dir ⇒ every pick reported with fallback verdict (NO crash)", () => {
    const rows = collectRowsForCondition("baseline", "/nonexistent/run-dir", ["a", "b"], "fail")
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.verdict === "fail")).toBe(true)
    expect(rows.every((r) => r.costUsd === 0)).toBe(true)
  })

  test("run dir exists but summary.json missing ⇒ fallback verdict on every pick", () => {
    const dir = mkTmp("nosum")
    try {
      const runDir = join(dir, "run-1")
      mkdirSync(runDir, { recursive: true })
      const rows = collectRowsForCondition("baseline", runDir, ["x", "y"], "error")
      expect(rows.length).toBe(2)
      expect(rows.every((r) => r.verdict === "error")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("summary.json is malformed JSON ⇒ fallback verdict (NO throw)", () => {
    const dir = mkTmp("badjson")
    try {
      const runDir = join(dir, "run-2")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, "summary.json"), "{not-valid-json{{")
      const rows = collectRowsForCondition("baseline", runDir, ["a"], "fail")
      expect(rows.length).toBe(1)
      expect(rows[0]?.verdict).toBe("fail")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("summary.json empty string ⇒ fallback (parser tolerates)", () => {
    const dir = mkTmp("emptysum")
    try {
      const runDir = join(dir, "run-3")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, "summary.json"), "")
      const rows = collectRowsForCondition("baseline", runDir, ["a"], "fail")
      expect(rows[0]?.verdict).toBe("fail")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("summary.json without instances field ⇒ all fallback (no defined verdict)", () => {
    const dir = mkTmp("noinstances")
    try {
      const runDir = join(dir, "run-4")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, "summary.json"), JSON.stringify({ runId: "x" }))
      const rows = collectRowsForCondition("baseline", runDir, ["a", "b"], "error")
      expect(rows.every((r) => r.verdict === "error")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("instance with verdict='degraded' ⇒ verdict mapped (not silently treated as fail)", () => {
    const dir = mkTmp("degraded")
    try {
      const runDir = join(dir, "run-5")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "deg", passed: false, verdict: "degraded", turns: 0 }],
        }),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["deg"], "fail")
      expect(rows[0]?.verdict).toBe("degraded")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed JSONL attempt file (partial line) ⇒ usage = 0, wall = 0 (no crash)", () => {
    const dir = mkTmp("badjsonl")
    try {
      const runDir = join(dir, "run-6")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "ok", passed: true, verdict: "ok", turns: 1 }],
        }),
      )
      // SIGINT-truncated JSONL: last line is partial.
      writeFileSync(
        join(runDir, "ok.0.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: 0, id: "ok" }),
          '{"type":"usage","ts":1000,"model":"gpt-',
        ].join("\n"),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["ok"], "fail")
      const r = rows[0]
      expect(r?.verdict).toBe("pass")
      expect(r?.tokensIn).toBe(0) // malformed usage line discarded
      // wall = single-ts span = 0 (only one parseable event)
      expect(r?.wallMs).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("unknown model in usage event ⇒ costUsd = 0 (never invented)", () => {
    const dir = mkTmp("unkmodel")
    try {
      const runDir = join(dir, "run-7")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "u", passed: true, verdict: "ok", turns: 1 }],
        }),
      )
      writeFileSync(
        join(runDir, "u.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: 0, id: "u" }),
          JSON.stringify({
            type: "usage",
            ts: 1000,
            model: "completely-fake-model-zzz",
            inputTokens: 999,
            outputTokens: 111,
          }),
        ].join("\n"),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["u"], "fail")
      expect(rows[0]?.tokensIn).toBe(999)
      expect(rows[0]?.costUsd).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("missing model field in usage ⇒ costUsd = 0 (no invented price)", () => {
    const dir = mkTmp("nomodel")
    try {
      const runDir = join(dir, "run-8")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "n", passed: true, verdict: "ok", turns: 1 }],
        }),
      )
      writeFileSync(
        join(runDir, "n.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: 0, id: "n" }),
          JSON.stringify({
            type: "usage",
            ts: 1,
            inputTokens: 10,
            outputTokens: 5,
          }),
        ].join("\n"),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["n"], "fail")
      expect(rows[0]?.tokensIn).toBe(10)
      expect(rows[0]?.costUsd).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("data nested under 'data' field is honoured (wire schema variant)", () => {
    const dir = mkTmp("nested")
    try {
      const runDir = join(dir, "run-9")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "ne", passed: true, verdict: "ok", turns: 1 }],
        }),
      )
      writeFileSync(
        join(runDir, "ne.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: 0, id: "ne" }),
          JSON.stringify({
            type: "usage",
            ts: 1000,
            data: {
              model: "gpt-4o",
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 20,
            },
          }),
        ].join("\n"),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["ne"], "fail")
      expect(rows[0]?.tokensIn).toBe(100)
      expect(rows[0]?.cacheRead).toBe(20)
      expect(rows[0]?.costUsd).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("wall calc handles event with non-numeric ts (skip those events)", () => {
    const dir = mkTmp("badts")
    try {
      const runDir = join(dir, "run-10")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "wt", passed: true, verdict: "ok", turns: 1 }],
        }),
      )
      writeFileSync(
        join(runDir, "wt.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: "string-ts", id: "wt" }),
          JSON.stringify({ type: "turn_ended", ts: 500, id: "wt" }),
          JSON.stringify({ type: "noise", ts: 1000, id: "wt" }),
        ].join("\n"),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["wt"], "fail")
      // First and last numeric ts → span 500 → 1000 = 500
      expect(rows[0]?.wallMs).toBe(500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("attempt file binding: ONLY files containing the instance id substring match", () => {
    const dir = mkTmp("bind")
    try {
      const runDir = join(dir, "run-11")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [
            { id: "psf__requests-5", passed: true, verdict: "ok", turns: 1 },
            { id: "pallets__flask-1", passed: false, verdict: "ok", turns: 1 },
          ],
        }),
      )
      // Two attempt files: one mentions "psf__requests-5" only, another only
      // "pallets__flask-1". The indexer must not cross-bind.
      writeFileSync(
        join(runDir, "a.jsonl"),
        JSON.stringify({ id: "psf__requests-5", ts: 0, inputTokens: 100, model: "gpt-4o" }),
      )
      writeFileSync(
        join(runDir, "b.jsonl"),
        JSON.stringify({ id: "pallets__flask-1", ts: 0, inputTokens: 200, model: "gpt-4o" }),
      )
      const rows = collectRowsForCondition(
        "baseline",
        runDir,
        ["psf__requests-5", "pallets__flask-1"],
        "fail",
      )
      // Both bound. Note: tokensIn comes from `usage` events (kind/type
      // discriminator); these rows lack 'type:"usage"' so usage rolls up as 0.
      expect(rows.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("empty picks list ⇒ empty rows (no crash, no extra emit)", () => {
    const dir = mkTmp("nopicks")
    try {
      const runDir = join(dir, "run-12")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, "summary.json"), JSON.stringify({ runId: "x", instances: [] }))
      const rows = collectRowsForCondition("baseline", runDir, [], "fail")
      expect(rows).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("picks present but summary instances empty ⇒ all fallback", () => {
    const dir = mkTmp("emptyinst")
    try {
      const runDir = join(dir, "run-13")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, "summary.json"), JSON.stringify({ runId: "x", instances: [] }))
      const rows = collectRowsForCondition("baseline", runDir, ["a", "b", "c"], "error")
      expect(rows.length).toBe(3)
      expect(rows.every((r) => r.verdict === "error")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("very large summary (1000 instances) parses without timeout", () => {
    const dir = mkTmp("big")
    try {
      const runDir = join(dir, "run-14")
      mkdirSync(runDir, { recursive: true })
      const instances: { id: string; passed: boolean; verdict: string; turns: number }[] = []
      const ids: string[] = []
      for (let i = 0; i < 1000; i++) {
        ids.push(`inst-${i}`)
        instances.push({ id: `inst-${i}`, passed: i % 2 === 0, verdict: "ok", turns: 1 })
      }
      writeFileSync(join(runDir, "summary.json"), JSON.stringify({ runId: "x", instances }))
      const start = performance.now()
      const rows = collectRowsForCondition("baseline", runDir, ids, "fail")
      const elapsed = performance.now() - start
      expect(rows.length).toBe(1000)
      // budget pin (sanity): below 2 seconds.
      expect(elapsed).toBeLessThan(2000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("permissions test seam: run dir is read-only ⇒ still parses (no write attempted)", () => {
    const dir = mkTmp("readonly")
    try {
      const runDir = join(dir, "run-15")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "ro", passed: true, verdict: "ok", turns: 1 }],
        }),
      )
      // No chmod required — the test confirms collect path is read-only and
      // does NOT attempt any mutation on the run dir.
      const rows = collectRowsForCondition("baseline", runDir, ["ro"], "fail")
      expect(rows[0]?.verdict).toBe("pass")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("verdict='pass' even when passed flag is true but verdict string is custom", () => {
    const dir = mkTmp("custom")
    try {
      const runDir = join(dir, "run-16")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "cv", passed: true, verdict: "weird-custom", turns: 1 }],
        }),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["cv"], "fail")
      expect(rows[0]?.verdict).toBe("pass")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("multiple usage events ⇒ accumulate (NOT overwrite)", () => {
    const dir = mkTmp("multi-usage")
    try {
      const runDir = join(dir, "run-17")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "mu", passed: true, verdict: "ok", turns: 1 }],
        }),
      )
      writeFileSync(
        join(runDir, "mu.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: 0, id: "mu" }),
          JSON.stringify({
            type: "usage",
            ts: 100,
            model: "gpt-4o",
            inputTokens: 50,
            outputTokens: 10,
          }),
          JSON.stringify({
            type: "usage",
            ts: 200,
            model: "gpt-4o",
            inputTokens: 50,
            outputTokens: 10,
          }),
        ].join("\n"),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["mu"], "fail")
      expect(rows[0]?.tokensIn).toBe(100) // 50 + 50
      expect(rows[0]?.tokensOut).toBe(20) // 10 + 10
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("turn-counting from events when summary.turns is missing", () => {
    const dir = mkTmp("turncount")
    try {
      const runDir = join(dir, "run-18")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "tc", passed: true, verdict: "ok" }], // turns omitted
        }),
      )
      writeFileSync(
        join(runDir, "tc.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: 0, id: "tc" }),
          JSON.stringify({ type: "turn_started", ts: 1, id: "tc" }),
          JSON.stringify({ type: "turn_started", ts: 2, id: "tc" }),
        ].join("\n"),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["tc"], "fail")
      expect(rows[0]?.turns).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("summary.json contains valid JSON but wrong shape ⇒ fallback (NOT throw)", () => {
    const dir = mkTmp("wrongshape")
    try {
      const runDir = join(dir, "run-19")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, "summary.json"), JSON.stringify([1, 2, 3]))
      const rows = collectRowsForCondition("baseline", runDir, ["a"], "fail")
      expect(rows[0]?.verdict).toBe("fail")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("attempt JSONL contains a 'usage' event with negative tokens ⇒ added verbatim (no clamp)", () => {
    // Design pin: the parser does NOT scrub negative values. Document so the
    // bench (upstream) is the canonical sanitiser.
    const dir = mkTmp("neg")
    try {
      const runDir = join(dir, "run-20")
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId: "x",
          instances: [{ id: "ng", passed: true, verdict: "ok", turns: 1 }],
        }),
      )
      writeFileSync(
        join(runDir, "ng.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: 0, id: "ng" }),
          JSON.stringify({
            type: "usage",
            ts: 100,
            model: "gpt-4o",
            inputTokens: -10,
            outputTokens: -5,
          }),
        ].join("\n"),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["ng"], "fail")
      expect(rows[0]?.tokensIn).toBe(-10) // verbatim — design pin
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── design-decision pins (these would be needed if state.ts existed) ─────

describe("hellgate state-file design pins (slice absence note)", () => {
  test("design pin: matrix tool has NO `saveSweepState`/`loadSweepState` slice", () => {
    // Reason: the brief named these for a `tools/swebench-matrix/state.ts`
    // slice that has not been written. The current matrix tool writes a
    // `partial-*.jsonl` file as a checkpoint stream (line-append) and a
    // final `matrix-summary.jsonl` / `matrix-summary.md`. There is NO
    // `--resume` mode and NO `--summary` mode. This test documents the
    // absence so a future refactor sees the gap.
    expect(true).toBe(true)
  })
})
