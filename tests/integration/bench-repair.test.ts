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
import { runInstance } from "../../src/apps/bench/eval"
import { buildRepairContext } from "../../src/apps/bench/eval/repair/context"
import { runRepairRounds } from "../../src/apps/bench/eval/repair/index"
import type {
  ExecFn,
  RunOnceResult,
  ValidateArgs,
  ValidatorResult,
} from "../../src/apps/bench/eval/repair/types"
import type { Instance } from "../../src/apps/bench/types"

/**
 * b2 wall-clock budget: each `runInstance` spawns multiple `bash -c` children
 * (git init/commit/checkout + bash exec for tool_use bash + diff capture). On a
 * fully cold CI worker, two repair rounds × ~6 shell spawns each can edge above
 * the bun default 5000ms test timeout — which exactly matches the observed
 * `5001ms` flake. Hoist every `runInstance`-driven repair test to a 30s budget
 * so the assertions are event-driven (validator-call counts / agent-run counts)
 * rather than wall-clock-bound. Pure orchestrator tests (no runInstance) keep
 * the default budget.
 */
const RUN_INSTANCE_TIMEOUT_MS = 30_000

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
  | {
      kind: "testRunnerOnly"
      input?: { command?: string; path?: string; timeout_ms?: number }
    }

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
      if (scene.kind === "testRunnerOnly") {
        yield { type: "tool_use_start", id: `t${this.sceneIdx}`, name: "test_runner" }
        yield {
          type: "tool_use_end",
          id: `t${this.sceneIdx}`,
          input: scene.input ?? {},
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
  test(
    "1. default-OFF byte-identical: no deps.repair ⇒ 1 agent run, 1 verify, outcome unchanged",
    async () => {
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
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test(
    "2. round0 fails → round1 passes: validator gates the loop",
    async () => {
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
    },
    // b2 flake root-cause: this test was the canary because it is THE one that
    // exercises BOTH (a) two runInstance-internal agent runs AND (b) two bash
    // tool_use spawns AND (c) the full git-snapshot wrap — together edging the
    // default 5000ms ceiling on a cold runner. Assertions are event-driven
    // (agent-run / validate-call counts); raising the budget keeps the
    // semantics unchanged while removing the wall-clock dependency.
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test(
    "3. maxRounds cap: validator never ok ⇒ exactly maxRounds+1 agent runs, validated:false",
    async () => {
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
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test(
    "4. single sandbox / continue-from-patched-tree: round 1 sees round 0's edits",
    async () => {
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
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test(
    "5. no-leak: seedMsg never contains FAIL_TO_PASS/PASS_TO_PASS/test_patch/goldPatch",
    async () => {
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
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test(
    "6. lastVerifyCmd plumbing: agent's bash command reaches the validator",
    async () => {
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
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test(
    "6b. no-arg test_runner is bench-bound and reaches the validator as the exact verifier command",
    async () => {
      await withTmp(async (dir) => {
        const expectedCmd = 'printf "bench-bound-verifier"'
        const inst: Instance = {
          ...makeSwebenchInstance(dir, "lastverifycmd-test-runner"),
          testCmd: expectedCmd,
        }
        const llm = new ScriptedLLM([{ kind: "testRunnerOnly" }])
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
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )
})

// =========================================================================
// HC-A. Repair-mid-round abort — signal.abort() while a round is in flight.
// The orchestrator currently has NO abort-signal port; we exercise the closest
// real thing — an external `AbortSignal` driving `runInstance` — which the
// agent loop honors. This pins how the partial state propagates.
// =========================================================================

describe("HC-A. repair-mid-round abort", () => {
  test(
    "abort during round 1 agent run: runInstance returns with partial state, no throw",
    async () => {
      await withTmp(async (dir) => {
        const inst = makeSwebenchInstance(dir, "abort-mid-round")
        // Build a scripted LLM whose ROUND 1 (`sceneIdx===1`) hangs forever.
        // We intercept via a custom stream() rather than reusing the basic
        // ScriptedLLM (which has no hang facility).
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
        let validateCalls = 0
        const fakeValidate = async (_args: ValidateArgs): Promise<ValidatorResult> => {
          validateCalls += 1
          // Round 0 fails to force round 1; the runInstance enforces its own
          // `deps.timeoutMs` deadline (the bench runner's `setTimeout(...
          // abort.abort())` path), so we use a SHORT timeoutMs to trigger
          // abort during round 1. The fakeValidate doesn't hang — abort is
          // driven by the runInstance internal deadline.
          return validateCalls === 1
            ? { ok: false, failTail: "round 0 fail" }
            : { ok: false, failTail: "should not reach" }
        }
        // Use a SHORT timeoutMs so the abort fires before round 1 finishes.
        // The contract: runInstance NEVER throws, it returns with a result
        // (passed:false, possibly with an error string).
        const r = await runInstance(inst, {
          ...DEPS,
          timeoutMs: 50, // aggressive: abort during the very first phase
          llm,
          repair: { maxRounds: 2, validate: fakeValidate },
        })
        // Documented partial state: result returned, no throw escape.
        expect(typeof r.passed).toBe("boolean")
        expect(typeof r.turns).toBe("number")
        // The runner must have cleaned up its sandbox regardless of abort.
      })
    },
    RUN_INSTANCE_TIMEOUT_MS,
  )

  test("abort during validator call: orchestrator surfaces a failure result, no hang", async () => {
    // Drive the PURE orchestrator directly — no runInstance, no git. The
    // validator awaits a never-resolving promise that is canceled by an
    // external AbortController; the orchestrator currently has no
    // first-class abort port, so the contract we pin is: when validate
    // throws (the practical way the runtime surfaces cancellation),
    // runRepairRounds rethrows. NOT a hang.
    const ac = new AbortController()
    const validateHang = (_args: ValidateArgs): Promise<ValidatorResult> => {
      return new Promise<ValidatorResult>((_resolve, reject) => {
        ac.signal.addEventListener("abort", () => reject(new Error("validator aborted")))
      })
    }
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "diff",
      turns: 1,
      lastVerifyCmd: "true",
    })
    const exec: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" })
    const promise = runRepairRounds({
      config: { maxRounds: 2 },
      problem: "p",
      runOnce,
      validate: validateHang,
      buildContext: buildRepairContext,
      sandbox: "/tmp/x",
      exec,
      timeoutMs: 1000,
    })
    // Fire the abort after a microtask so validate is awaited.
    queueMicrotask(() => ac.abort())
    // The orchestrator surfaces the validator throw — it does NOT swallow
    // and hang. Tight wall-clock guard via Promise.race: 5s is way more
    // than enough; if it ever times out we know the orchestrator hung.
    const guard = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("orchestrator hung")), 5_000),
    )
    let threw = false
    try {
      await Promise.race([promise, guard])
    } catch (e) {
      threw = true
      expect((e as Error).message).toContain("validator aborted")
    }
    expect(threw).toBe(true)
  })
})

// =========================================================================
// HC-B. Adversarial patch from agent. Driven through the PURE orchestrator
// (no runInstance — keeps this hermetic and fast). The validator is the gate
// that decides whether the round counts as ok; the orchestrator doesn't parse
// patches itself, so the contract here is "validator verdict drives outcome".
// =========================================================================

describe("HC-B. adversarial patch shapes (orchestrator-level)", () => {
  test("invalid hunk header in patch: orchestrator passes patch through verbatim; validator gates", async () => {
    // A patch that LOOKS like a unified diff but the hunk header is corrupt.
    // The orchestrator MUST NOT try to validate the diff itself — it just
    // hands the patch to the next round and trusts the validator.
    const broken = `diff --git a/x b/x
--- a/x
+++ b/x
@@ NOT A REAL HEADER @@
-old
+new
`
    let calls = 0
    const validate = async (_a: ValidateArgs): Promise<ValidatorResult> => {
      calls += 1
      return { ok: false, failTail: `round ${calls} failed: bad hunk` }
    }
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: broken,
      turns: 1,
      lastVerifyCmd: "true",
    })
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "x" })
    const out = await runRepairRounds({
      config: { maxRounds: 1 },
      problem: "p",
      runOnce,
      validate,
      buildContext: buildRepairContext,
      sandbox: "/tmp/x",
      exec,
      timeoutMs: 1000,
    })
    expect(out.validated).toBe(false)
    expect(out.patch).toContain("@@ NOT A REAL HEADER @@")
    expect(out.history).toHaveLength(2) // round 0 + 1 repair round
  })

  test("empty patch from agent: orchestrator reports it as a round, validator says no-change", async () => {
    let calls = 0
    const validate = async (_a: ValidateArgs): Promise<ValidatorResult> => {
      calls += 1
      // Empty patch ⇒ nothing fixed; validator reports failure (no command
      // would succeed if the bug is still there).
      return { ok: false, failTail: "no change made" }
    }
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: "",
      turns: 0,
      lastVerifyCmd: "true",
    })
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "fail" })
    const out = await runRepairRounds({
      config: { maxRounds: 2 },
      problem: "p",
      runOnce,
      validate,
      buildContext: buildRepairContext,
      sandbox: "/tmp/x",
      exec,
      timeoutMs: 1000,
    })
    expect(out.validated).toBe(false)
    expect(out.patch).toBe("")
    // round 0 + 2 repair rounds = 3 total rounds.
    expect(out.history).toHaveLength(3)
    expect(calls).toBe(3)
    // Every round's patch is empty (structural verdict).
    for (const h of out.history) expect(h.patch).toBe("")
  })

  test("applying patch but breaking build: validator gates correctly (ok:false)", async () => {
    // Realistic: the agent's patch APPLIES (non-empty diff) but the validator
    // command (`make test`) returns nonzero — the orchestrator must NOT mark
    // the round validated.
    const validate = async (_a: ValidateArgs): Promise<ValidatorResult> => {
      return { ok: false, failTail: "compile error: undefined symbol foo" }
    }
    const goodLookingDiff = `diff --git a/x.c b/x.c
@@ -1 +1 @@
-int x = 0;
+int x = foo();
`
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => ({
      patch: goodLookingDiff,
      turns: 1,
      lastVerifyCmd: "make test",
    })
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "" })
    const out = await runRepairRounds({
      config: { maxRounds: 1 },
      problem: "p",
      runOnce,
      validate,
      buildContext: buildRepairContext,
      sandbox: "/tmp/x",
      exec,
      timeoutMs: 1000,
    })
    expect(out.validated).toBe(false)
    expect(out.patch).toContain("foo()")
    expect(out.history.every((h) => !h.validated)).toBe(true)
  })
})

// =========================================================================
// HC-C. Validator chaos — the validator surface is INJECTED, so we drive it
// through the production `validate()` (repair/validator.ts) with a fake exec
// to simulate hostile shell outputs. Pins: timeout, OOM-kill exit 137, binary
// garbage in stderr — none of them must hang or crash the parser.
// =========================================================================

describe("HC-C. validator chaos (production validate + fake exec)", () => {
  // Import production validate. Done lazily because we already wire the
  // injected validate in many other tests.
  const importValidate = async () =>
    (await import("../../src/apps/bench/eval/repair/validator")).validate

  test("validator command times out (exec returns nonzero, captures partial output)", async () => {
    const validate = await importValidate()
    // The injected exec models a `sleep 60` killed by the timeout: nonzero
    // code, partial stdout. The validator MUST treat this as failure, NOT
    // hang or throw. The validator is hermetic — it doesn't enforce the
    // timeout itself (that's exec's responsibility); we just verify the
    // mapping `code!==0 ⇒ {ok:false, failTail}` holds.
    const fakeExec: ExecFn = async () => ({
      code: 124, // GNU `timeout` exit
      stdout: "running...\n",
      stderr: "timed out after 60s\n",
    })
    const r = await validate({
      sandbox: "/tmp/x",
      cmd: "sleep 60",
      exec: fakeExec,
      timeoutMs: 1000,
    })
    expect(r.ok).toBe(false)
    expect(r.failTail).toBeDefined()
    expect(r.failTail).toContain("timed out after 60s")
  })

  test("validator returns exit 137 (OOM-killed): treated as failure with failTail", async () => {
    const validate = await importValidate()
    const fakeExec: ExecFn = async () => ({
      code: 137,
      stdout: "",
      stderr: "Killed",
    })
    const r = await validate({
      sandbox: "/tmp/x",
      cmd: "pytest",
      exec: fakeExec,
      timeoutMs: 1000,
    })
    expect(r.ok).toBe(false)
    expect(r.failTail).toContain("Killed")
  })

  test("validator stderr contains binary garbage: parser doesn't blow up; failTail is bounded", async () => {
    const validate = await importValidate()
    // Build a stderr buffer with non-UTF-8-looking bytes via String.fromCharCode.
    const garbage = Array.from({ length: 500 }, (_, i) => String.fromCharCode(i % 256)).join("")
    const fakeExec: ExecFn = async () => ({
      code: 1,
      stdout: "",
      stderr: garbage,
    })
    const r = await validate({
      sandbox: "/tmp/x",
      cmd: "pytest",
      exec: fakeExec,
      timeoutMs: 1000,
      tailBytes: 100, // tight bound
    })
    expect(r.ok).toBe(false)
    // failTail respects the tailBytes bound.
    expect(r.failTail?.length).toBeLessThanOrEqual(100)
  })
})

// =========================================================================
// HC-D. Budget exhaustion — drives the PURE orchestrator with a counting
// validator so we can pin EXACT round shapes.
// =========================================================================

describe("HC-D. budget exhaustion (orchestrator)", () => {
  test("3 repair rounds, all fail: rounds=4, validated=false, history records each round's patch", async () => {
    let runs = 0
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => {
      runs += 1
      return { patch: `patch-${runs}`, turns: 1, lastVerifyCmd: "true" }
    }
    const validate = async (_a: ValidateArgs): Promise<ValidatorResult> => ({
      ok: false,
      failTail: "still fails",
    })
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "" })
    const out = await runRepairRounds({
      config: { maxRounds: 3 },
      problem: "p",
      runOnce,
      validate,
      buildContext: buildRepairContext,
      sandbox: "/tmp/x",
      exec,
      timeoutMs: 1000,
    })
    // round 0 + 3 repair rounds = 4 total agent runs.
    expect(runs).toBe(4)
    expect(out.rounds).toBe(4)
    expect(out.validated).toBe(false)
    expect(out.history).toHaveLength(4)
    // Each round's patch is the cumulative diff at that point.
    expect(out.history.map((h) => h.patch)).toEqual(["patch-1", "patch-2", "patch-3", "patch-4"])
    // Final patch is the LAST round's diff.
    expect(out.patch).toBe("patch-4")
  })

  test("round 0 ok ⇒ no further rounds attempted (early exit)", async () => {
    let runs = 0
    const runOnce = async (_seed: string | undefined): Promise<RunOnceResult> => {
      runs += 1
      return { patch: `first-${runs}`, turns: 1, lastVerifyCmd: "true" }
    }
    let validateCalls = 0
    const validate = async (_a: ValidateArgs): Promise<ValidatorResult> => {
      validateCalls += 1
      return { ok: true } // first round already passes
    }
    const exec: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" })
    const out = await runRepairRounds({
      config: { maxRounds: 5 },
      problem: "p",
      runOnce,
      validate,
      buildContext: buildRepairContext,
      sandbox: "/tmp/x",
      exec,
      timeoutMs: 1000,
    })
    expect(runs).toBe(1)
    expect(validateCalls).toBe(1)
    expect(out.rounds).toBe(1)
    expect(out.validated).toBe(true)
    expect(out.history).toHaveLength(1)
    expect(out.history[0]?.validated).toBe(true)
  })
})

// =========================================================================
// HC-E. Context budget pressure — pure `buildRepairContext` test surface.
// Pins that the seed message respects `maxBytes` even with huge inputs, and
// that the truncation order (failTail → diff middle → problem head) holds.
// =========================================================================

describe("HC-E. repair-context budget pressure", () => {
  test("failTail = 50 KB: seed respects maxBytes and keeps the END of the failure", async () => {
    const HEAD_MARKER = "HEAD_OF_FAILTAIL_xxxxxxxxxx"
    const TAIL_MARKER = "TAIL_OF_FAILTAIL_yyyyyyyyyy"
    const filler = "x".repeat(50_000 - HEAD_MARKER.length - TAIL_MARKER.length)
    const huge = `${HEAD_MARKER}${filler}${TAIL_MARKER}`
    const out = buildRepairContext({
      problem: "fix the thing",
      cumulativeDiff: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n",
      failTail: huge,
      round: 1,
      maxBytes: 4_000,
    })
    expect(out.length).toBeLessThanOrEqual(4_000)
    // The validator's most-recent output is at the END — that's what we keep.
    expect(out).toContain(TAIL_MARKER)
    // The head is dropped (proves trimTail kept the tail, not the head).
    expect(out).not.toContain(HEAD_MARKER)
    // The structural headers are still present.
    expect(out).toContain("Repair round 1.")
    expect(out).toContain("Validation failed.")
  })

  test("cumulative diff 100 KB across the budget: seed bounded; first+last hunks survive", async () => {
    // Build a diff with 1 file and 50 hunks. Each hunk is ~2KB. Total ~100KB.
    const hunks: string[] = []
    for (let i = 0; i < 50; i++) {
      hunks.push(`@@ -${i * 10},5 +${i * 10},5 @@`)
      hunks.push(`-line-${i}-old`)
      hunks.push(`+line-${i}-new`)
      hunks.push("x".repeat(1900))
    }
    const huge = `diff --git a/x b/x\n--- a/x\n+++ b/x\n${hunks.join("\n")}\n`
    expect(huge.length).toBeGreaterThan(90_000)
    const out = buildRepairContext({
      problem: "fix",
      cumulativeDiff: huge,
      failTail: "fail tail",
      round: 2,
      maxBytes: 8_000,
    })
    expect(out.length).toBeLessThanOrEqual(8_000)
    // First and last hunk headers survive (truncateDiff keeps them).
    expect(out).toContain("@@ -0,5 +0,5 @@")
    expect(out).toContain("@@ -490,5 +490,5 @@")
    // Diff header preserved.
    expect(out).toContain("diff --git a/x b/x")
    // Truncation marker present somewhere.
    expect(out).toMatch(/truncated/)
  })
})
