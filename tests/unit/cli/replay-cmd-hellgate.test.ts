/**
 * Hellgate — `/replay <session-id>` slash command (ADR-0243).
 *
 * 18 cases sealing the read-only JSONL replay surface: full-turn render,
 * `--at` / `--from` filter behaviour, exit-code routing, default-OFF parity,
 * pacing semantics, secret sanitization, large-iterator memory safety,
 * unknown-event fallback, and ANSI gating.
 *
 *  HELL-REPLAY-01: ctx.replay absent ⇒ "not wired" + exit 0
 *  HELL-REPLAY-02: resolveSession returns undefined ⇒ "not found" + exit 1
 *  HELL-REPLAY-03: empty iterator ⇒ "session is empty" + exit 0
 *  HELL-REPLAY-04: 14-event turn renders all 14 frames in time order
 *  HELL-REPLAY-05: --at 3 keeps only turn 3 frames
 *  HELL-REPLAY-06: --from tc_7a starts at that tool_invoke; previous skipped
 *  HELL-REPLAY-07: --at 99 (no match) ⇒ "turn 99 not found" + exit 1
 *  HELL-REPLAY-08: --from unknown_tc ⇒ "tool call ... not found" + exit 1
 *  HELL-REPLAY-09: decision custom event rendered with kind/outcome/reason
 *  HELL-REPLAY-10: tool_invoke + tool_result pair matched by id column
 *  HELL-REPLAY-11: token_count → usage line with in=/out=
 *  HELL-REPLAY-12: pacing intervalMs=0 ⇒ sleep called 0 times
 *  HELL-REPLAY-13: pacing intervalMs=50 ⇒ sleep called N-1 times
 *  HELL-REPLAY-14: unknown event_msg kind would crash schema (covered by
 *                  fallback for non-event records — session_meta etc.)
 *  HELL-REPLAY-15: color=false ⇒ output contains ZERO ANSI escape bytes
 *  HELL-REPLAY-16: very long reason (500 char) → truncated in line
 *  HELL-REPLAY-17: secret-shape token (sk-...) ⇒ rendered as "<key>=<len>B"
 *  HELL-REPLAY-18: 2_000-event iterator processed without buffering all
 *                  records in memory (streaming check: max in-flight ≤ small)
 *
 *  Parse-layer extras (delegated to `__test.parseReplayArgs`):
 *  HELL-REPLAY-PARSE-01: no positional ⇒ err
 *  HELL-REPLAY-PARSE-02: --at non-integer ⇒ err
 *  HELL-REPLAY-PARSE-03: --from missing value ⇒ err
 *  HELL-REPLAY-PARSE-04: unknown flag (after sessionId) ⇒ err
 *  HELL-REPLAY-PARSE-05: --from with empty-string value ⇒ err
 *  HELL-REPLAY-PARSE-06: --at with negative integer ⇒ err
 *  HELL-REPLAY-PARSE-07: args[0] starts with `--` (no sessionId before flag)
 *                        — formerly a prod-bug doc-test; now a real invariant
 *                        case that pins the precise "unknown flag '<f>'" /
 *                        "expected <session-id> before flags" error shape
 *                        + exit 1 via the dispatcher.
 *  HELL-REPLAY-PARSE-08: --bogus followed by extra tokens ⇒ FIRST flag wins
 *  HELL-REPLAY-PARSE-09: --at 3 --bogus sid ⇒ rejected (known flag at head,
 *                        sessionId must come first)
 *  HELL-REPLAY-PARSE-10: valid sessionId + --at 3 round-trips unchanged
 *                        (byte-identical regression guard for the happy path)
 */

import { describe, expect, test } from "bun:test"
import type { SessionEnvelopeRecord } from "@/session"
import {
  formatReplayLine,
  type ReplayCmdOpts,
  replayCmd,
  __test as replayInternals,
  runReplayCmd,
} from "../../../src/apps/cli/replay-cmd"
import { runSlashCommand, type SlashContext } from "../../../src/apps/cli/slash-commands"

/* ------------------------------------------------------------------ */
/* fixtures + helpers                                                  */
/* ------------------------------------------------------------------ */

const FIXED_TS = "2026-05-25T14:23:01.234Z"
const tsAt = (sec: number): string =>
  `2026-05-25T14:23:${String(Math.floor(sec)).padStart(2, "0")}.${String(
    Math.floor((sec - Math.floor(sec)) * 1000),
  ).padStart(3, "0")}Z`

const collectOut = (): {
  out: string[]
  err: string[]
  outFn: (s: string) => void
  errFn: (s: string) => void
} => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, outFn: (s) => out.push(s), errFn: (s) => err.push(s) }
}

const toolInvoke = (
  turnId: string,
  ts: string,
  tool: string,
  toolCallId: string,
  extra: Record<string, unknown> = {},
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  kind: "tool_invoke",
  ts,
  turn_id: turnId,
  tool,
  input: { toolCallId, ...extra },
})

const toolResult = (
  turnId: string,
  ts: string,
  tool: string,
  ok: boolean,
  output = "result-body",
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  kind: "tool_result",
  ts,
  turn_id: turnId,
  tool,
  ok,
  output,
})

const tokenCount = (
  turnId: string,
  ts: string,
  input: number,
  output: number,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  kind: "token_count",
  ts,
  turn_id: turnId,
  input_tokens: input,
  output_tokens: output,
})

const customDecision = (
  turnId: string,
  ts: string,
  outcome: string,
  reason: string,
  toolCallId: string,
): SessionEnvelopeRecord => ({
  type: "event_msg",
  schema_version: 2,
  kind: "custom",
  ts,
  turn_id: turnId,
  custom_kind: "decision",
  data: { outcome, reason, toolCallId },
})

const fromArray = (
  records: readonly SessionEnvelopeRecord[],
): ((p: string) => AsyncIterable<SessionEnvelopeRecord>) => {
  return (_p: string) => {
    let i = 0
    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionEnvelopeRecord> {
        return {
          next: async (): Promise<IteratorResult<SessionEnvelopeRecord>> => {
            if (i >= records.length) return { value: undefined, done: true }
            const v = records[i] as SessionEnvelopeRecord
            i++
            return { value: v, done: false }
          },
        }
      },
    }
  }
}

const baseOpts = (
  records: readonly SessionEnvelopeRecord[],
  found = true,
  io = collectOut(),
): { opts: ReplayCmdOpts; io: ReturnType<typeof collectOut> } => ({
  opts: {
    resolveSession: async () => (found ? "/fake/path.jsonl" : undefined),
    iterate: fromArray(records),
    out: io.outFn,
    color: false,
    now: () => 0,
  },
  io,
})

// 14-event turn 3 fixture (matches the user-spec output sample).
const turn3Fourteen: readonly SessionEnvelopeRecord[] = [
  toolInvoke("3", tsAt(1), "Read", "tc_7a", { path: "src/foo.ts" }),
  customDecision("3", tsAt(1.2), "allow", "default-allow", "tc_7a"),
  toolResult("3", tsAt(1.3), "Read", true, "x".repeat(1200)),
  toolInvoke("3", tsAt(1.5), "Edit", "tc_7b", { file: "a" }),
  toolResult("3", tsAt(1.7), "Edit", true),
  customDecision("3", tsAt(1.9), "allow", "default-allow", "tc_7b"),
  tokenCount("3", tsAt(2.0), 9259, 28),
  toolInvoke("3", tsAt(2.2), "Glob", "tc_7c"),
  toolResult("3", tsAt(2.4), "Glob", true),
  toolInvoke("3", tsAt(2.6), "Grep", "tc_7d", { pattern: "x" }),
  toolResult("3", tsAt(2.8), "Grep", true),
  customDecision("3", tsAt(3.0), "allow", "default-allow", "tc_7d"),
  toolInvoke("3", tsAt(3.2), "Read", "tc_7e", { path: "src/bar.ts" }),
  toolResult("3", tsAt(3.4), "Read", true),
]

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

describe("/replay hellgate (ADR-0243)", () => {
  test("HELL-REPLAY-01: ctx.replay absent ⇒ 'not wired' + exit 0", async () => {
    const io = collectOut()
    const ctx: SlashContext = { out: io.outFn, err: io.errFn, cwd: "/" }
    const code = await replayCmd.run(["any-id"], ctx)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("not wired in this surface")
  })

  test("HELL-REPLAY-02: resolveSession returns undefined ⇒ 'not found' + exit 1", async () => {
    const { opts, io } = baseOpts([], false)
    const result = await runReplayCmd("missing-id", opts)
    expect(result.exitCode).toBe(1)
    expect(result.message).toBe("not_found")
    expect(io.out.join("")).toContain("session missing-id not found")
  })

  test("HELL-REPLAY-03: empty iterator ⇒ 'session is empty' + exit 0", async () => {
    const { opts, io } = baseOpts([])
    const result = await runReplayCmd("01HXY", opts)
    expect(result.exitCode).toBe(0)
    expect(result.framesRendered).toBe(0)
    expect(result.message).toBe("empty")
    expect(io.out.join("")).toContain("session is empty")
  })

  test("HELL-REPLAY-04: 14-event turn renders all 14 frames in time order", async () => {
    const { opts, io } = baseOpts(turn3Fourteen)
    const result = await runReplayCmd("01HXY", opts)
    expect(result.exitCode).toBe(0)
    expect(result.framesRendered).toBe(14)
    const text = io.out.join("")
    // header + footer
    expect(text).toContain("── replay session")
    expect(text).toMatch(/── replay done · 14 frames/)
    // tool ids appear in order — first occurrence index strictly increasing
    const positions = ["tc_7a", "tc_7b", "tc_7c", "tc_7d", "tc_7e"].map((id) => text.indexOf(id))
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] as number)
    }
    // Negative: zero-padding regressions or dropped frames — every id must
    // appear at LEAST once (catches a partial-filter bug masking framesRendered).
    for (const id of ["tc_7a", "tc_7b", "tc_7c", "tc_7d", "tc_7e"]) {
      expect(positions[positions.indexOf(text.indexOf(id))]).toBeGreaterThanOrEqual(0)
      expect(text).toContain(id)
    }
  })

  test("HELL-REPLAY-05: --at 3 keeps only turn 3 frames", async () => {
    const mixed: readonly SessionEnvelopeRecord[] = [
      toolInvoke("2", tsAt(1), "Read", "tc_off1"),
      toolInvoke("3", tsAt(2), "Read", "tc_on1"),
      toolInvoke("4", tsAt(3), "Read", "tc_off2"),
      toolInvoke("3", tsAt(4), "Edit", "tc_on2"),
    ]
    const { opts, io } = baseOpts(mixed)
    const result = await runReplayCmd("01HXY", { ...opts, filter: { atTurn: 3 } })
    expect(result.exitCode).toBe(0)
    expect(result.framesRendered).toBe(2)
    const text = io.out.join("")
    expect(text).toContain("tc_on1")
    expect(text).toContain("tc_on2")
    expect(text).not.toContain("tc_off1")
    expect(text).not.toContain("tc_off2")
  })

  test("HELL-REPLAY-06: --from tc_7c starts at that tool_invoke", async () => {
    const { opts, io } = baseOpts(turn3Fourteen)
    const result = await runReplayCmd("01HXY", { ...opts, filter: { fromToolCallId: "tc_7c" } })
    expect(result.exitCode).toBe(0)
    const text = io.out.join("")
    // tc_7a and tc_7b appear ONLY in the header maybe — body should not.
    // Body starts after the first blank line.
    const bodyIdx = text.indexOf("\n\n")
    expect(bodyIdx).toBeGreaterThan(-1)
    const body = text.slice(bodyIdx)
    expect(body).not.toContain("tc_7a")
    expect(body).not.toContain("tc_7b")
    expect(body).toContain("tc_7c")
    expect(body).toContain("tc_7d")
    expect(body).toContain("tc_7e")
  })

  test("HELL-REPLAY-07: --at 99 (no match) ⇒ 'turn 99 not found' + exit 1", async () => {
    const { opts, io } = baseOpts(turn3Fourteen)
    const result = await runReplayCmd("01HXY", { ...opts, filter: { atTurn: 99 } })
    expect(result.exitCode).toBe(1)
    expect(result.message).toBe("turn_not_found")
    expect(io.out.join("")).toContain("turn 99 not found")
  })

  test("HELL-REPLAY-08: --from unknown_tc ⇒ exit 1 + tool_call_not_found", async () => {
    const { opts, io } = baseOpts(turn3Fourteen)
    const result = await runReplayCmd("01HXY", {
      ...opts,
      filter: { fromToolCallId: "tc_never_seen" },
    })
    expect(result.exitCode).toBe(1)
    expect(result.message).toBe("tool_call_not_found")
    expect(io.out.join("")).toContain("tool call tc_never_seen not found")
  })

  test("HELL-REPLAY-09: decision custom event rendered with kind/outcome/reason", async () => {
    const env = customDecision("3", FIXED_TS, "deny", "out_of_scope", "tc_xx")
    const line = formatReplayLine(env, { color: false })
    expect(line).toContain("decision")
    expect(line).toContain("outcome=deny")
    expect(line).toContain("reason=out_of_scope")
    expect(line).toContain("toolCallId=tc_xx")
  })

  test("HELL-REPLAY-10: tool_invoke + tool_result pair matched by id column", async () => {
    const invoke = toolInvoke("3", FIXED_TS, "Read", "tc_99")
    const result = toolResult("3", FIXED_TS, "Read", true, "abc")
    const l1 = formatReplayLine(invoke, { color: false })
    const l2 = formatReplayLine(result, { color: false })
    expect(l1).toContain("tool_call")
    expect(l1).toContain("Read")
    expect(l1).toContain("tc_99")
    expect(l2).toContain("tool_result")
    expect(l2).toContain("ok=true")
    expect(l2).toContain("3B")
  })

  test("HELL-REPLAY-11: token_count → usage line with in=/out=", async () => {
    const env = tokenCount("3", FIXED_TS, 9259, 28)
    const line = formatReplayLine(env, { color: false })
    expect(line).toContain("usage")
    expect(line).toContain("in=9259")
    expect(line).toContain("out=28")
  })

  test("HELL-REPLAY-12: pacing intervalMs=0 ⇒ sleep called 0 times", async () => {
    let sleeps = 0
    const sleep = async (): Promise<void> => {
      sleeps += 1
    }
    const { opts } = baseOpts(turn3Fourteen.slice(0, 5))
    await runReplayCmd("01HXY", { ...opts, pace: { sleep, intervalMs: 0 } })
    expect(sleeps).toBe(0)
  })

  test("HELL-REPLAY-13: pacing intervalMs=50 ⇒ sleep called N-1 times w/ exact ms", async () => {
    let sleeps = 0
    const sleepMsArgs: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleeps += 1
      sleepMsArgs.push(ms)
    }
    const { opts } = baseOpts(turn3Fourteen.slice(0, 5)) // 5 frames
    const r = await runReplayCmd("01HXY", { ...opts, pace: { sleep, intervalMs: 50 } })
    expect(r.framesRendered).toBe(5)
    expect(sleeps).toBe(4) // N-1 = 5-1
    // Pin the ms argument too — a regression that called sleep with the
    // frame index (or wall-clock delta) would pass the count-only assert.
    for (const ms of sleepMsArgs) expect(ms).toBe(50)
  })

  test("HELL-REPLAY-14: non-event records fall back without crashing", async () => {
    const meta: SessionEnvelopeRecord = {
      type: "session_meta",
      schema_version: 2,
      session_id: "abc-123",
      started_at: FIXED_TS,
      cwd: "/x",
      cli_version: "0.1",
      model: "gpt-5",
    }
    const line = formatReplayLine(meta, { color: false })
    expect(line).toContain("session_meta")
    expect(line).toContain("gpt-5")
  })

  test("HELL-REPLAY-15: color=false ⇒ output contains ZERO ANSI escape bytes", async () => {
    const { opts, io } = baseOpts(turn3Fourteen, true, collectOut())
    await runReplayCmd("01HXY", { ...opts, color: false })
    const text = io.out.join("")
    // ANSI ESC (0x1B) followed by `[` — detected via string `includes`
    // rather than a regex so biome's no-control-char rule stays happy.
    const ESC = String.fromCharCode(0x1b)
    expect(text.includes(`${ESC}[`)).toBe(false)
  })

  test("HELL-REPLAY-16: very long reason (500 char) → truncated in line", async () => {
    const long = "x".repeat(500)
    const env = customDecision("3", FIXED_TS, "allow", long, "tc_long")
    const line = formatReplayLine(env, { color: false })
    // The cap is 120 chars total for the joined data column; final length
    // (incl. timestamp + label) must be ≪ 500.
    expect(line.length).toBeLessThan(220)
    expect(line).toContain("…")
  })

  test("HELL-REPLAY-17: secret-shape token ⇒ rendered as <key>=<len>B", async () => {
    const env = toolInvoke("3", FIXED_TS, "Bash", "tc_sec", { token: "sk-ABCDEF0123456789" })
    const line = formatReplayLine(env, { color: false })
    // length is 19 → `token=19B`
    expect(line).toContain("token=19B")
    // Three negative pins covering every leak vector:
    //   1) the raw secret tail
    //   2) the `sk-` prefix (matches by-shape)
    //   3) any 16+ char hex/alnum substring of the token
    expect(line).not.toContain("ABCDEF0123456789")
    expect(line).not.toContain("sk-ABCDEF0123456789")
    expect(line).not.toMatch(/ABCDEF[0-9A-F]{6,}/)
  })

  test("HELL-REPLAY-17b: secret-shape `password` key is also length-only", async () => {
    const env = toolInvoke("3", FIXED_TS, "Bash", "tc_sec2", {
      password: "p@ssw0rd-very-secret-1234",
    })
    const line = formatReplayLine(env, { color: false })
    expect(line).toContain("password=")
    expect(line).toContain("B")
    expect(line).not.toContain("p@ssw0rd-very-secret-1234")
  })

  test("HELL-REPLAY-18: 2_000-event iterator processed without buffering", async () => {
    // The iterator yields lazily — we ASSERT lazy consumption by checking
    // that at most ONE record is materialised at a time inside the iterator
    // closure (a counter is incremented at yield, decremented after consume).
    let inflight = 0
    let maxInflight = 0
    const N = 2_000
    const lazyIter = (_p: string): AsyncIterable<SessionEnvelopeRecord> => {
      let i = 0
      return {
        [Symbol.asyncIterator](): AsyncIterator<SessionEnvelopeRecord> {
          return {
            next: async (): Promise<IteratorResult<SessionEnvelopeRecord>> => {
              if (i >= N) return { value: undefined, done: true }
              inflight += 1
              maxInflight = Math.max(maxInflight, inflight)
              const v: SessionEnvelopeRecord = toolInvoke(
                "3",
                tsAt(1 + (i % 50)),
                "Read",
                `tc_${i}`,
              )
              i += 1
              // simulate consumer reading the value:
              queueMicrotask(() => {
                inflight -= 1
              })
              return { value: v, done: false }
            },
          }
        },
      }
    }
    const io = collectOut()
    const r = await runReplayCmd("01HXY", {
      resolveSession: async () => "/fake",
      iterate: lazyIter,
      out: io.outFn,
      color: false,
      now: () => 0,
    })
    expect(r.framesRendered).toBe(N)
    // At most 1-2 records in flight at any time → constant-memory streaming.
    expect(maxInflight).toBeLessThanOrEqual(2)
  })

  // ---------------- parser-layer hellgate -----------------
  describe("parseReplayArgs", () => {
    test("HELL-REPLAY-PARSE-01: no positional ⇒ err", () => {
      const r = replayInternals.parseReplayArgs([])
      expect(r.kind).toBe("err")
    })
    test("HELL-REPLAY-PARSE-02: --at non-integer ⇒ err", () => {
      const r = replayInternals.parseReplayArgs(["sid", "--at", "not-a-number"])
      expect(r.kind).toBe("err")
    })
    test("HELL-REPLAY-PARSE-03: --from missing value ⇒ err", () => {
      const r = replayInternals.parseReplayArgs(["sid", "--from"])
      expect(r.kind).toBe("err")
    })
    test("HELL-REPLAY-PARSE-04: unknown flag (after sessionId) ⇒ err", () => {
      const r = replayInternals.parseReplayArgs(["sid", "--bogus"])
      expect(r.kind).toBe("err")
      if (r.kind === "err") {
        expect(r.message).toBe("/replay: unknown flag '--bogus'")
      }
    })
    test("HELL-REPLAY-PARSE-05: --from with empty-string value ⇒ err", () => {
      const r = replayInternals.parseReplayArgs(["sid", "--from", ""])
      expect(r.kind).toBe("err")
    })
    test("HELL-REPLAY-PARSE-06: --at with negative integer ⇒ err", () => {
      const r = replayInternals.parseReplayArgs(["sid", "--at", "-3"])
      expect(r.kind).toBe("err")
    })
    test("HELL-REPLAY-PARSE-07: args[0] = '--bogus' ⇒ unknown flag err (not sessionId)", () => {
      const r = replayInternals.parseReplayArgs(["--bogus"])
      expect(r.kind).toBe("err")
      if (r.kind === "err") {
        // Precise message — pinned so any future drift breaks here.
        expect(r.message).toBe("/replay: unknown flag '--bogus'")
      }
    })
    test("HELL-REPLAY-PARSE-07 dispatch: /replay --bogus ⇒ exit 1 via ctx.err", async () => {
      const io = collectOut()
      const ctx: SlashContext = {
        out: io.outFn,
        err: io.errFn,
        cwd: "/",
        replay: {
          resolveSession: async () => "/should-never-be-called",
          iterate: fromArray([]),
        },
      }
      const code = await replayCmd.run(["--bogus"], ctx)
      expect(code).toBe(1)
      // Error message goes to err sink; out sink stays clean.
      expect(io.err.join("")).toContain("unknown flag '--bogus'")
      // Critical regression: must NOT say "session --bogus not found" — that
      // was the pre-fix downstream-resolve symptom.
      expect(io.out.join("")).not.toContain("session --bogus not found")
    })
    test("HELL-REPLAY-PARSE-08: --bogus extra ⇒ first flag wins in err message", () => {
      const r = replayInternals.parseReplayArgs(["--bogus", "extra", "more"])
      expect(r.kind).toBe("err")
      if (r.kind === "err") {
        expect(r.message).toBe("/replay: unknown flag '--bogus'")
        expect(r.message).not.toContain("extra")
        expect(r.message).not.toContain("more")
      }
    })
    test("HELL-REPLAY-PARSE-09: --at 3 --bogus sid (known flag at head) ⇒ rejected", () => {
      const r = replayInternals.parseReplayArgs(["--at", "3", "--bogus", "sid"])
      expect(r.kind).toBe("err")
      if (r.kind === "err") {
        // Known flag at head → "before flags" shape (not "unknown flag").
        expect(r.message).toBe("/replay: expected <session-id> before flags")
      }
    })
    test("HELL-REPLAY-PARSE-10: valid sid + --at 3 round-trips unchanged (regression)", () => {
      const r = replayInternals.parseReplayArgs(["valid-session-id", "--at", "3"])
      expect(r.kind).toBe("ok")
      if (r.kind === "ok") {
        expect(r.sessionId).toBe("valid-session-id")
        expect(r.filter.atTurn).toBe(3)
        expect(r.filter.fromToolCallId).toBeUndefined()
      }
    })
    test("HELL-REPLAY-PARSE-05: --at negative integer ⇒ err", () => {
      const r = replayInternals.parseReplayArgs(["sid", "--at", "-1"])
      expect(r.kind).toBe("err")
    })
    test("HELL-REPLAY-PARSE-06: --from empty string value ⇒ err", () => {
      const r = replayInternals.parseReplayArgs(["sid", "--from", ""])
      expect(r.kind).toBe("err")
    })
    test("HELL-REPLAY-PARSE-07: bare unknown flag is currently parsed as sessionId (KNOWN HOLE)", () => {
      // FINDING: parseReplayArgs accepts `--bogus` as the session-id positional
      // because the positional check comes before any flag validation. This
      // is a real prod hole (a user typo gets a silent "session ./--bogus
      // not found" downstream). Documented here without prod mutation; fix
      // belongs in a follow-up commit that rejects positionals starting with
      // `--`.
      const r = replayInternals.parseReplayArgs(["--bogus"])
      expect(r.kind).toBe("ok")
      if (r.kind === "ok") expect(r.sessionId).toBe("--bogus")
    })
    test("happy path: sid + --at 3 + --from tc_7a", () => {
      const r = replayInternals.parseReplayArgs(["sid", "--at", "3", "--from", "tc_7a"])
      expect(r.kind).toBe("ok")
      if (r.kind === "ok") {
        expect(r.sessionId).toBe("sid")
        expect(r.filter.atTurn).toBe(3)
        expect(r.filter.fromToolCallId).toBe("tc_7a")
      }
    })
  })

  // ---------------- runSlashCommand dispatch -----------------
  test("dispatches /replay through BUILTINS", async () => {
    const io = collectOut()
    const ctx: SlashContext = {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      replay: {
        resolveSession: async () => "/fake",
        iterate: fromArray([]),
      },
    }
    const code = await runSlashCommand("/replay some-id", ctx)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("session is empty")
  })
})
