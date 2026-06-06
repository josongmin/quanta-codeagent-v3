/**
 * OCP refactor — differential / property contract for `parseAgentArgs`.
 *
 * `host/runtime/agent-args.ts` replaced a giant flag if/else-if chain with a
 * `FLAG_HANDLERS` dispatch table (one entry per flag). This file is the
 * behavior-PRESERVATION proof: a declarative table of representative AND
 * adversarial argv arrays → the EXACT `AgentArgs` output (or the EXACT thrown
 * message). It is intentionally separate from `cli-args.test.ts` (the
 * pre-existing per-rule contract, left untouched) so the dispatch-table seam
 * has its own pinned spec.
 *
 * Every parse-form the legacy chain accepted is enumerated:
 *  - value forms: ONLY `--x v` (space-separated). `--x=v` is NOT a recognized
 *    form — it is an unknown flag (pinned below as adversarial), so the
 *    refactor must NOT start splitting on `=`.
 *  - boolean flags (`--dry-run`, `--sticky-model`, `--no-auto-background`,
 *    `--playbook-trigger`) take no value.
 *  - alias: `-p` ⇔ `--prompt` (canonicalized for the dup guard).
 *  - unknown flag / bare `-` / positional token → hard throw `unknown flag`.
 *  - duplicate flag → hard throw `specified more than once`.
 *  - `--` is NOT a terminator here (no positional mode) — it is an unknown flag.
 */
import { describe, expect, test } from "bun:test"
import { AgentArgsError, parseAgentArgs } from "@/../src/apps/agent/cli-args"
import type { AgentArgs } from "@/host/runtime/agent-args"

// ── argv → expected AgentArgs (deep-equality) ──────────────────────────────
const OK_CASES: { name: string; argv: string[]; expected: AgentArgs }[] = [
  {
    name: "minimal interactive",
    argv: ["--mode", "interactive"],
    expected: { mode: "interactive", dials: {}, help: false },
  },
  {
    name: "headless via -p alias",
    argv: ["--mode", "headless", "-p", "do the thing"],
    expected: { mode: "headless", dials: {}, help: false, prompt: "do the thing" },
  },
  {
    name: "headless via --prompt",
    argv: ["--mode", "headless", "--prompt", "task body"],
    expected: { mode: "headless", dials: {}, help: false, prompt: "task body" },
  },
  {
    name: "batch corpus + instance + predictions + report",
    argv: [
      "--mode",
      "batch",
      "--corpus",
      "/tmp/c",
      "--instance",
      "x_1",
      "--predictions",
      "/p.jsonl",
      "--report",
      "/r.json",
    ],
    expected: {
      mode: "batch",
      dials: {},
      help: false,
      corpus: "/tmp/c",
      instance: "x_1",
      predictions: "/p.jsonl",
      report: "/r.json",
    },
  },
  {
    name: "ci-bot --pr + --dry-run boolean",
    argv: ["--mode", "ci-bot", "--pr", "42", "--dry-run"],
    expected: { mode: "ci-bot", dials: {}, help: false, pr: "42", ciBotDryRun: true },
  },
  {
    name: "model + provider",
    argv: ["--mode", "interactive", "--model", "gpt-5-mini", "--provider", "openai"],
    expected: {
      mode: "interactive",
      dials: {},
      help: false,
      model: "gpt-5-mini",
      provider: "openai",
    },
  },
  {
    name: "every dial (int) + fractional max-cost-usd",
    argv: [
      "--mode",
      "interactive",
      "--max-turns",
      "50",
      "--max-wall-clock-ms",
      "1800000",
      "--max-cost-usd",
      ".5",
    ],
    expected: {
      mode: "interactive",
      dials: { maxTurns: 50, maxWallClockMs: 1800000, maxCostUsd: 0.5 },
      help: false,
    },
  },
  {
    name: "exhaustion enum",
    argv: ["--mode", "interactive", "--exhaustion", "stop-with-summary"],
    expected: { mode: "interactive", dials: {}, help: false, exhaustion: "stop-with-summary" },
  },
  {
    name: "all ADR-0236 mega-wire flags together",
    argv: [
      "--mode",
      "interactive",
      "--tool-profile",
      "minimal",
      "--sticky-model",
      "--identity-mode",
      "review",
      "--focus-chain-every",
      "3",
      "--no-auto-background",
      "--playbook-trigger",
      "--permission-profile",
      "restricted",
    ],
    expected: {
      mode: "interactive",
      dials: {},
      help: false,
      toolProfile: "minimal",
      stickyModel: true,
      identityMode: "review",
      focusChainEvery: 3,
      noAutoBackground: true,
      playbookTrigger: true,
      permissionProfile: "restricted",
    },
  },
  {
    name: "help short-circuits past invalid mode (placeholder mode)",
    argv: ["--mode", "wat", "--help"],
    expected: { mode: "interactive", dials: {}, help: true },
  },
  {
    name: "-h short-circuit",
    argv: ["-h"],
    expected: { mode: "interactive", dials: {}, help: true },
  },
]

// ── argv → expected thrown message (adversarial + edge) ────────────────────
const THROW_CASES: { name: string; argv: string[]; match: RegExp }[] = [
  { name: "no args (mode required)", argv: [], match: /--mode is required/ },
  { name: "unknown flag", argv: ["--mode", "interactive", "--foo"], match: /unknown flag '--foo'/ },
  // `--x=v` is NOT a recognized value form — pinned as unknown so the refactor
  // never grows `=`-splitting behavior.
  {
    name: "--x=v is unknown",
    argv: ["--mode=interactive"],
    match: /unknown flag '--mode=interactive'/,
  },
  {
    name: "dial=empty is unknown",
    argv: ["--mode", "interactive", "--max-turns="],
    match: /unknown flag '--max-turns='/,
  },
  // Bare single dash.
  { name: "bare dash unknown", argv: ["-"], match: /unknown flag '-'/ },
  // `--` is not a positional terminator in this parser.
  {
    name: "double-dash unknown",
    argv: ["--mode", "interactive", "--"],
    match: /unknown flag '--'/,
  },
  // Stray positional after a valid mode.
  {
    name: "positional token unknown",
    argv: ["--mode", "interactive", "junk"],
    match: /unknown flag 'junk'/,
  },
  // Value that looks like a flag.
  {
    name: "value-looks-like-flag rejected",
    argv: ["--mode", "interactive", "--model", "--provider"],
    match: /flag '--model' requires a value/,
  },
  // Missing value at end of argv.
  { name: "flag missing value at end", argv: ["--mode"], match: /requires a value/ },
  // Duplicate flags.
  {
    name: "duplicate --mode",
    argv: ["--mode", "interactive", "--mode", "headless"],
    match: /flag '--mode' specified more than once/,
  },
  {
    name: "duplicate boolean --sticky-model",
    argv: ["--mode", "interactive", "--sticky-model", "--sticky-model"],
    match: /flag '--sticky-model' specified more than once/,
  },
  // -p / --prompt canonicalize to the same key for the dup guard.
  {
    name: "-p then --prompt is a duplicate",
    argv: ["--mode", "headless", "-p", "a", "--prompt", "b"],
    match: /flag '--prompt' specified more than once/,
  },
  // Enum validation.
  { name: "invalid --mode", argv: ["--mode", "wat"], match: /--mode must be/ },
  {
    name: "invalid --provider",
    argv: ["--mode", "interactive", "--provider", "google"],
    match: /--provider must be/,
  },
  {
    name: "invalid --tool-profile",
    argv: ["--mode", "interactive", "--tool-profile", "nope"],
    match: /--tool-profile must be/,
  },
  // Integer parsing.
  {
    name: "non-integer dial",
    argv: ["--mode", "interactive", "--max-turns", "abc"],
    match: /expects an integer/,
  },
  {
    name: "negative dial",
    argv: ["--mode", "interactive", "--max-turns", "-1"],
    match: /must be >= 0/,
  },
  {
    name: "focus-chain-every 0 rejected",
    argv: ["--mode", "interactive", "--focus-chain-every", "0"],
    match: /must be > 0, got 0/,
  },
  // Mode-companion cross-validation (both directions).
  {
    name: "--corpus outside batch",
    argv: ["--mode", "interactive", "--corpus", "/x"],
    match: /--corpus is only valid with --mode batch/,
  },
  {
    name: "--pr outside ci-bot",
    argv: ["--mode", "headless", "--pr", "7"],
    match: /--pr is only valid with --mode ci-bot/,
  },
  {
    name: "ci-bot missing --pr",
    argv: ["--mode", "ci-bot"],
    match: /--pr is required with --mode ci-bot/,
  },
  {
    name: "batch missing --corpus",
    argv: ["--mode", "batch"],
    match: /--corpus is required with --mode batch/,
  },
  {
    name: "headless missing --prompt",
    argv: ["--mode", "headless"],
    match: /-p\/--prompt is required with --mode headless/,
  },
]

describe("parseAgentArgs dispatch-table — differential argv → AgentArgs", () => {
  for (const c of OK_CASES) {
    test(`OK: ${c.name}`, () => {
      expect(parseAgentArgs(c.argv)).toEqual(c.expected)
    })
  }
})

describe("parseAgentArgs dispatch-table — adversarial argv → throw", () => {
  for (const c of THROW_CASES) {
    test(`THROW: ${c.name}`, () => {
      expect(() => parseAgentArgs(c.argv)).toThrow(AgentArgsError)
      expect(() => parseAgentArgs(c.argv)).toThrow(c.match)
    })
  }
})

describe("parseAgentArgs dispatch-table — flag-order independence", () => {
  // The same flags in a different order must yield the same AgentArgs (the
  // dispatch table has no positional coupling between independent flags).
  test("reordering independent flags is invariant", () => {
    const a = parseAgentArgs([
      "--mode",
      "interactive",
      "--model",
      "m",
      "--max-turns",
      "5",
      "--provider",
      "anthropic",
    ])
    const b = parseAgentArgs([
      "--provider",
      "anthropic",
      "--max-turns",
      "5",
      "--model",
      "m",
      "--mode",
      "interactive",
    ])
    expect(a).toEqual(b)
  })
})
