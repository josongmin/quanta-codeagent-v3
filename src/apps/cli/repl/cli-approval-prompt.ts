import { type ConfirmDecision } from "@/agent"
import type { PendingApprovalView } from "@/protocol/session"
import type { ApprovalDecisionResult } from "@/runner/orchestrate"
import {
  prefixGrantLabel,
  type ToolAction,
  type TrustScopeRegistry,
} from "@/permission"
import type { BootstrapIdleMonitor, BootstrapRejectCounter } from "@/host/bootstrap"
import { type ActionDiff, diffPreviewEnabled, renderActionDiff } from "../diff-preview"
import { preflightApplyWarning, preflightCheckEnabled } from "../preflight"
import type { MidTurnApprovalChannel } from "./mid-turn-approval-channel"
import { maybeHunkOption, runHunkSelect } from "./cli-hunk-select-flow"

export interface CliHitlDeps {
  readonly idleMonitor: BootstrapIdleMonitor
  readonly rejectCounter: BootstrapRejectCounter
  readonly channel: MidTurnApprovalChannel
  readonly cwd: string
  readonly trustScope?: { registry: TrustScopeRegistry; projectKey: string }
}

interface EscalationScopeView {
  readonly activeSkill: string
  readonly tool: string
  readonly reason: string
  readonly justification?: string | undefined
}

interface NormalVerbCaps {
  readonly subject: string
  readonly contextHeader?: string
  readonly hunk?: { readonly diff: ActionDiff; readonly ids: string[] }
  readonly prefixLabel?: string | null
  readonly durable?: boolean
}

type NormalVerbAnswer =
  | { readonly kind: "allow"; readonly scope?: "session" }
  | { readonly kind: "allow_prefix"; readonly durable: boolean }
  | { readonly kind: "hunk_select" }
  | { readonly kind: "deny"; readonly steer?: string }

export const askLine = async (
  channel: MidTurnApprovalChannel,
  prompt: string,
  label = "prompt",
): Promise<string> => {
  if (channel.active) {
    const result = await channel.awaitLine(undefined, label, () => process.stderr.write(prompt))
    if (result.kind === "line") return result.line
    const why = result.cause === "turn_teardown" ? "turn ended" : "canceled by its consumer"
    process.stderr.write(
      `\n[quanta] ${label} prompt released unanswered (${why}) — treated as deny/fail-closed.\n`,
    )
    return ""
  }
  const readline = await import("node:readline/promises")
  const adhoc = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await adhoc.question(prompt)
  } finally {
    adhoc.close()
  }
}

export const buildBackgroundConsentPort =
  (channel: MidTurnApprovalChannel) =>
  async (info: { readonly command: string; readonly elapsedMs: number }): Promise<boolean> => {
    const shown = info.command.length > 60 ? `${info.command.slice(0, 60)}…` : info.command
    const secs = Math.max(1, Math.round(info.elapsedMs / 1000))
    const ans = (
      await askLine(
        channel,
        `Command still running after ${secs}s: ${shown}\nMove to background? [y]es / [N]o (kill) `,
        "background-consent",
      )
    )
      .trim()
      .toLowerCase()
    return ans === "y" || ans === "yes"
  }

const askSteerText = async (deps: CliHitlDeps): Promise<string | undefined> => {
  const wasActive = deps.channel.active
  const first = (await askLine(deps.channel, "Steer (what to do instead): ", "approval")).trim()
  if (first.length > 0) return first
  if (wasActive && !deps.channel.active) return undefined
  const second = (
    await askLine(deps.channel, "steer text required (or N to deny): ", "approval")
  ).trim()
  if (second.length === 0 || second.toLowerCase() === "n") return undefined
  return second
}

const promptEscalationVerbs = async (
  deps: CliHitlDeps,
  scope: EscalationScopeView,
  contextHeader = "",
): Promise<ConfirmDecision> => {
  const header =
    `Skill '${scope.activeSkill}' scope — tool '${scope.tool}' is out of scope.\n` +
    `  reason: ${scope.reason}\n` +
    (scope.justification !== undefined ? `  rationale: ${scope.justification}\n` : "")
  const ans = (
    await askLine(
      deps.channel,
      `${contextHeader}${header}Allow [o]nce / allow [s]ession / [d]eny / deny+s[t]eer? [o/s/D/t] `,
      "approval",
    )
  )
    .trim()
    .toLowerCase()
  deps.idleMonitor.markActive()
  if (ans === "o") {
    deps.rejectCounter.recordAccept()
    return { decision: "allow", scope: "once" }
  }
  if (ans === "s") {
    deps.rejectCounter.recordAccept()
    return { decision: "allow", scope: "session" }
  }
  if (ans === "t") {
    const steer = await askSteerText(deps)
    deps.rejectCounter.recordDeny()
    return steer !== undefined ? { decision: "deny_and_steer", steer } : { decision: "deny" }
  }
  deps.rejectCounter.recordDeny()
  return { decision: "deny" }
}

const renderNormalVerbPrompt = (caps: NormalVerbCaps): string => {
  const context = caps.contextHeader ?? ""
  const prefixLabel = caps.prefixLabel ?? null
  const durable = caps.durable === true && prefixLabel !== null
  const hunkVerb = caps.hunk !== undefined ? " / [h]unk-select" : ""
  return durable
    ? `${context}Allow ${caps.subject}? [y]es / [a]lways session / [p] \`${prefixLabel}\` this session / [P] \`${prefixLabel}\` ALL sessions / [N]o / deny+s[t]eer${hunkVerb}: `
    : prefixLabel !== null
      ? `${context}Allow ${caps.subject}? [y]es / [a]lways session / [p] always \`${prefixLabel}\` cmds / [N]o / deny+s[t]eer${hunkVerb}: `
      : `${context}Allow ${caps.subject}? [y]es / [a]lways session / [N]o / deny+s[t]eer${hunkVerb}: `
}

const promptNormalApprovalVerbs = async (
  deps: CliHitlDeps,
  caps: NormalVerbCaps,
): Promise<NormalVerbAnswer> => {
  const prefixLabel = caps.prefixLabel ?? null
  const durable = caps.durable === true && prefixLabel !== null
  const raw = (await askLine(deps.channel, renderNormalVerbPrompt(caps), "approval")).trim()
  const ans = raw.toLowerCase()
  deps.idleMonitor.markActive()
  if (caps.hunk !== undefined && ans === "h") return { kind: "hunk_select" }
  if (ans === "y" || ans === "yes") {
    deps.rejectCounter.recordAccept()
    return { kind: "allow" }
  }
  if (ans === "a" || ans === "always") {
    deps.rejectCounter.recordAccept()
    return { kind: "allow", scope: "session" }
  }
  if (durable && raw === "P") {
    deps.rejectCounter.recordAccept()
    return { kind: "allow_prefix", durable: true }
  }
  if (prefixLabel !== null && ans === "p") {
    deps.rejectCounter.recordAccept()
    return { kind: "allow_prefix", durable: false }
  }
  if (ans === "t") {
    const steer = await askSteerText(deps)
    deps.rejectCounter.recordDeny()
    return steer !== undefined ? { kind: "deny", steer } : { kind: "deny" }
  }
  deps.rejectCounter.recordDeny()
  return { kind: "deny" }
}

const buildConfirmContext = async (deps: CliHitlDeps, action: ToolAction): Promise<string> => {
  let context = ""
  if (diffPreviewEnabled()) {
    const preview = await renderActionDiff(action)
    if (preview !== undefined) context += `${preview}\n`
  }
  if (preflightCheckEnabled()) {
    const warning = await preflightApplyWarning(action, { cwd: deps.cwd })
    if (warning !== undefined) context += `${warning}\n`
  }
  return context
}

export const buildCliOnConfirm =
  (deps: CliHitlDeps) =>
  async (action: ToolAction): Promise<boolean | ConfirmDecision> => {
    let context = await buildConfirmContext(deps, action)
    const scope = action.scopeContext
    if (scope !== undefined) {
      return promptEscalationVerbs(deps, { ...scope, tool: action.tool }, context)
    }
    const team = action.teamEscalation
    if (team !== undefined) {
      context +=
        `Subagent '${team.workerId}' asks to run '${action.tool}' — scope: ${team.scope}\n` +
        `  reason: ${team.reason}\n`
    }
    const hunkOption = await maybeHunkOption(deps, action)
    const prefixLabel =
      typeof action.shellCommand === "string" && action.shellCommand.length > 0
        ? prefixGrantLabel(`${action.tool}|${action.shellCommand}`)
        : null
    const durable = prefixLabel !== null && deps.trustScope !== undefined
    const answer = await promptNormalApprovalVerbs(deps, {
      subject: action.tool,
      ...(context.length > 0 ? { contextHeader: context } : {}),
      ...(hunkOption !== undefined ? { hunk: hunkOption } : {}),
      prefixLabel,
      durable,
    })
    switch (answer.kind) {
      case "hunk_select":
        return hunkOption !== undefined
          ? runHunkSelect(deps, hunkOption.diff, hunkOption.ids, askLine)
          : false
      case "allow":
        return answer.scope === "session" ? { decision: "allow", scope: "session" } : true
      case "allow_prefix":
        if (answer.durable && deps.trustScope !== undefined && prefixLabel !== null) {
          deps.trustScope.registry.grant(deps.trustScope.projectKey, {
            tool: action.tool,
            scope: "project",
            commandPattern: prefixLabel,
          })
        }
        return { decision: "allow", scope: "session_prefix" }
      case "deny":
        return answer.steer !== undefined
          ? { decision: "deny_and_steer", steer: answer.steer }
          : false
    }
  }

export const buildCliApprovalPrompt =
  (deps: CliHitlDeps) =>
  async (approval: PendingApprovalView): Promise<ApprovalDecisionResult> => {
    const scope = approval.scopeContext
    if (scope !== undefined) {
      const decision = await promptEscalationVerbs(deps, scope)
      if (decision.decision === "allow") {
        return {
          decision: "approve",
          ...(decision.scope !== undefined ? { scope: decision.scope } : {}),
        }
      }
      if (decision.decision === "deny_and_steer") {
        return { decision: "deny", steer: decision.steer }
      }
      return { decision: "deny" }
    }
    const answer = await promptNormalApprovalVerbs(deps, {
      subject: "pending action",
      contextHeader: `Approval required: ${approval.reason}\n`,
    })
    switch (answer.kind) {
      case "allow":
        return answer.scope === "session" ? { decision: "approve", scope: "session" } : "approve"
      case "deny":
        return answer.steer !== undefined ? { decision: "deny", steer: answer.steer } : "deny"
      default:
        return "deny"
    }
  }
