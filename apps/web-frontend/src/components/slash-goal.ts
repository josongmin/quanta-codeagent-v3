/** Browser `/goal`: structured reads, viewed-revision CAS writes, correlated receipts. */
import type {
  GoalReadoutCriterionView,
  GoalReadoutData,
  GoalReadoutObjectiveView,
} from "../types/protocol.readout.generated"
import {
  DEFAULT_OBJECTIVE_CHECK_SUCCESS_EXIT_CODES,
  DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS,
} from "../types/protocol.readout.generated"
import type { GoalVerificationReceipt, ObjectiveMutationReceipt } from "../ws/session-hooks"
import type { SlashCommand } from "./SlashPalette"
import {
  fetchReadoutBody,
  type GoalReadoutResult,
  type ReadoutEndpoint,
  readGoalReadout,
} from "./slash-readout"

export interface GoalSlashDeps extends ReadoutEndpoint {
  readonly onError: (msg: string) => void
  readonly sendObjectiveMutate: (
    mutation: unknown,
    expectedObjectiveRevision: number,
  ) => Promise<ObjectiveMutationReceipt>
  readonly sendGoalWork: (text: string) => boolean
  readonly requestGoalVerification: (
    expectedObjectiveRevision: number,
  ) => Promise<GoalVerificationReceipt>
  readonly readGoal?: () => Promise<GoalReadoutResult>
  readonly delay?: (ms: number) => Promise<void>
}

interface GoalBudgetCaps {
  readonly maxTokens?: number
  readonly maxTurns?: number
}

export type GoalCommand =
  | { readonly kind: "show" }
  | { readonly kind: "work"; readonly instruction: string }
  | { readonly kind: "verify" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "clear" }
  | { readonly kind: "abandon" }
  | { readonly kind: "unblock" }
  | { readonly kind: "create"; readonly text: string }
  | { readonly kind: "edit"; readonly text: string }
  | { readonly kind: "budget"; readonly caps: GoalBudgetCaps }
  | { readonly kind: "criterion-add"; readonly text: string }
  | { readonly kind: "criterion-done"; readonly target: string }
  | { readonly kind: "check-add"; readonly text: string; readonly argv: readonly string[] }
  | { readonly kind: "error"; readonly message: string }

const noArgument = (head: string, tail: string, kind: GoalCommand["kind"]): GoalCommand =>
  tail === ""
    ? ({ kind } as GoalCommand)
    : {
        kind: "error",
        message: `/goal ${head}: takes no argument — did you mean \`/goal edit ${tail}\`?`,
      }

export const parseBudgetFlags = (argument: string): GoalBudgetCaps | null => {
  const result: { maxTokens?: number; maxTurns?: number } = {}
  for (const arg of argument.split(/\s+/).filter(Boolean)) {
    const match = /^--max-(tokens|turns)=(\d+)$/.exec(arg)
    if (match === null) return null
    const value = Number(match[2])
    if (!Number.isSafeInteger(value) || value < 0) return null
    if (match[1] === "tokens") result.maxTokens = value
    else result.maxTurns = value
  }
  return Object.keys(result).length === 0 ? null : result
}

interface ArgvLexerState {
  readonly argv: string[]
  current: string
  quote: "'" | '"' | null
  escaped: boolean
  started: boolean
}

const consumeQuoted = (state: ArgvLexerState, char: string): void => {
  if (state.quote === '"' && char === "\\") state.escaped = true
  else if (char === state.quote) state.quote = null
  else state.current += char
  state.started = true
}

const consumeUnquoted = (state: ArgvLexerState, char: string): void => {
  if (char === "\\") {
    state.escaped = true
    state.started = true
    return
  }
  if (char === "'" || char === '"') {
    state.quote = char
    state.started = true
    return
  }
  if (/\s/.test(char)) {
    if (state.started) state.argv.push(state.current)
    state.current = ""
    state.started = false
    return
  }
  state.current += char
  state.started = true
}

/** Minimal shell-like argv lexer. It preserves quoted/empty arguments and never
 * flattens the command back into one shell string. */
export const parseCheckArgv = (source: string): readonly string[] | null => {
  const state: ArgvLexerState = {
    argv: [],
    current: "",
    quote: null,
    escaped: false,
    started: false,
  }
  for (const char of source) {
    if (state.escaped) {
      state.current += char
      state.escaped = false
      state.started = true
    } else if (state.quote !== null) consumeQuoted(state, char)
    else consumeUnquoted(state, char)
  }
  if (state.escaped || state.quote !== null) return null
  if (state.started) state.argv.push(state.current)
  return state.argv.length === 0 ? null : state.argv
}

const parseCheckAdd = (tail: string): GoalCommand => {
  const match = /^(.*?)\s+--\s+([\s\S]+)$/.exec(tail)
  if (match === null || match[1]?.trim() === "") {
    return { kind: "error", message: "/goal check add: expected <description> -- <argv...>" }
  }
  const argv = parseCheckArgv(match[2] ?? "")
  return argv === null
    ? { kind: "error", message: "/goal check add: invalid or unterminated argv" }
    : { kind: "check-add", text: match[1]?.trim() ?? "", argv }
}

const NO_ARGUMENT_COMMANDS: Readonly<Record<string, GoalCommand["kind"]>> = {
  show: "show",
  pause: "pause",
  stop: "pause",
  resume: "resume",
  clear: "clear",
  abandon: "abandon",
  unblock: "unblock",
  verify: "verify",
}

const parseCriterionCommand = (tail: string): GoalCommand => {
  const separator = tail.search(/\s/)
  const operation = separator < 0 ? tail : tail.slice(0, separator)
  const value = separator < 0 ? "" : tail.slice(separator + 1).trim()
  if (operation === "add" && value !== "") return { kind: "criterion-add", text: value }
  if (operation === "done" && value !== "") return { kind: "criterion-done", target: value }
  return { kind: "error", message: "/goal criterion add|done: requires a value" }
}

const parseArgumentCommand = (head: string, tail: string, original: string): GoalCommand => {
  if (head === "edit") {
    return tail === ""
      ? { kind: "error", message: "/goal edit: needs text" }
      : { kind: "edit", text: tail }
  }
  if (head === "budget") {
    const caps = parseBudgetFlags(tail)
    return caps === null
      ? { kind: "error", message: "/goal budget: expected --max-turns=N and/or --max-tokens=N" }
      : { kind: "budget", caps }
  }
  if (head === "criterion") return parseCriterionCommand(tail)
  if (head === "check") {
    return tail.startsWith("add ")
      ? parseCheckAdd(tail.slice(4))
      : { kind: "error", message: "/goal check add: expected <description> -- <argv...>" }
  }
  return { kind: "create", text: original }
}

export const parseGoalCommand = (rest: string): GoalCommand => {
  const trimmed = rest.trim()
  if (trimmed === "") return { kind: "show" }
  const separator = trimmed.search(/\s/)
  const head = separator < 0 ? trimmed : trimmed.slice(0, separator)
  const tail = separator < 0 ? "" : trimmed.slice(separator + 1).trim()
  const noArgumentKind = NO_ARGUMENT_COMMANDS[head]
  if (noArgumentKind !== undefined) return noArgument(head, tail, noArgumentKind)
  if (head === "work") {
    return tail === ""
      ? { kind: "error", message: "/goal work: needs an instruction" }
      : { kind: "work", instruction: tail }
  }
  return parseArgumentCommand(head, tail, trimmed)
}

const readGoal = (deps: GoalSlashDeps): Promise<GoalReadoutResult> =>
  deps.readGoal?.() ?? readGoalReadout(deps)

const requireSnapshot = async (deps: GoalSlashDeps): Promise<GoalReadoutData | null> => {
  const result = await readGoal(deps)
  switch (result.kind) {
    case "served":
      return result.data
    case "unwired":
      deps.onError(result.output)
      return null
    case "malformed":
      deps.onError(`/goal: malformed structured readout (${result.status}); no write was sent`)
      return null
    case "network-error":
      deps.onError(`/goal: readout network error: ${result.message}; no write was sent`)
      return null
  }
}

const READBACK_ATTEMPTS = 20
const READBACK_INTERVAL_MS = 150

const awaitGoalState = async (
  deps: GoalSlashDeps,
  previousRevision: number,
  landed: (data: GoalReadoutData) => boolean,
): Promise<boolean> => {
  const sleep =
    deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(READBACK_INTERVAL_MS)
    const result = await readGoal(deps)
    if (
      result.kind === "served" &&
      result.data.revision > previousRevision &&
      landed(result.data)
    ) {
      return true
    }
    if (result.kind === "malformed" || result.kind === "unwired") return false
  }
  return false
}

type MutationRunResult = "applied" | "rejected" | "failed"

const runMutation = async (
  deps: GoalSlashDeps,
  snapshot: GoalReadoutData,
  mutation: unknown,
  landed: (data: GoalReadoutData) => boolean,
  pending: string,
): Promise<MutationRunResult> => {
  const receipt = await deps.sendObjectiveMutate(mutation, snapshot.revision)
  switch (receipt.kind) {
    case "undelivered":
      deps.onError("/goal: command was not delivered (session socket is not open)")
      return "failed"
    case "timeout":
      deps.onError(`/goal: command outcome is unknown after timeout (${receipt.commandId})`)
      return "failed"
    case "rejected":
      return "rejected"
    case "applied": {
      const observed = await awaitGoalState(deps, snapshot.revision, landed)
      if (!observed) {
        deps.onError(`/goal: ${pending} after an applied command receipt`)
        return "failed"
      }
      return "applied"
    }
  }
}

const declarations = (criteria: readonly GoalReadoutCriterionView[]): readonly unknown[] =>
  criteria.map((criterion) =>
    criterion.kind === "manual"
      ? { text: criterion.text }
      : {
          text: criterion.text,
          check: {
            kind: "command",
            argv: criterion.check.argv,
            timeoutMs: criterion.check.timeoutMs,
            successExitCodes: criterion.check.successExitCodes,
          },
        },
  )

const budgetCaps = (objective: GoalReadoutObjectiveView): GoalBudgetCaps => ({
  ...(objective.budget.maxTurns !== undefined ? { maxTurns: objective.budget.maxTurns } : {}),
  ...(objective.budget.maxTokens !== undefined ? { maxTokens: objective.budget.maxTokens } : {}),
})

const replacementDefinition = (
  objective: GoalReadoutObjectiveView,
  goal: string,
  criteria: readonly unknown[] = declarations(objective.criteria),
): unknown => ({ goal, criteria, budget: budgetCaps(objective) })

const criterionByTarget = (
  criteria: readonly GoalReadoutCriterionView[],
  target: string,
): GoalReadoutCriterionView | null => {
  if (/^\d+$/.test(target)) return criteria[Number(target) - 1] ?? null
  return criteria.find((criterion) => criterion.id === target) ?? null
}

const runUnblock = async (deps: GoalSlashDeps, initial: GoalReadoutData): Promise<void> => {
  const frozenIds = initial.objective?.blockers.map((blocker) => blocker.id) ?? []
  if (frozenIds.length === 0) {
    deps.appendSystem("Goal: no blocker to clear.")
    return
  }
  let cleared = 0
  let current = initial
  for (const [index, blockerId] of frozenIds.entries()) {
    if (!current.objective?.blockers.some((blocker) => blocker.id === blockerId)) continue
    const outcome = await runMutation(
      deps,
      current,
      { kind: "clearBlocker", blockerId },
      (data) => !data.objective?.blockers.some((blocker) => blocker.id === blockerId),
      `blocker ${blockerId} still exists`,
    )
    if (outcome !== "applied") {
      deps.onError(
        `/goal unblock: stopped after clearing ${cleared}; ${frozenIds.length - cleared} frozen blocker(s) were not cleared by this command`,
      )
      return
    }
    cleared += 1
    if (index < frozenIds.length - 1) {
      const refreshed = await requireSnapshot(deps)
      if (refreshed === null) {
        deps.onError(`/goal unblock: readback failed after clearing ${cleared} blocker(s)`)
        return
      }
      current = refreshed
    }
  }
  deps.appendSystem(`Cleared ${cleared} blocker${cleared === 1 ? "" : "s"}.`)
  await fetchReadoutBody(deps, "goal")
}

const noOp = (deps: GoalSlashDeps, message: string): void => deps.appendSystem(message)

interface PreparedMutation {
  readonly mutation: unknown
  readonly landed: (data: GoalReadoutData) => boolean
  readonly pending?: string
}

const applyPrepared = async (
  deps: GoalSlashDeps,
  snapshot: GoalReadoutData,
  prepared: PreparedMutation,
): Promise<void> => {
  const outcome = await runMutation(
    deps,
    snapshot,
    prepared.mutation,
    prepared.landed,
    prepared.pending ?? "requested state was not observed",
  )
  if (outcome === "applied" || outcome === "rejected") await fetchReadoutBody(deps, "goal")
}

type SnapshotCommand = Exclude<GoalCommand, { kind: "show" | "work" | "verify" | "error" }>
type SnapshotHandler = (
  deps: GoalSlashDeps,
  snapshot: GoalReadoutData,
  command: SnapshotCommand,
) => Promise<void>

const requireObjective = (
  deps: GoalSlashDeps,
  snapshot: GoalReadoutData,
  label: string,
): GoalReadoutObjectiveView | null => {
  if (snapshot.objective === null) deps.onError(`${label}: no goal is set`)
  return snapshot.objective
}

const SNAPSHOT_HANDLERS: Readonly<Record<SnapshotCommand["kind"], SnapshotHandler>> = {
  create: async (deps, snapshot, raw) => {
    const command = raw as Extract<SnapshotCommand, { kind: "create" }>
    if (snapshot.objective !== null) {
      deps.onError("/goal: a goal already exists; use `/goal edit <text>`")
      return
    }
    await applyPrepared(deps, snapshot, {
      mutation: { kind: "create", definition: { goal: command.text } },
      landed: (data) => data.objective?.goal === command.text,
    })
  },
  edit: async (deps, snapshot, raw) => {
    const command = raw as Extract<SnapshotCommand, { kind: "edit" }>
    const objective = requireObjective(deps, snapshot, "/goal edit")
    if (objective === null) return
    await applyPrepared(deps, snapshot, {
      mutation: {
        kind: "replace",
        definition: { goal: command.text, budget: budgetCaps(objective) },
      },
      landed: (data) =>
        data.objective?.goal === command.text &&
        data.objective.objectiveId !== objective.objectiveId,
    })
  },
  pause: async (deps, snapshot) => {
    const objective = requireObjective(deps, snapshot, "/goal pause")
    if (objective === null) return
    if (objective.status === "paused") return noOp(deps, "Goal is already paused.")
    await applyPrepared(deps, snapshot, {
      mutation: { kind: "setExplicitStatus", status: "paused" },
      landed: (data) => data.objective?.status === "paused",
    })
  },
  resume: async (deps, snapshot) => {
    const objective = requireObjective(deps, snapshot, "/goal resume")
    if (objective === null) return
    if (objective.status === "active") return noOp(deps, "Goal is already active.")
    await applyPrepared(deps, snapshot, {
      mutation: { kind: "setExplicitStatus", status: "active" },
      landed: (data) => data.objective?.status === "active",
      pending: "goal did not become active",
    })
  },
  clear: async (deps, snapshot) => {
    if (snapshot.objective === null) return noOp(deps, "Goal: no goal to clear.")
    await applyPrepared(deps, snapshot, {
      mutation: { kind: "clear" },
      landed: (data) => data.objective === null,
    })
  },
  abandon: async (deps, snapshot) => {
    const objective = requireObjective(deps, snapshot, "/goal abandon")
    if (objective === null) return
    if (objective.startedAttemptId === undefined) {
      noOp(deps, "Goal: no attempt was in flight.")
      return
    }
    await applyPrepared(deps, snapshot, {
      mutation: { kind: "abandonAttempt", attemptId: objective.startedAttemptId },
      landed: (data) => data.objective?.startedAttemptId === undefined,
    })
  },
  budget: async (deps, snapshot, raw) => {
    const command = raw as Extract<SnapshotCommand, { kind: "budget" }>
    const objective = requireObjective(deps, snapshot, "/goal budget")
    if (objective === null) return
    const sameTurns =
      command.caps.maxTurns === undefined || command.caps.maxTurns === objective.budget.maxTurns
    const sameTokens =
      command.caps.maxTokens === undefined || command.caps.maxTokens === objective.budget.maxTokens
    if (sameTurns && sameTokens) return noOp(deps, "Goal budget already has the requested caps.")
    await applyPrepared(deps, snapshot, {
      mutation: { kind: "amendBudget", budget: command.caps },
      landed: (data) =>
        data.objective !== null &&
        (command.caps.maxTurns === undefined ||
          command.caps.maxTurns === data.objective.budget.maxTurns) &&
        (command.caps.maxTokens === undefined ||
          command.caps.maxTokens === data.objective.budget.maxTokens),
    })
  },
  "criterion-add": async (deps, snapshot, raw) => {
    const command = raw as Extract<SnapshotCommand, { kind: "criterion-add" }>
    const objective = requireObjective(deps, snapshot, "/goal criterion add")
    if (objective === null) return
    await applyPrepared(deps, snapshot, {
      mutation: {
        kind: "replace",
        definition: replacementDefinition(objective, objective.goal, [
          ...declarations(objective.criteria),
          { text: command.text },
        ]),
      },
      landed: (data) =>
        data.objective?.criteria.some((criterion) => criterion.text === command.text) ?? false,
    })
  },
  "check-add": async (deps, snapshot, raw) => {
    const command = raw as Extract<SnapshotCommand, { kind: "check-add" }>
    const objective = requireObjective(deps, snapshot, "/goal check add")
    if (objective === null) return
    await applyPrepared(deps, snapshot, {
      mutation: {
        kind: "replace",
        definition: replacementDefinition(objective, objective.goal, [
          ...declarations(objective.criteria),
          {
            text: command.text,
            check: {
              kind: "command",
              argv: command.argv,
              timeoutMs: DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS,
              successExitCodes: DEFAULT_OBJECTIVE_CHECK_SUCCESS_EXIT_CODES,
            },
          },
        ]),
      },
      landed: (data) =>
        data.objective?.criteria.some(
          (criterion) =>
            criterion.kind === "checked" &&
            criterion.text === command.text &&
            JSON.stringify(criterion.check.argv) === JSON.stringify(command.argv),
        ) ?? false,
    })
  },
  "criterion-done": async (deps, snapshot, raw) => {
    const command = raw as Extract<SnapshotCommand, { kind: "criterion-done" }>
    const objective = requireObjective(deps, snapshot, "/goal criterion done")
    if (objective === null) return
    const criterion = criterionByTarget(objective.criteria, command.target)
    if (criterion === null) {
      deps.onError(`/goal criterion done: unknown index or id '${command.target}'`)
      return
    }
    if (criterion.kind === "checked") {
      deps.onError("/goal criterion done: checked-criterion-needs-verify")
      return
    }
    if (criterion.met) return noOp(deps, "Criterion is already attested.")
    await applyPrepared(deps, snapshot, {
      mutation: { kind: "markCriterion", criterionId: criterion.id, met: true },
      landed: (data) =>
        data.objective?.criteria.some((entry) => entry.id === criterion.id && entry.met) ?? false,
    })
  },
  unblock: (deps, snapshot) => runUnblock(deps, snapshot),
}

const runVerify = async (deps: GoalSlashDeps): Promise<void> => {
  const snapshot = await requireSnapshot(deps)
  if (snapshot === null) return
  if (snapshot.objective === null) {
    deps.onError("/goal verify: no goal is set")
    return
  }
  if (!snapshot.objective.criteria.some((criterion) => criterion.kind === "checked")) {
    noOp(deps, "Goal: no checked criteria to verify.")
    return
  }
  const receipt = await deps.requestGoalVerification(snapshot.revision)
  if (receipt.kind === "undelivered") {
    deps.onError("/goal verify: request was not delivered (session socket is not open)")
    return
  }
  if (receipt.kind === "timeout") {
    deps.onError(`/goal verify: outcome unknown after timeout (${receipt.requestId})`)
    return
  }
  const { frame } = receipt
  if (frame.status === "refused" || frame.outcome.kind !== "verified") {
    deps.onError(
      `/goal verify: ${frame.outcome.kind}${
        typeof frame.outcome.reason === "string" ? ` (${frame.outcome.reason})` : ""
      }`,
    )
  } else {
    deps.appendSystem(
      `Goal verification applied: ${String(frame.outcome.passed)} passed, ${String(frame.outcome.failed)} failed.`,
    )
  }
  await fetchReadoutBody(deps, "goal")
}

const runControl = async (deps: GoalSlashDeps, command: GoalCommand): Promise<void> => {
  if (command.kind === "show") return fetchReadoutBody(deps, "goal")
  if (command.kind === "work") {
    if (!deps.sendGoalWork(command.instruction)) {
      deps.onError("/goal work: command was not delivered (session socket is not open)")
    }
    return
  }
  if (command.kind === "verify") return runVerify(deps)
  if (command.kind === "error") {
    deps.onError(command.message)
    return
  }
  const snapshot = await requireSnapshot(deps)
  if (snapshot !== null) await SNAPSHOT_HANDLERS[command.kind](deps, snapshot, command)
}

export const buildGoalSlashCommands = (deps: GoalSlashDeps): readonly SlashCommand[] => [
  {
    slug: "goal",
    kind: "local",
    description:
      "Durable goal — show, work, pause/stop, resume, edit, budget, unblock, criterion/check, verify, abandon, clear",
    action: async (rest: string): Promise<string> => {
      await runControl(deps, parseGoalCommand(rest))
      return ""
    },
  },
]
