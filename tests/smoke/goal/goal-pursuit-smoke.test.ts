/**
 * Dedicated Goal smoke harness.
 *
 * Unlike the generic smoke runner, this composes the production objective
 * authority, attributed-attempt slot, verifier coordinator, wake controller,
 * runtime host, and a deterministic replay LLM. Assertions read authority
 * snapshots/receipts and exact enqueue/spawn counts, never final prose.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import {
  createObjectiveCheckRunner,
  createObjectiveVerificationCoordinator,
  createWorkspaceEvidence,
} from "@/host/runtime/objective-verifier-wire"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  buildPursuitContinuationPrompt,
  createObjectiveAttemptSlot,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type GoalWakeLifecycle,
  type ObjectiveAuthority,
  type ObjectiveVerificationPort,
  startGoalWakeController,
} from "@/objective"
import type { PermissionContext } from "@/permission"
import {
  createRuntimeFromAgentConfigBase,
  type RuntimeFacade,
  type RuntimeSession,
} from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

class GoalReplayLLM implements LLMPort {
  readonly model = "goal-smoke-replay"
  readonly inputs: StreamInput[] = []
  calls = 0

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    yield { type: "text_delta", delta: `goal-smoke-${this.calls}` }
    yield { type: "usage", inputTokens: 3, outputTokens: 2, model: this.model } as StreamEvent
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const git = (cwd: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "goal-smoke",
      GIT_AUTHOR_EMAIL: "goal-smoke@example.test",
      GIT_COMMITTER_NAME: "goal-smoke",
      GIT_COMMITTER_EMAIL: "goal-smoke@example.test",
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const fakeScheduler = () => {
  let nextId = 0
  const pending = new Map<number, () => void>()
  return {
    set: (fn: () => void): ReturnType<typeof setTimeout> => {
      const id = ++nextId
      pending.set(id, fn)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clear: (handle: ReturnType<typeof setTimeout>): void => {
      pending.delete(handle as unknown as number)
    },
    fireNext: (): void => {
      const entry = pending.entries().next().value as [number, () => void] | undefined
      if (entry === undefined) throw new Error("goal smoke timer was not armed")
      pending.delete(entry[0])
      entry[1]()
    },
    count: (): number => pending.size,
  }
}

const until = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!predicate()) throw new Error("goal smoke condition timed out")
}

interface GoalSmokeHarness {
  readonly authority: ObjectiveAuthority
  readonly verifier: ObjectiveVerificationPort
  readonly replay: GoalReplayLLM
  readonly session: RuntimeSession
  readonly runtime: RuntimeFacade
  readonly wake: GoalWakeLifecycle
  readonly scheduler: ReturnType<typeof fakeScheduler>
  readonly spawnCount: () => number
  readonly componentCount: number
  close(): Promise<void>
}

const assertHarnessComponents = (parts: Readonly<Record<string, unknown>>): number => {
  const required = ["authority", "attemptSlot", "verifier", "wake", "replay"]
  const present = required.filter((key) => parts[key] !== undefined)
  if (present.length !== required.length)
    throw new Error(
      `goal smoke missing: ${required.filter((key) => !present.includes(key)).join(",")}`,
    )
  return present.length
}

const buildHarness = async (cwd: string): Promise<GoalSmokeHarness> => {
  const authority = createObjectiveAuthority({ now: () => Date.now(), enforceBudget: true })
  const attemptSlot = createObjectiveAttemptSlot()
  const replay = new GoalReplayLLM()
  const capabilities = createObjectiveCapabilities(authority)
  let spawns = 0
  const productionRunner = createObjectiveCheckRunner()
  const verifier = createObjectiveVerificationCoordinator({
    read: capabilities.read,
    verifier: capabilities.verifier,
    runner: {
      run: async (input) => {
        spawns += 1
        return await productionRunner.run(input)
      },
    },
    evidence: createWorkspaceEvidence(),
    workspaceCwd: cwd,
  })
  const { runtimeContext } = await createRuntimeFromAgentConfigBase({
    base: {
      llm: replay,
      registry: new ToolRegistry([]),
      stream: new NullStream(),
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [],
      system: "goal smoke",
      cwd,
      maxTurns: 8,
      signal: new AbortController().signal,
      objective: authority,
      objectiveVerifier: verifier,
      objectiveAttemptSlot: attemptSlot,
    },
    turnAssembler: buildInteractiveTurnAssembler({}, {}),
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  const runtime = await runtimeContext.createRuntimeFacade({
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
    mcpClients: [],
  })
  const session = await runtime.createSession({ cwd, permissionMode: "acceptEdits" })
  const scheduler = fakeScheduler()
  const submit = session.turn.submitGoalContinuation
  if (submit === undefined) throw new Error("goal continuation host verb missing")
  const wake = startGoalWakeController({
    enabled: true,
    threadId: session.sessionId,
    attemptSlot,
    readDomain: (threadId) => authority.readDomain(threadId),
    quietWindowMs: 15_000,
    setTimeoutFn: scheduler.set,
    clearTimeoutFn: scheduler.clear,
    probes: {
      objective: authority,
      threadIdle: () => true,
      planModeActive: () => false,
      turnActive: () => false,
      queuedInputPending: () => false,
      mailboxInputPending: () => false,
      isEphemeral: () => false,
      resume: async () => {
        throw new Error("dedicated smoke must use the attributed resumeAttempt path")
      },
    },
    resumeAttempt: async (threadId, attempt) => {
      const snapshot = await session.snapshot()
      await submit({
        text: buildPursuitContinuationPrompt(authority.get(threadId)?.goal),
        expectedSessionRevision: snapshot.revision,
        objectiveId: attempt.objectiveId,
        objectiveRevision: attempt.objectiveRevision,
        validateCurrent: () =>
          authority.readDomain(threadId).revision === attempt.objectiveRevision,
      })
    },
  })
  if (wake === undefined) throw new Error("goal wake controller missing")
  return {
    authority,
    verifier,
    replay,
    session,
    runtime,
    wake,
    scheduler,
    spawnCount: () => spawns,
    componentCount: assertHarnessComponents({ authority, attemptSlot, verifier, wake, replay }),
    close: async () => {
      wake.stop()
      await runtime.close()
    },
  }
}

const dirs: string[] = []
const harnesses: GoalSmokeHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const freshHarness = async (): Promise<GoalSmokeHarness> => {
  const cwd = mkdtempSync(join(tmpdir(), "goal-smoke-"))
  dirs.push(cwd)
  writeFileSync(join(cwd, "proof.txt"), "v1\n")
  git(cwd, "init", "-q")
  git(cwd, "add", "-A")
  git(cwd, "commit", "-q", "-m", "init")
  const harness = await buildHarness(cwd)
  harnesses.push(harness)
  return harness
}

describe("dedicated Goal smoke", () => {
  test("default-on active pursuit runs one attributed turn and settles a receipt", async () => {
    const h = await freshHarness()
    h.authority.create(h.session.sessionId, { goal: "ship", successCriteria: ["receipt exists"] })
    h.wake.onGoalMutation()
    expect(h.componentCount).toBe(5)
    expect(h.scheduler.count()).toBe(1)
    h.scheduler.fireNext()
    await until(
      () => (h.authority.readDomain(h.session.sessionId).progressReceipts ?? []).length === 1,
    )
    const domain = h.authority.readDomain(h.session.sessionId)
    expect(h.replay.calls).toBe(1)
    expect(domain.progressReceipts).toHaveLength(1)
    expect(domain.progressReceipts?.[0]?.turnOutcome).toBe("completed")
    expect(domain.state?.objective.budget.turnsUsed).toBe(1)
    expect(domain.state?.objective.attempts.autonomousTurnsStarted).toBe(1)
    expect(domain.state?.objective.attempts.started).toBeUndefined()
  })

  test("checked verification uses the strict production runner and binds a current receipt", async () => {
    const h = await freshHarness()
    h.authority.create(h.session.sessionId, {
      goal: "verify",
      criteria: [
        {
          text: "command passes",
          check: {
            kind: "command",
            argv: ["bun", "-e", "process.exit(0)"],
            timeoutMs: 20_000,
            successExitCodes: [0],
          },
        },
      ],
    })
    const outcome = await h.verifier.verify(h.session.sessionId)
    expect(outcome.kind).toBe("verified")
    expect(h.spawnCount()).toBe(1)
    const objective = h.authority.get(h.session.sessionId)
    expect(objective?.status).toBe("completed")
    expect(objective?.successCriteria[0]?.completion?.source).toBe("verifier")
    expect(objective?.successCriteria[0]?.completion?.sourceDigest).toMatch(
      /^quanta-workspace-manifest-v1:/,
    )
  })

  test("an exhausted one-turn budget settles once and arms no extra wake", async () => {
    const h = await freshHarness()
    h.authority.create(h.session.sessionId, {
      goal: "bounded",
      successCriteria: ["remains unmet"],
      budget: { maxTurns: 1 },
    })
    h.wake.onGoalMutation()
    h.scheduler.fireNext()
    await until(
      () => (h.authority.readDomain(h.session.sessionId).progressReceipts ?? []).length === 1,
    )
    h.wake.onTurnSettled()
    const objective = h.authority.get(h.session.sessionId)
    expect(objective?.status).toBe("budget_limited")
    expect(objective?.budget.limitedBy).toBe("user-budget")
    expect(h.replay.calls).toBe(1)
    expect(h.scheduler.count()).toBe(0)
  })

  test("anti-vacuum: omitting the authority fails the dedicated harness floor", () => {
    expect(() =>
      assertHarnessComponents({
        authority: undefined,
        attemptSlot: {},
        verifier: {},
        wake: {},
        replay: {},
      }),
    ).toThrow("goal smoke missing: authority")
  })
})
