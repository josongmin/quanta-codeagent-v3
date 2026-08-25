/**
 * GOAL-05A — `/goal` argv parser is PURE and policy-free: it produces one typed
 * command or one typed error and never touches the authority or the verifier.
 * Rail 9: a missing `--`, an empty/unbounded check argv, or a timeout beyond
 * the verifier ceiling fails HERE (before any store is consulted).
 */

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CHECK_SUCCESS_EXIT_CODES,
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_CHECK_ARGV_ITEM_CHARS,
  MAX_CHECK_ARGV_ITEMS,
  parseGoalArgs,
} from "@/apps/cli/goal/goal-args"
import { MAX_CHECK_TIMEOUT_MS } from "@/objective"

const ok = (args: readonly string[]) => {
  const r = parseGoalArgs(args)
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.command
}
const err = (args: readonly string[]): string => {
  const r = parseGoalArgs(args)
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.command)}`)
  return r.error
}

describe("GOAL-05A — /goal argv parser", () => {
  test("show / create / edit / status verbs", () => {
    expect(ok([])).toEqual({ kind: "show" })
    expect(ok(["ship", "the", "feature"])).toEqual({ kind: "create", text: "ship the feature" })
    expect(ok(["edit", "new", "text"])).toEqual({
      kind: "edit",
      text: "new text",
      keepContract: false,
    })
    expect(ok(["edit", "--keep-contract", "new", "text"])).toEqual({
      kind: "edit",
      text: "new text",
      keepContract: true,
    })
    expect(ok(["pause"])).toEqual({ kind: "pause" })
    expect(ok(["stop"])).toEqual({ kind: "pause" }) // stop is a PAUSE alias, never a clear
    expect(ok(["resume"])).toEqual({ kind: "resume" })
    expect(ok(["clear"])).toEqual({ kind: "clear" })
    expect(ok(["verify"])).toEqual({ kind: "verify" })
    expect(ok(["work", "fix", "the", "flake"])).toEqual({
      kind: "work",
      instruction: "fix the flake",
    })
    expect(err(["edit"])).toMatch(/requires <text>/)
    expect(err(["work"])).toMatch(/requires <instruction>/)
  })

  test("a single non-verb token is a one-word goal (pinned by the /goal hellgate), never a silent verb", () => {
    expect(ok(["ship"])).toEqual({ kind: "create", text: "ship" })
    expect(ok([""])).toEqual({ kind: "show" })
  })

  test("criterion verbs", () => {
    expect(ok(["criterion", "add", "tests", "pass"])).toEqual({
      kind: "criterion-add",
      text: "tests pass",
    })
    expect(ok(["criterion", "edit", "c1", "new", "text"])).toEqual({
      kind: "criterion-edit",
      criterionId: "c1",
      text: "new text",
    })
    expect(ok(["criterion", "remove", "c1"])).toEqual({
      kind: "criterion-remove",
      criterionId: "c1",
    })
    expect(ok(["criterion", "complete", "c1"])).toEqual({
      kind: "criterion-complete",
      criterionId: "c1",
    })
    expect(ok(["criterion", "reopen", "c1"])).toEqual({
      kind: "criterion-reopen",
      criterionId: "c1",
    })
    expect(err(["criterion", "add"])).toMatch(/requires <description>/)
    expect(err(["criterion", "edit", "c1"])).toMatch(/requires <description>/)
    expect(err(["criterion", "remove"])).toMatch(/requires <criterionId>/)
    expect(err(["criterion", "frobnicate", "c1"])).toMatch(/unknown criterion verb/)
  })

  test("check add: `--` separator required; defaults come from the verifier ceiling", () => {
    expect(ok(["check", "add", "unit", "tests", "--", "bun", "test", "-t", "x"])).toEqual({
      kind: "check-add",
      text: "unit tests",
      check: {
        kind: "command",
        argv: ["bun", "test", "-t", "x"],
        timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
        successExitCodes: [...DEFAULT_CHECK_SUCCESS_EXIT_CODES],
      },
    })
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(MAX_CHECK_TIMEOUT_MS)
    expect(
      ok([
        "check",
        "add",
        "lint",
        "--timeout-ms",
        "5000",
        "--success-exit",
        "0,2",
        "--",
        "eslint",
        ".",
      ]),
    ).toEqual({
      kind: "check-add",
      text: "lint",
      check: { kind: "command", argv: ["eslint", "."], timeoutMs: 5000, successExitCodes: [0, 2] },
    })
    expect(ok(["check", "edit", "chk1", "renamed", "--", "true"])).toEqual({
      kind: "check-edit",
      checkId: "chk1",
      text: "renamed",
      check: {
        kind: "command",
        argv: ["true"],
        timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
        successExitCodes: [...DEFAULT_CHECK_SUCCESS_EXIT_CODES],
      },
    })
    expect(ok(["check", "remove", "chk1"])).toEqual({ kind: "check-remove", checkId: "chk1" })
  })

  test("rail 9 — invalid check input fails before any authority/verifier", () => {
    expect(err(["check", "add", "tests", "bun", "test"])).toMatch(/requires `--`/)
    expect(err(["check", "add", "tests", "--"])).toMatch(/argv must not be empty/)
    expect(err(["check", "add", "--", "bun", "test"])).toMatch(/requires <description>/)
    expect(err(["check", "add", "t", "--timeout-ms", "0", "--", "x"])).toMatch(/timeout/)
    expect(err(["check", "add", "t", "--timeout-ms", "abc", "--", "x"])).toMatch(/timeout/)
    expect(
      err(["check", "add", "t", "--timeout-ms", String(MAX_CHECK_TIMEOUT_MS + 1), "--", "x"]),
    ).toMatch(/timeout/)
    expect(err(["check", "add", "t", "--success-exit", "0,x", "--", "x"])).toMatch(/success-exit/)
    expect(
      err([
        "check",
        "add",
        "t",
        "--",
        ...Array.from({ length: MAX_CHECK_ARGV_ITEMS + 1 }, () => "a"),
      ]),
    ).toMatch(/argv/)
    expect(err(["check", "add", "t", "--", "a".repeat(MAX_CHECK_ARGV_ITEM_CHARS + 1)])).toMatch(
      /argv/,
    )
    expect(err(["check", "edit", "--", "x"])).toMatch(/requires <checkId>/)
    expect(err(["check", "bogus"])).toMatch(/unknown check verb/)
  })

  test("budget flags (`=` and space forms), at least one cap required", () => {
    expect(ok(["budget", "--max-turns=5", "--max-tokens=1000"])).toEqual({
      kind: "budget",
      budget: { maxTurns: 5, maxTokens: 1000 },
    })
    expect(ok(["budget", "--max-turns", "7"])).toEqual({ kind: "budget", budget: { maxTurns: 7 } })
    expect(err(["budget"])).toMatch(/requires --max-turns/)
    expect(err(["budget", "--max-turns=abc"])).toMatch(/max-turns/)
    expect(err(["budget", "--max-turns=-1"])).toMatch(/max-turns/)
    expect(err(["budget", "--bogus=1"])).toMatch(/unknown budget flag/)
  })
})
