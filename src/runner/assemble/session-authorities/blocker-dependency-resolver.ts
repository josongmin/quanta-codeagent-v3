import { createHash } from "node:crypto"
import type { RunEntry, RunLedgerPort } from "@/agent/run-ledger"
import type { BlockerDependencyResolution, BlockerDependencyResolverPort } from "@/objective"
import type { TaskRecord, TaskRegistry } from "@/subagent"

export interface RegistryBlockerDependencySources {
  readonly runLedger?: (() => RunLedgerPort | undefined) | undefined
  readonly tasks?: (() => TaskRegistry | undefined) | undefined
}

const unresolved = (
  reason: Extract<BlockerDependencyResolution, { kind: "dependency-unresolved" }>["reason"],
): BlockerDependencyResolution => ({ kind: "dependency-unresolved", reason })

const activeRun = (entry: RunEntry): boolean =>
  entry.status === "running" || entry.status === "waiting"

const activeTask = (task: TaskRecord): boolean => task.status === "running"

const registryRef = (kind: "tool" | "child-agent", ref: string): string => {
  const prefix = kind === "tool" ? "run:" : "task:"
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
}

const occurrenceEvidenceId = (dependencyId: string, attemptId: string, startedAt: number): string =>
  `occ:v1:${createHash("sha256")
    .update("objective-blocker-occurrence-v1\0")
    .update(dependencyId)
    .update("\0")
    .update(attemptId)
    .update("\0")
    .update(String(startedAt))
    .digest("hex")}`

const resolved = (
  dependencyId: string,
  attemptId: string,
  startedAt: number,
): BlockerDependencyResolution => ({
  kind: "resolved",
  dependencyId,
  occurrenceEvidenceId: occurrenceEvidenceId(dependencyId, attemptId, startedAt),
})

const resolveRun = (
  ledger: RunLedgerPort | undefined,
  threadId: string,
  ref: string,
): RunEntry | BlockerDependencyResolution => {
  if (ledger === undefined) return unresolved("unsupported-kind")
  const entry = ledger.get(ref)
  if (entry === null) return unresolved("unknown")
  if (entry.owner !== threadId) return unresolved("wrong-thread")
  return activeRun(entry) ? entry : unresolved("inactive")
}

const resolveToolDependency = (run: RunEntry, attemptId: string): BlockerDependencyResolution =>
  run.kind === "subagent"
    ? unresolved("unknown")
    : resolved(`run:${run.kind}:${run.id}`, attemptId, run.startedAt)

const resolveChildDependency = (
  sources: RegistryBlockerDependencySources,
  run: RunEntry,
  ref: string,
  attemptId: string,
): BlockerDependencyResolution => {
  const task = sources.tasks?.()?.get(ref)
  if (task === undefined) return unresolved("unknown")
  if (!activeTask(task) || run.kind !== "subagent") return unresolved("inactive")
  return resolved(`task:${task.id}`, attemptId, task.startedAt)
}

const resolveKnownTarget = (
  sources: RegistryBlockerDependencySources,
  input: Parameters<BlockerDependencyResolverPort["resolve"]>[0],
): BlockerDependencyResolution => {
  if (
    input.target.kind === "approval" ||
    input.target.kind === "user-input" ||
    input.target.kind === "external"
  ) {
    return unresolved("unsupported-kind")
  }
  const ref = registryRef(input.target.kind, input.target.ref)
  const run = resolveRun(sources.runLedger?.(), input.threadId, ref)
  if (!("id" in run)) return run
  return input.target.kind === "tool"
    ? resolveToolDependency(run, input.attemptId)
    : resolveChildDependency(sources, run, ref, input.attemptId)
}

/**
 * Layer-2 adapter over existing host registries. It creates no dependency
 * registry: a candidate resolves only when the named RunLedger/TaskRegistry
 * record is active and belongs to the objective thread.
 */
export const createRegistryBlockerDependencyResolver = (
  sources: RegistryBlockerDependencySources,
): BlockerDependencyResolverPort => ({
  resolve(input): BlockerDependencyResolution {
    try {
      return resolveKnownTarget(sources, input)
    } catch {
      return unresolved("unknown")
    }
  },
})
