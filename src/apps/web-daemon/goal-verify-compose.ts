import { sleep } from "@/agent/loop/sleep"
import type { ObjectivePort, ObjectiveVerificationPort, VerificationOutcome } from "@/objective"
import { createObjectiveCapabilities } from "@/objective"
import { errMessage } from "@/shared"

const SETTLE_DRAIN_MS = 10_000

export type GoalVerifyResult =
  | { readonly status: "completed"; readonly outcome: VerificationOutcome }
  | { readonly status: "refused"; readonly outcome: VerificationOutcome }

export interface WebGoalVerifyHandler {
  request(expectedObjectiveRevision: number, reply: (result: GoalVerifyResult) => void): void
  stop(): void
  settled(timeoutMs?: number): Promise<void>
}

export interface WebGoalVerifyPorts {
  readonly objectiveAuthority?: ObjectivePort | undefined
  readonly objectiveVerifier?: ObjectiveVerificationPort | undefined
}

const rejected = (reason: string): GoalVerifyResult => ({
  status: "refused",
  outcome: { kind: "rejected", reason },
})

/** Compose once over the SAME coordinator used by turn settlement. */
export const composeWebGoalVerify = (args: {
  readonly threadId: string
  readonly runtime: WebGoalVerifyPorts
}): WebGoalVerifyHandler | undefined => {
  const authority = args.runtime.objectiveAuthority
  const verifier = args.runtime.objectiveVerifier
  if (authority === undefined || verifier === undefined) return undefined
  const read = createObjectiveCapabilities(authority).read
  let active: { controller: AbortController; task: Promise<void> } | null = null

  return {
    request: (expectedObjectiveRevision, reply) => {
      if (active !== null) {
        reply(rejected("verification-in-flight"))
        return
      }
      const domain = read.readDomain(args.threadId)
      const objective = domain.state?.objective
      if (objective === undefined) {
        reply(rejected("objective-missing"))
        return
      }
      if (domain.revision !== expectedObjectiveRevision) {
        reply(rejected(`stale-revision:${domain.revision}`))
        return
      }
      if (!objective.successCriteria.some((criterion) => criterion.kind === "checked")) {
        reply({ status: "completed", outcome: { kind: "no-checks" } })
        return
      }
      const controller = new AbortController()
      const task = verifier
        .verify(args.threadId, undefined, controller.signal, expectedObjectiveRevision)
        .then((outcome) => reply({ status: "completed", outcome }))
        .catch((error: unknown) => reply(rejected(`verifier-failed:${errMessage(error)}`)))
        .finally(() => {
          if (active?.task === task) active = null
        })
      active = { controller, task }
    },
    stop: () => active?.controller.abort(),
    settled: async (timeoutMs = SETTLE_DRAIN_MS) => {
      const task = active?.task
      if (task === undefined) return
      const cap = new AbortController()
      const timer = setTimeout(() => cap.abort(), Math.max(1, timeoutMs))
      try {
        await Promise.race([task, sleep(timeoutMs, cap.signal)])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
