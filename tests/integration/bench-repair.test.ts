/**
 * b2 — bench repair-rounds integration (RFC §16, ADR-0014).
 *
 * Drives the REAL `runInstance` end-to-end with a FakeLLM and a local
 * `testCmd` (NO real network, NO Python harness). Pins:
 *
 *   1. default-OFF byte-identical (no `deps.repair` ⇒ 1 agent run, 1 verify).
 *   2. round0 fails → round1 passes (validator gates the loop).
 *   3. maxRounds cap (validator never ok ⇒ exactly maxRounds+1 agent runs).
 *   4. single sandbox / continue-from-patched-tree (round N+1 sees N's edits).
 *   5. no-leak (seedMsg never carries any forbidden dataset token).
 *   6. lastVerifyCmd plumbing (the agent's bash command reaches the validator).
 *
 * Gating mirrors the SWEBENCH_DIRECTIVE / verifyGuard posture: the repair path
 * engages ONLY when `deps.repair !== undefined && instance.swebench !== undefined`.
 * Tests construct an Instance with synthetic `swebench` metadata so the gate
 * fires without touching the real Python harness.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ValidateArgs, ValidatorResult } from "../../src/apps/bench/repair/types"
import { runInstance } from "../../src/apps/bench/runner"
import type { Instance } from "../../src/apps/bench/types"

const DEPS = { maxTurns: 5, timeoutMs: 30000 }

/** Build a one-file synthetic repo with a planted bug + a `swebench` field so
 *  the repair gate engages. `testCmd` is the local verifier (no Python harness
 *  injected ⇒ the runner's default exec path grades it).
 *
 *  The `swebench` field is a TEST-ONLY synthetic — it engages the repair gate
 *  without invoking the real Python harness (deps.pythonSwebench absent ⇒
 *  verify() falls through to the local testCmd). No real instanceId is
 *  contacted; nothing is fetched. */
const makeSwebenchInstance = (dir: string, id: string): Instance => {
  const repo = join(dir, `repo-${id}`)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, "math.js"), "exports.add = function(a, b) { return a - b }\n")
  return {
    id,
    repoPath: repo,
    problemStatement: `Fix the planted bug in math.js — add(a,b) must return a+b, not a-b.`,
    testCmd: `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`,
    swebench: {
      instanceId: id,
      repo: `synthetic/${id}`,
      baseCommit: "HEAD",
    },
  }
}

/**
 * Scripted FakeLLM for repair-loop driving. The script is an ordered list of
 * "scenes" — one scene per `runAgent` invocation (i.e. one per repair round).
 * A scene's behavior is a sequence of "turn outputs"; the fake advances within
 * a scene as the agent's inner turn loop spins.
 *
 * A new agent run is detected by the SEED text (messages[0]) changing — the
 * agent loop preserves the seed user message at index 0 across turns within
 * one runAgent, and a brand-new runAgent always provides a fresh seed
 * (possibly augmented with the repair seedMsg). This avoids depending on the
 * turn-context/system-reminder injection at index 1.
 */
type Scene =
  | { kind: "noop" }
  | { kind: "edit"; file: string; old: string; new: string }
  | { kind: "editAndBash"; file: string; old: string; new: string; bash: string }
  | { kind: "bashOnly"; bash: string }

class ScriptedLLM implements LLMPort {
  /** Per-scene turn cursor; reset when a fresh runAgent is detected. */
  private turnInScene = 0
  /** Index into `scenes`; advances at the START of a new runAgent. */
  private sceneIdx = -1
  /** Seed user-message text of each runAgent (one entry per agent run). */
  readonly seedTextsSeen: string[] = []
  /** How many full agent runs (scenes) we've consumed. */
  agentRuns = 0
  /** Last seed text we saw — used to detect a fresh runAgent (seed changed). */
  private lastSeed: string | undefined

  constructor(private readonly scenes: readonly Scene[]) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // Canonical "new runAgent" signal: the FIRST message (the seed) differs
    // from the previous turn's first message. The agent loop preserves the
    // seed user message at index 0; subsequent turns only APPEND (assistant +
    // tool_result + later user nudges). A brand-new runAgent starts with a
    // fresh seed (possibly the same problem statement, plus an optional
    // repair seedMsg). Comparing index-0 text avoids depending on the
    // turn-context (system-reminder) injection at index 1.
    const seedText =
      input.messages[0]?.content.map((b) => (b.type === "text" ? b.text : "")).join("\n") ?? ""
    if (seedText !== this.lastSeed) {
      this.agentRuns += 1
      this.sceneIdx += 1
      this.turnInScene = 0
      this.seedTextsSeen.push(seedText)
      this.lastSeed = seedText
    }
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    const scene = this.scenes[Math.min(this.sceneIdx, this.scenes.length - 1)] ?? {
      kind: "noop" as const,
    }
    const turn = this.turnInScene
    this.turnInScene += 1
    // Turn 0 of a scene: emit the tool action (if any).
    if (turn === 0 && scene.kind !== "noop") {
      if (scene.kind === "edit" || scene.kind === "editAndBash") {
        yield { type: "tool_use_start", id: `e${this.sceneIdx}`, name: "edit" }
        yield {
          type: "tool_use_end",
          id: `e${this.sceneIdx}`,
          input: {
            path: join(sandbox, scene.file),
            old_string: scene.old,
            new_string: scene.new,
          },
        }
        yield { type: "message_stop", stop_reason: "tool_use" }
        return
      }
      if (scene.kind === "bashOnly") {
        yield { type: "tool_use_start", id: `b${this.sceneIdx}`, name: "bash" }
        yield {
          type: "tool_use_end",
          id: `b${this.sceneIdx}`,
          input: { command: scene.bash },
        }
        yield { type: "message_stop", stop_reason: "tool_use" }
        return
      }
    }
    // Turn 1 of an editAndBash scene: emit the bash.
    if (turn === 1 && scene.kind === "editAndBash") {
      yield { type: "tool_use_start", id: `b${this.sceneIdx}`, name: "bash" }
      yield {
        type: "tool_use_end",
        id: `b${this.sceneIdx}`,
        input: { command: scene.bash },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    // Any later turn (incl. verify-guard nudges, or after edits): terminate.
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const withTmp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "bench-repair-"))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const FORBIDDEN_TOKENS = ["FAIL_TO_PASS", "PASS_TO_PASS", "test_patch", "goldPatch"] as const

/** Count non-empty newline-separated tokens in a counter file. The spy testCmd
 *  appends one line per invocation, so this is the official-verify call count. */
const countLines = (s: string): number =>
  s
    .trim()
    .split("\n")
    .filter((l) => l !== "").length

describe("b2 — bench repair rounds integration", () => {
  test("1. default-OFF byte-identical: no deps.repair ⇒ 1 agent run, 1 verify, outcome unchanged", async () => {
    await withTmp(async (dir) => {
      const inst = makeSwebenchInstance(dir, "byte-identical")
      const llm = new ScriptedLLM([
        { kind: "edit", file: "math.js", old: "return a - b", new: "return a + b" },
      ])
      // Spy via local testCmd: wrap the instance.testCmd with a counter sentinel.
      const counterFile = join(dir, "verify-count")
      writeFileSync(counterFile, "")
      const spy: Instance = {
        ...inst,
        testCmd: `echo x >> "${counterFile}" && ${inst.testCmd}`,
      }
      const r = await runInstance(spy, { ...DEPS, llm })
      // The agent's scene was scripted to fire once and produce the fix.
      expect(llm.agentRuns).toBe(1)
      // testCmd ran exactly once ⇒ official verify() was called exactly once.
      expect(countLines(readFileSync(counterFile, "utf8"))).toBe(1)
      expect(r.passed).toBe(true)
      expect(r.patch).toContain("return a + b")
    })
  })

  test("2. round0 fails → round1 passes: validator gates the loop", async () => {
    await withTmp(async (dir) => {
      const inst = makeSwebenchInstance(dir, "round0-fail-round1-pass")
      const llm = new ScriptedLLM([
        // Round 0: wrong fix + bash verification.
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a - b",
          new: "return a * b", // still wrong
          bash: `node -e "require('./math.js')"`,
        },
        // Round 1 (after seedMsg): correct fix + bash verification.
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a * b",
          new: "return a + b",
          bash: `node -e "require('./math.js')"`,
        },
      ])
      let validateCalls = 0
      const fakeValidate = async (_args: ValidateArgs): Promise<ValidatorResult> => {
        validateCalls += 1
        return validateCalls === 1
          ? { ok: false, failTail: "AssertionError: expected 5 got 6" }
          : { ok: true }
      }
      // Verify-spy on the official grader.
      const counterFile = join(dir, "verify-count")
      writeFileSync(counterFile, "")
      const spy: Instance = {
        ...inst,
        testCmd: `echo x >> "${counterFile}" && ${inst.testCmd}`,
      }
      const r = await runInstance(spy, {
        ...DEPS,
        llm,
        repair: { maxRounds: 2, validate: fakeValidate },
      })
      expect(llm.agentRuns).toBe(2)
      expect(validateCalls).toBe(2)
      // Official grader called EXACTLY ONCE, with the cumulative final patch.
      expect(countLines(readFileSync(counterFile, "utf8"))).toBe(1)
      expect(r.passed).toBe(true)
      expect(r.patch).toContain("return a + b")
    })
  })

  test("3. maxRounds cap: validator never ok ⇒ exactly maxRounds+1 agent runs, validated:false", async () => {
    await withTmp(async (dir) => {
      const inst = makeSwebenchInstance(dir, "cap")
      // 3 scenes: every scene emits a bash so lastVerifyCmd is populated; the
      // edits keep mutating but the fake validator REFUSES to say ok.
      const llm = new ScriptedLLM([
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a - b",
          new: "return a * b",
          bash: `node -e "1"`,
        },
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a * b",
          new: "return a / b",
          bash: `node -e "1"`,
        },
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a / b",
          new: "return a % b",
          bash: `node -e "1"`,
        },
      ])
      let validateCalls = 0
      const fakeValidate = async (_args: ValidateArgs): Promise<ValidatorResult> => {
        validateCalls += 1
        return { ok: false, failTail: `round ${validateCalls} fail` }
      }
      const counterFile = join(dir, "verify-count")
      writeFileSync(counterFile, "")
      const spy: Instance = {
        ...inst,
        testCmd: `echo x >> "${counterFile}" && ${inst.testCmd}`,
      }
      await runInstance(spy, {
        ...DEPS,
        llm,
        repair: { maxRounds: 2, validate: fakeValidate },
      })
      // Round 0 + 2 repair rounds = 3 agent runs, 3 validator calls.
      expect(llm.agentRuns).toBe(3)
      expect(validateCalls).toBe(3)
      // Official grader: exactly once at the end.
      expect(countLines(readFileSync(counterFile, "utf8"))).toBe(1)
    })
  })

  test("4. single sandbox / continue-from-patched-tree: round 1 sees round 0's edits", async () => {
    await withTmp(async (dir) => {
      const inst = makeSwebenchInstance(dir, "sandbox-continuity")
      // Capture the sandbox path from each scene's user message (via the
      // injectable validator — which receives `args.sandbox` for each round).
      const sandboxesSeen: string[] = []
      const fakeValidate = async (args: ValidateArgs): Promise<ValidatorResult> => {
        sandboxesSeen.push(args.sandbox)
        // Round 0: fail to force round 1.
        if (sandboxesSeen.length === 1) {
          return { ok: false, failTail: "still wrong" }
        }
        return { ok: true }
      }
      const llm = new ScriptedLLM([
        // Round 0: change `a - b` ⇒ `a * b` (wrong but mutates the tree).
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a - b",
          new: "return a * b",
          bash: `node -e "1"`,
        },
        // Round 1: builds on round 0's edit — old_string is `a * b` (proves the
        // worktree was NOT reset between rounds).
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a * b",
          new: "return a + b",
          bash: `node -e "1"`,
        },
      ])
      const r = await runInstance(inst, {
        ...DEPS,
        llm,
        repair: { maxRounds: 2, validate: fakeValidate },
      })
      expect(sandboxesSeen).toHaveLength(2)
      // Same sandbox dir across rounds (no fresh allocation).
      expect(sandboxesSeen[0]).toBe(sandboxesSeen[1] ?? "")
      // The round-1 scene's edit SUCCEEDED ⇒ round 0's mutation persisted.
      // (If the worktree had been reset, the edit tool would have errored
      // because `return a * b` would not be present.)
      expect(r.passed).toBe(true)
      expect(r.patch).toContain("return a + b")
    })
  })

  test("5. no-leak: seedMsg never contains FAIL_TO_PASS/PASS_TO_PASS/test_patch/goldPatch", async () => {
    await withTmp(async (dir) => {
      const inst = makeSwebenchInstance(dir, "no-leak")
      const llm = new ScriptedLLM([
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a - b",
          new: "return a * b",
          bash: `node -e "1"`,
        },
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a * b",
          new: "return a + b",
          bash: `node -e "1"`,
        },
      ])
      // Fake validator returns a failTail that is OUR fixture text — never
      // sourced from instance fields. If the seedMsg ever contains forbidden
      // tokens, the seam producing it must be wrong.
      const ourFailTail = "fixture-failtail-token-XYZ123"
      let validateCalls = 0
      const fakeValidate = async (_args: ValidateArgs): Promise<ValidatorResult> => {
        validateCalls += 1
        return validateCalls === 1 ? { ok: false, failTail: ourFailTail } : { ok: true }
      }
      await runInstance(inst, {
        ...DEPS,
        llm,
        repair: { maxRounds: 2, validate: fakeValidate },
      })
      // The round-1 user message is at index 1 (round 0 was index 0).
      expect(llm.seedTextsSeen.length).toBeGreaterThanOrEqual(2)
      const seedMsgRound1 = llm.seedTextsSeen[1] ?? ""
      // Forbidden tokens MUST NOT appear in any round's user message.
      for (const t of FORBIDDEN_TOKENS) {
        expect(seedMsgRound1).not.toContain(t)
        expect(llm.seedTextsSeen[0] ?? "").not.toContain(t)
      }
      // Our fixture failTail DID reach the seed message (proves the seam
      // sourced it from the validator, not from instance.swebench).
      expect(seedMsgRound1).toContain(ourFailTail)
    })
  })

  test("6. lastVerifyCmd plumbing: agent's bash command reaches the validator", async () => {
    await withTmp(async (dir) => {
      const inst = makeSwebenchInstance(dir, "lastverifycmd")
      const expectedCmd = "python -m pytest tests/test_x.py"
      const llm = new ScriptedLLM([
        {
          kind: "editAndBash",
          file: "math.js",
          old: "return a - b",
          new: "return a + b",
          bash: expectedCmd,
        },
      ])
      const observed: { cmd?: string }[] = []
      const fakeValidate = async (args: ValidateArgs): Promise<ValidatorResult> => {
        observed.push({ ...(args.cmd !== undefined ? { cmd: args.cmd } : {}) })
        return { ok: true }
      }
      await runInstance(inst, {
        ...DEPS,
        llm,
        repair: { maxRounds: 2, validate: fakeValidate },
      })
      expect(observed).toHaveLength(1)
      expect(observed[0]?.cmd).toBe(expectedCmd)
    })
  })
})
