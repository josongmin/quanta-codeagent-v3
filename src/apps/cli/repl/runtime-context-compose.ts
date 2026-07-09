import { isAbsolute, resolve } from "node:path"
import * as readline from "node:readline/promises"
import {
  type ConfirmDecision,
  createOnConfirmReviewerPort,
  loadNamedAgents,
  mintActiveWorktreeSlot,
  type NamedAgentResolver,
} from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { ResponsesContinuationStore } from "@/llm"
import {
  // #20 (durable prefix grants) — the persistent, cross-session trust-scope
  // registry the gate consults + the [P] verb mints into.
  APPROVAL_LADDER,
  CircumventionTracker,
  createPersistentTrustScopeRegistry,
  type PermissionStore,
  parseApprovalLadderName,
  // #20 — the operator-facing program token a `session_prefix` grant would cover
  // (null when this command cannot be safely prefix-granted).
  prefixGrantLabel,
  type ReviewerSandboxProfile,
  selectDefaultReviewer,
  setAutoApprovalReviewObserver,
  type ToolAction,
  type TrustScopeRegistry,
} from "@/permission"
import type { PendingApprovalView } from "@/protocol/session"
import { splitHunks } from "@/runner/diff-ops"
import { applyHunkSelection } from "@/runner/hunk-apply"
import { resolveNetworkProxyFromEnv } from "@/runner/knobs/knobs/network-proxy"
import type { ApprovalDecisionResult } from "@/runner/orchestrate"
import { composeRuntimeBootstrapContext, type RuntimeContext } from "@/sdk/runtime"
import { gateOn, runtimeConfig } from "@/shared"
import { decisionEmitterFromStream, type StreamPort } from "@/stream"
import type { WorktreeSlotHandle } from "@/tool"
import {
  type ActionDiff,
  computeActionDiff,
  diffPreviewEnabled,
  renderActionDiff,
} from "../diff-preview"
import type { IdleMonitor } from "../idle-monitor"
import { buildShellSnapshotConfig, buildSummarizerLlm } from "../internal"
// #19 — approval-time applicability pre-flight (edit/apply_patch).
import { preflightApplyWarning, preflightCheckEnabled } from "../preflight"
import type { RejectCounter } from "../reject-counter"
import { parseHunkSelection, renderHunkChoices, shapePartialDecision } from "./hunk-select"
import {
  createMidTurnApprovalChannel,
  type MidTurnApprovalChannel,
} from "./mid-turn-approval-channel"
import { createCliPlanExitPort, createCliUserInputPort } from "./session-host-ports"

// MID-TURN FIX (jun-10): when an in-turn keystroke reader owns stdin (a turn is
// streaming), opening a second ad-hoc `readline` here fights it and the prompt
// fail-closes to deny ("입력창이 안 떠서"). When `channel.active`, route through
// the in-turn reader's captured line instead of a conflicting readline. Between
// turns (`active` false) keep the ad-hoc readline (byte-identical legacy).
const askLine = async (channel: MidTurnApprovalChannel, prompt: string): Promise<string> => {
  if (channel.active) {
    process.stderr.write(prompt)
    return await channel.awaitLine()
  }
  const adhoc = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await adhoc.question(prompt)
  } finally {
    adhoc.close()
  }
}

/** T03 — is the AGENT reviewer (guardian) the operator's chosen posture? True
 *  when the strict `QUANTA_AUTO_REVIEW` gate is on OR a named approval-ladder
 *  rung whose `approvalsReviewer` is `agent` is selected (only `guardian-approvals`
 *  is). The ladder SSOT is the single source of the reviewer axis. False ⇒
 *  byte-identical legacy reviewer selection + no auto-review notice. */
const ladderAutoReviewEnabled = (): boolean => {
  const rung = parseApprovalLadderName(runtimeConfig().approvalLadder)
  return (
    runtimeConfig().autoReview ||
    (rung !== undefined && APPROVAL_LADDER[rung].approvalsReviewer === "agent")
  )
}

/** ADR-0296 PROMPT mode — the deadline consent gate, bound to the mid-turn
 *  approval `channel`. When `QUANTA_BASH_AUTO_BACKGROUND=prompt`, the bash tool
 *  calls this AT the deadline; `y`/`yes` ⇒ detach into the bg registry, anything
 *  else ⇒ kill (legacy timeout). Default-OFF for kill/background modes (never
 *  invoked), byte-identical when unread. */
const buildBackgroundConsentPort =
  (channel: MidTurnApprovalChannel) =>
  async (info: { readonly command: string; readonly elapsedMs: number }): Promise<boolean> => {
    const shown = info.command.length > 60 ? `${info.command.slice(0, 60)}…` : info.command
    const secs = Math.max(1, Math.round(info.elapsedMs / 1000))
    const ans = (
      await askLine(
        channel,
        `Command still running after ${secs}s: ${shown}\nMove to background? [y]es / [N]o (kill) `,
      )
    )
      .trim()
      .toLowerCase()
    return ans === "y" || ans === "yes"
  }

interface CliHitlDeps {
  readonly idleMonitor: IdleMonitor
  readonly rejectCounter: RejectCounter
  readonly channel: MidTurnApprovalChannel
  // #19 — session cwd, so the pre-flight resolves relative edit/apply_patch
  // targets against the SAME base the tool's jail uses. OPTIONAL: a caller that
  // omits it (deferred-prompt builder / tests) falls back to `process.cwd()` —
  // the pre-flight is best-effort, so a slightly-off base only risks a
  // missed/extra warning, never correctness.
  readonly cwd?: string
  // #20 (durable prefix grants) — when set (gate `QUANTA_TRUST_SCOPE` on), the
  // confirm offers a [P] verb that mints a DURABLE program-token grant into this
  // registry (persisted across sessions); the SAME registry is on the gate
  // config so a later session ask-skips matching commands. Absent ⇒ no [P] verb.
  readonly trustScope?: { registry: TrustScopeRegistry; projectKey: string }
}

/** Shared inline 4-verb prompt for a skill-scope ESCALATION (`scopeContext`
 *  present): allow once / allow session / deny / deny+steer — the same verbs
 *  the web card offers (ADR-0512 P3). Used by BOTH the inline confirm (live
 *  operator, jun-10) and the deferred approval prompt (fallback path), so the
 *  CLI's escalation wording/verbs can never fork between the two routes. */
interface EscalationScopeView {
  readonly activeSkill: string
  readonly tool: string
  readonly reason: string
  readonly justification?: string | undefined
}

const promptEscalationVerbs = async (
  deps: CliHitlDeps,
  scope: EscalationScopeView,
): Promise<ConfirmDecision> => {
  process.stderr.write(
    `Skill '${scope.activeSkill}' scope — tool '${scope.tool}' is out of scope.\n` +
      `  reason: ${scope.reason}\n` +
      (scope.justification !== undefined ? `  rationale: ${scope.justification}\n` : ""),
  )
  const ans = (
    await askLine(
      deps.channel,
      "Allow [o]nce / allow [s]ession / [d]eny / deny+s[t]eer? [o/s/D/t] ",
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
    const steer = (await askLine(deps.channel, "Steer (what to do instead): ")).trim()
    deps.rejectCounter.recordDeny()
    return steer.length > 0 ? { decision: "deny_and_steer", steer } : { decision: "deny" }
  }
  deps.rejectCounter.recordDeny()
  return { decision: "deny" }
}

/** T05 — when `QUANTA_HUNK_APPROVAL` is ON, compute the previewed mutation's
 *  `(path, before, after)` so the confirm prompt can offer per-hunk selection.
 *  Returns the diff + its atomic hunk ids ONLY when there are ≥2 hunks (a single
 *  hunk has no meaningful subset — accept/deny already covers it). `undefined`
 *  ⇒ the prompt is byte-identical to the pre-T05 flow. Best-effort: any failure
 *  (unsupported tool, read error, apply_patch) degrades to whole-call. */
const maybeHunkOption = async (
  deps: CliHitlDeps,
  action: ToolAction,
): Promise<{ diff: ActionDiff; ids: string[] } | undefined> => {
  if (!runtimeConfig().hunkApproval) return undefined
  // Best-effort, fully fenced: this runs INSIDE the blocking confirm prompt, so a
  // throw here must NEVER crash/hang the approval. computeActionDiff is already
  // try/catch'd internally, but the splitHunks/map below sit outside it — wrap the
  // whole body so any unexpected failure degrades to whole-call (undefined).
  try {
    const cwd = deps.cwd ?? process.cwd()
    const reader = (p: string): Promise<string> => {
      const abs = isAbsolute(p) ? p : resolve(cwd, p)
      return Bun.file(abs).text()
    }
    const diff = await computeActionDiff(action, { readFile: reader })
    if (diff === undefined) return undefined
    const ids = splitHunks(diff.before, diff.after).map((h) => h.id)
    if (ids.length < 2) return undefined
    return { diff, ids }
  } catch {
    return undefined
  }
}

/** T05 — drive the interactive hunk picker after the operator chose `[h]`.
 *  Renders the numbered hunks, reads the selection, and either (a) returns a
 *  plain allow when ALL hunks are accepted (let the original tool run), (b) a
 *  plain deny when NONE are, or (c) applies the chosen subset via the executor
 *  (atomic + mode-preserving + staleness-guarded) and returns the shaped
 *  `deny_and_steer` so the model learns exactly what landed. */
const runHunkSelect = async (
  deps: CliHitlDeps,
  diff: ActionDiff,
  ids: string[],
): Promise<boolean | ConfirmDecision> => {
  process.stderr.write(`${renderHunkChoices(diff.before, diff.after)}\n`)
  const raw = await askLine(
    deps.channel,
    `Accept which hunks? [1-${ids.length}] (e.g. "1,3" / "all" / "none"): `,
  )
  deps.idleMonitor.markActive()
  const selected = parseHunkSelection(raw, ids)
  if (selected.length === ids.length) {
    // Whole-call accept — let the original tool apply normally (no executor).
    deps.rejectCounter.recordAccept()
    return true
  }
  if (selected.length === 0) {
    deps.rejectCounter.recordDeny()
    return false
  }
  const cwd = deps.cwd ?? process.cwd()
  const path = isAbsolute(diff.path) ? diff.path : resolve(cwd, diff.path)
  const result = await applyHunkSelection({
    path,
    before: diff.before,
    after: diff.after,
    selectedHunkIds: selected,
  })
  // A successful partial apply is an operator ACCEPT (they kept something), even
  // though the vehicle is a deny_and_steer for the original whole-call.
  if (result.status === "applied") deps.rejectCounter.recordAccept()
  else deps.rejectCounter.recordDeny()
  return shapePartialDecision(result, selected, ids, diff.path)
}

/** jun-10 HITL restructure — the INLINE confirm a live operator answers AT THE
 *  GATE. With `approvalProtocol.interactive` set (below), the runtime approval
 *  controller delegates a mid-turn "ask" here instead of throwing
 *  `RuntimeApprovalRequiredError` — so the turn is NEVER aborted + re-run for
 *  an approval (the deferred round-trip re-paid the full prompt, ~140k input
 *  tokens per approval in real sessions; web/SDK surfaces keep it).
 *
 *  Plain confirms offer the SOTA 4-verb set (Claude Code / Cursor baseline):
 *    [y]es              — allow this call only
 *    [a]lways session   — allow + standing session grant for this actionKey
 *                         (shell-aware, minted by the runtime controller; the
 *                         CC "don't ask again this session" verb — makes a
 *                         parallel `agent` fan-out a ONE-keystroke approval)
 *    [N]o               — deny (default on empty/unknown answer — fail closed)
 *    deny+s[t]eer       — deny AND carry a corrective instruction the loop
 *                         injects as the next user message (Cursor
 *                         REJECT_AND_TELL; the gate already supports it)
 *  An escalation (`scopeContext`) routes to the dedicated o/s/D/t verb set. */
const buildCliOnConfirm =
  (deps: CliHitlDeps) =>
  async (action: ToolAction): Promise<boolean | ConfirmDecision> => {
    if (diffPreviewEnabled()) {
      const preview = await renderActionDiff(action)
      if (preview !== undefined) process.stderr.write(`${preview}\n`)
    }
    // #19 — after the diff, warn if the mutating action would NOT cleanly apply
    // (stale edit anchor / unlocatable patch hunk / missing target) so the
    // operator approves with eyes open. Default-ON via QUANTA_PREFLIGHT_CHECK;
    // OFF ⇒ byte-identical to the pre-#19 prompt. Best-effort (never throws).
    if (preflightCheckEnabled()) {
      const warning = await preflightApplyWarning(action, { cwd: deps.cwd ?? process.cwd() })
      if (warning !== undefined) process.stderr.write(`${warning}\n`)
    }
    const scope = action.scopeContext
    if (scope !== undefined) {
      // ToolAction's scopeContext omits the tool name (it lives on the action) —
      // re-attach it so the shared prompt renders the same header both routes.
      return promptEscalationVerbs(deps, { ...scope, tool: action.tool })
    }
    // T05 — offer the [h]unk-select verb ONLY when QUANTA_HUNK_APPROVAL is ON
    // AND this mutation decomposes into ≥2 previewable hunks. Absent ⇒ the
    // prompt is byte-identical to the pre-T05 flow (no [h] offered).
    const hunkOption = await maybeHunkOption(deps, action)
    // #20 — offer the PREFIX verb ([p] "always allow `<program> …` this
    // session") ONLY when this action is a single simple shell command whose
    // program token can be safely prefix-granted. For a complex/chained command
    // or a non-shell tool `prefixGrantLabel` returns null ⇒ the prompt is
    // byte-identical to the pre-#20 4-verb prompt (no tempting an unsafe grant).
    const prefixLabel =
      typeof action.shellCommand === "string" && action.shellCommand.length > 0
        ? prefixGrantLabel(`${action.tool}|${action.shellCommand}`)
        : null
    // #20 durable — the [P] verb is offered ONLY when a prefix is safe AND a
    // persistent trust-scope registry is wired (gate `QUANTA_TRUST_SCOPE` on).
    const durable = prefixLabel !== null && deps.trustScope !== undefined
    // Capture the RAW answer too: the prefix verbs are case-SENSITIVE ([p] this
    // session vs [P] all sessions) and the lowercased `ans` cannot tell them
    // apart — so the durable check below reads `raw` and runs BEFORE the `ans`
    // "p" check (a typed "P" lowercases to "p", so durable must win first).
    // T05 — append the [h]unk-select verb when a per-hunk option exists.
    const hunkVerb = hunkOption !== undefined ? " / [h]unk-select" : ""
    const raw = (
      await askLine(
        deps.channel,
        durable
          ? `Allow ${action.tool}? [y]es / [a]lways session / [p] \`${prefixLabel}\` this session / [P] \`${prefixLabel}\` ALL sessions / [N]o / deny+s[t]eer${hunkVerb}: `
          : prefixLabel !== null
            ? `Allow ${action.tool}? [y]es / [a]lways session / [p] always \`${prefixLabel}\` cmds / [N]o / deny+s[t]eer${hunkVerb}: `
            : `Allow ${action.tool}? [y]es / [a]lways session / [N]o / deny+s[t]eer${hunkVerb}: `,
      )
    ).trim()
    const ans = raw.toLowerCase()
    deps.idleMonitor.markActive()
    // T05 — [h] drives the per-hunk picker (only offered when hunkOption is set).
    if (hunkOption !== undefined && ans === "h") {
      return runHunkSelect(deps, hunkOption.diff, hunkOption.ids)
    }
    if (ans === "y" || ans === "yes") {
      deps.rejectCounter.recordAccept()
      return true
    }
    if (ans === "a" || ans === "always") {
      deps.rejectCounter.recordAccept()
      return { decision: "allow", scope: "session" }
    }
    // #20 durable — [P] (capital, exact) mints a DURABLE program-token grant into
    // the persistent registry (survives across sessions) AND allows this session
    // (session_prefix). Checked BEFORE the lowercase [p] so a typed "P" is durable.
    if (durable && raw === "P" && deps.trustScope !== undefined && prefixLabel !== null) {
      deps.trustScope.registry.grant(deps.trustScope.projectKey, {
        tool: action.tool,
        scope: "project",
        commandPattern: prefixLabel,
      })
      deps.rejectCounter.recordAccept()
      return { decision: "allow", scope: "session_prefix" }
    }
    if (prefixLabel !== null && ans === "p") {
      deps.rejectCounter.recordAccept()
      return { decision: "allow", scope: "session_prefix" }
    }
    if (ans === "t") {
      const steer = (await askLine(deps.channel, "Steer (what to do instead): ")).trim()
      deps.rejectCounter.recordDeny()
      return steer.length > 0 ? { decision: "deny_and_steer", steer } : false
    }
    deps.rejectCounter.recordDeny()
    return false
  }

const buildCliApprovalPrompt =
  (deps: CliHitlDeps) =>
  async (approval: PendingApprovalView): Promise<ApprovalDecisionResult> => {
    // ADR-0512 P3 — a skill-scope ESCALATION approval (carries `scopeContext`)
    // offers the FULL 4-verb prompt so allow_once (no widen) and deny_and_steer
    // (corrective steer) are genuinely reachable on the CLI — matching the yellow
    // escalation card (shared verbatim with the inline confirm via
    // {@link promptEscalationVerbs}). A NORMAL approval keeps the byte-identical
    // `[y/N]` prompt. With `approvalProtocol.interactive` this path is the
    // FALLBACK only (a confirm raised outside any turn scope) — the live-operator
    // route answers inline at the gate and never mints a pending approval.
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
    process.stderr.write(`Approval required: ${approval.reason}\n`)
    // jun-10 — "[a]lways session" on the DEFERRED prompt too: resolves
    // approve+scope:"session" so the runtime controller mints the standing
    // grant (one abort+re-run round-trip per key per session, not per ask).
    const ans = (
      await askLine(deps.channel, "Approve pending action? [y]es / [a]lways session / [N]o ")
    )
      .trim()
      .toLowerCase()
    deps.idleMonitor.markActive()
    if (ans === "y" || ans === "yes") {
      deps.rejectCounter.recordAccept()
      return "approve"
    }
    if (ans === "a" || ans === "always") {
      deps.rejectCounter.recordAccept()
      return { decision: "approve", scope: "session" }
    }
    deps.rejectCounter.recordDeny()
    return "deny"
  }

export interface ComposeCliRuntimeContextArgs {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly loadPermissionStore: () => Promise<PermissionStore | undefined>
  readonly sandboxProfile: ReviewerSandboxProfile
  readonly convStore?: ConversationCheckpointStore
  readonly responsesStore?: ResponsesContinuationStore
  readonly envSource?: Readonly<Record<string, string | undefined>>
}

export interface CliRuntimeContextBindings {
  readonly approvalPrompt: (approval: PendingApprovalView) => Promise<ApprovalDecisionResult>
  /** The in-turn approval input channel — the session loop flips `.active` +
   *  routes captured stdin lines into it around each turn so a mid-turn approval
   *  prompt reads the operator's answer without a second stdin reader. */
  readonly midTurnApprovalChannel: MidTurnApprovalChannel
  readonly runtimeContext: RuntimeContext
  /** UUX-4-04 — the loaded `PermissionStore` (the EXACT instance threaded
   *  into the admissibility gate), surfaced so the `/permission` inspector
   *  can report the grants that actually gate this session. `undefined`
   *  when the load failed (the gate then has no store either). */
  readonly permissionStore: PermissionStore | undefined
}

type RuntimeContextAdmissibility = ReturnType<RuntimeContext["admissibility"]>

interface RuntimeConfirmSlot {
  current: (action: ToolAction) => Promise<boolean | ConfirmDecision>
}

const buildSessionMemoryAutoSummarizer = (
  boot: SessionBootstrapResult,
): ReturnType<typeof buildSummarizerLlm> => buildSummarizerLlm(boot.provider, boot.abort.signal)

const buildBootstrapContextArgs = (args: {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly confirmSlot: RuntimeConfirmSlot
  readonly onConfirm: (action: ToolAction) => Promise<boolean | ConfirmDecision>
  readonly planExitPort: ReturnType<typeof createCliPlanExitPort>
  readonly userInputPort: ReturnType<typeof createCliUserInputPort>
  /** ADR-0296 PROMPT-mode consent gate (mid-turn approval channel). */
  readonly backgroundConsentPort: (info: {
    readonly command: string
    readonly elapsedMs: number
  }) => Promise<boolean>
  readonly summarizerLlm?: ReturnType<typeof buildSummarizerLlm>
  readonly sandboxProfile: ReviewerSandboxProfile
  readonly permissionStore: PermissionStore | undefined
  readonly autoReview: ReturnType<typeof createClassifierBackedAutoReview> | undefined
  /** ADR-0428 jun-02 wire — composition-root env view used for the DIRECT
   *  `QUANTA_NETWORK_PROXY` read (mirrors `resolveMemoryConfigFromEnv`). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** F2 (round-2) — host-loaded named-agent resolver (`loadNamedAgents(cwd)`).
   *  Threaded onto the overlay so the per-turn AgentConfig carries it. Absent ⇒
   *  no `.quanta/agents` (or load fault) ⇒ overlay slot omitted (byte-identical). */
  readonly namedAgentResolver?: NamedAgentResolver
  /** ticket-11 (P8 worktree) — session-scoped active-worktree slot, minted at the
   *  comp-root ONLY when `QUANTA_WORKTREE_TOOL` is on. Threaded onto the overlay so
   *  the per-turn AgentConfig carries it; features.ts registers the worktree tools
   *  over it and dispatch projects its value onto the bash/edit edit-fence. Absent
   *  ⇒ tools unregistered + cwd byte-identical (default-OFF). */
  readonly activeWorktreeSlot?: WorktreeSlotHandle
  /** #20 (durable prefix grants) — persistent trust-scope registry + projectKey,
   *  wired ONLY when `QUANTA_TRUST_SCOPE` is on. Threaded onto the overlay so the
   *  per-turn AgentConfig carries `trustScope` and the gate consults durable
   *  grants. Absent ⇒ slot omitted (default-OFF, byte-identical). */
  readonly trustScope?: { registry: TrustScopeRegistry; projectKey: string }
}): Parameters<typeof composeRuntimeBootstrapContext>[0] => {
  const {
    boot,
    turnStream,
    confirmSlot,
    onConfirm,
    planExitPort,
    userInputPort,
    backgroundConsentPort,
    summarizerLlm,
    sandboxProfile,
    permissionStore,
    autoReview,
    env,
    namedAgentResolver,
    activeWorktreeSlot,
    trustScope,
  } = args
  // ADR-0428 jun-02 wire — DIRECT env read of `QUANTA_NETWORK_PROXY` (this
  // surface builds its base via the host overlay, not `applyKnobs`). Absent /
  // "0" / empty ⇒ `undefined` ⇒ overlay slot omitted ⇒ NO proxy, byte-identical.
  const networkProxy = resolveNetworkProxyFromEnv(env as NodeJS.ProcessEnv)
  const shellSnapshot = buildShellSnapshotConfig()
  return {
    boot,
    stream: turnStream,
    onConfirm,
    includeSearchPipeline: true,
    overlay: {
      // jun-10 HITL restructure — `interactive: true` declares the live
      // operator: the runtime approval controller delegates mid-turn asks to
      // the slot's surface confirm INLINE (no turn abort / re-run). Non-CLI
      // surfaces never set this and keep the deferred approvalRequest protocol.
      approvalProtocol: { confirmSlot, interactive: true },
      ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
      planExitPort,
      userInputPort,
      backgroundConsentPort,
      decisionEmitter: decisionEmitterFromStream(turnStream),
      admissibilityBuilder: ({ materializeReviewerAgent }) =>
        buildAdmissibility({
          boot,
          onConfirm,
          sandboxProfile,
          permissionStore,
          autoReview,
          materializeReviewerAgent: () => materializeReviewerAgent(boot),
        }),
      ...(shellSnapshot !== undefined ? { shellSnapshot } : {}),
      ...(networkProxy !== undefined ? { networkProxy } : {}),
      // F2 (round-2) — overlay the named-agent resolver when the surface loaded
      // a non-empty `.quanta/agents` registry. Absent ⇒ slot omitted ⇒ the
      // per-turn AgentConfig has no resolver (default-OFF byte-identical).
      ...(namedAgentResolver !== undefined ? { namedAgentResolver } : {}),
      // ticket-11 (P8 worktree) — overlay the session-scoped slot when
      // QUANTA_WORKTREE_TOOL minted one. Absent ⇒ slot omitted ⇒ worktree tools
      // unregistered + bash/edit cwd byte-identical (default-OFF).
      ...(activeWorktreeSlot !== undefined ? { activeWorktreeSlot } : {}),
      // #20 — overlay the persistent trust-scope registry when QUANTA_TRUST_SCOPE
      // wired one. Absent ⇒ slot omitted ⇒ gate's trustScopeGrants returns false
      // (default-OFF byte-identical).
      ...(trustScope !== undefined ? { trustScope } : {}),
    },
  }
}

// ALBB-11 — exported so the comp-root HITL wiring hellgate can drive the REAL
// producer (not a hand-passed Set) and assert the `allowlistEscalated` mint.
export const buildAdmissibility = (args: {
  readonly boot: SessionBootstrapResult
  readonly onConfirm: (action: ToolAction) => Promise<boolean | ConfirmDecision>
  readonly sandboxProfile: ReviewerSandboxProfile
  readonly permissionStore: PermissionStore | undefined
  readonly autoReview: ReturnType<typeof createClassifierBackedAutoReview> | undefined
  readonly materializeReviewerAgent: () => ReturnType<
    SessionBootstrapResult["materializeReviewerAgent"]
  >
}): RuntimeContextAdmissibility => {
  const { boot, onConfirm, sandboxProfile, permissionStore, autoReview, materializeReviewerAgent } =
    args
  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  // T03 (feature 03-guardian) — route approvals to the side-agent guardian when
  // the operator opts into the agent reviewer. Driven through the SINGLE approval-
  // ladder SSOT: `QUANTA_APPROVAL_LADDER=<name>` selects a rung and the rung's OWN
  // `approvalsReviewer` field decides (only `guardian-approvals` is `agent`);
  // `QUANTA_AUTO_REVIEW=1` is the strict shortcut for that one rung. Default
  // (neither set / a `user` rung / unknown / `custom`) ⇒ `autoReviewEnabled` stays
  // false ⇒ `selectDefaultReviewer` is byte-identical (reviewer = user / legacy).
  //
  // We do NOT seed a per-thread `ThreadPermission` here: a thread record makes the
  // permission stack (`evaluateStack`) resolve allow/deny directly and never reach
  // the reviewer, so a posture record would DEFEAT guardian routing. Routing the
  // reviewer tier (below) keeps the gate's `ask` → guardian path intact. HARD_DENY
  // still runs BEFORE the guardian (see `@/permission/policy`).
  const autoReviewEnabled = ladderAutoReviewEnabled()
  const threadPermission = permissionStore?.getThread(boot.sessionId)
  const reviewerAgent = materializeReviewerAgent()
  const guardianReview =
    reviewerAgent !== undefined
      ? boot.createSubagentBackedGuardianReview({
          reviewer: reviewerAgent,
          signal: boot.abort.signal,
        })
      : undefined
  // jun-7-misc 03 (ADR-0497) — the per-action TYPED assessor is SELECTED here only
  // when the strict `QUANTA_GUARDIAN_ASSESSOR` knob is on AND a reviewer agent
  // exists. Knob off ⇒ `guardianAssess` stays undefined and is never spread into
  // the port options, so the reviewer port is byte-identical to the binary path.
  const guardianAssess =
    reviewerAgent !== undefined && runtimeConfig().guardianAssessor
      ? boot.createSubagentBackedGuardianAssess({
          reviewer: reviewerAgent,
          signal: boot.abort.signal,
        })
      : undefined
  const reviewerPort =
    autoReview !== undefined || guardianReview !== undefined || guardianAssess !== undefined
      ? createOnConfirmReviewerPort({
          onConfirm,
          ...(autoReview !== undefined ? { autoReview } : {}),
          ...(guardianReview !== undefined ? { guardianReview } : {}),
          ...(guardianAssess !== undefined ? { guardianAssess } : {}),
        })
      : userReviewerPort
  // §3.2 (ticket-04a) — mint the tool-switch CIRCUMVENTION tracker ONLY when the
  // strict `QUANTA_CIRCUMVENT_DETECT` knob is on. Session-scoped (one per
  // bootstrap): it accumulates prior soft-denies across turns so the gate can
  // catch a Bash command that writes a file a prior Edit/Write deny protects.
  // The detection/gate/classifier were fully built but DEAD (never instantiated)
  // — this is the missing comp-root mint. Knob off ⇒ undefined ⇒ never spread ⇒
  // the gate's circumvention precheck never arms (byte-identical legacy).
  const circumventionTracker = runtimeConfig().circumventDetect
    ? new CircumventionTracker()
    : undefined
  // ALBB-11 (ADR-0070 / Round-4) — mint ONE run-scoped dedup Set per session
  // bootstrap. Every `?.`/`!== undefined` guard on `opts.allowlistEscalated` in
  // hitl.ts (single-shot dedup, concurrent coalesce, post-approve record) is
  // inert until the LIVE producer mints this Set — tests hand-passed one, so the
  // coalesce hellgate stayed green while production ran the legacy re-prompt-
  // every-time path. The coalesce WeakMap (`pendingReviewsByRun`, hitl.ts:144)
  // is keyed by THIS handle, so a fresh Set per session gives naturally-isolated
  // dedup state that GC's with the session — NO explicit clear/recycle needed.
  const allowlistEscalated = new Set<string>()
  return {
    ...(permissionStore !== undefined ? { permissionStore } : {}),
    reviewerPort,
    allowlistEscalated,
    defaultReviewer: selectDefaultReviewer({
      threadPermission,
      permissionMode: boot.mode,
      sandboxProfile,
      hasAutoReview: autoReview !== undefined,
      hasGuardianReview: guardianReview !== undefined,
      autoReviewEnabled,
    }),
    ...(circumventionTracker !== undefined ? { circumventionTracker } : {}),
  }
}

export const composeCliRuntimeContext = async (
  args: ComposeCliRuntimeContextArgs,
): Promise<CliRuntimeContextBindings> => {
  const { boot, turnStream, loadPermissionStore, sandboxProfile } = args
  // MID-TURN FIX — the channel that lets a mid-turn approval read the operator's
  // answer through the in-turn keystroke reader (no stdin fight). The session
  // loop flips `.active` + routes captured lines into it around each turn.
  const midTurnApprovalChannel = createMidTurnApprovalChannel()
  // #20 (durable prefix grants) — wire the PERSISTENT trust-scope registry ONLY
  // when `QUANTA_TRUST_SCOPE` is on (opt-in; NOT seeded default-ON like the other
  // CLI gates — durable cross-session grants are a deliberate operator choice).
  // Hydrated once here (async comp-root) so the gate sees prior-session grants on
  // turn 1. `boot.cwd` is the SESSION-RESOLVED jail root, used as BOTH the
  // projectRoot (overlay file location) and the projectKey (grant lookup key) so
  // mint + consult agree. Absent ⇒ undefined ⇒ no [P] verb + gate skips trust-
  // scope (default-OFF, byte-identical).
  const trustScopeEnv = args.envSource ?? process.env
  const trustScope = gateOn(trustScopeEnv, "QUANTA_TRUST_SCOPE")
    ? await (async (): Promise<{ registry: TrustScopeRegistry; projectKey: string }> => {
        const registry = createPersistentTrustScopeRegistry({ projectRoot: boot.cwd })
        await registry.hydrate()
        return { registry, projectKey: boot.cwd }
      })()
    : undefined
  const surfaceOnConfirm = buildCliOnConfirm({
    idleMonitor: boot.idleMonitor as IdleMonitor,
    rejectCounter: boot.rejectCounter as RejectCounter,
    channel: midTurnApprovalChannel,
    cwd: boot.cwd, // #19
    ...(trustScope !== undefined ? { trustScope } : {}), // #20 durable
  })
  const confirmSlot: RuntimeConfirmSlot = {
    current: surfaceOnConfirm,
  }
  const onConfirm = async (action: ToolAction): Promise<boolean | ConfirmDecision> =>
    await confirmSlot.current(action)
  const autoReviewUserPort = createOnConfirmReviewerPort({ onConfirm })
  const autoReview =
    boot.permission.classify !== undefined
      ? createClassifierBackedAutoReview({
          classify: boot.permission.classify,
          userReview: autoReviewUserPort.userReview,
        })
      : undefined
  // T03 — when the agent reviewer is the chosen posture, surface each auto-review
  // as a `tool_progress` notice (keyed by the reviewed tool-call id) so the CLI
  // timeline + web card show "auto-reviewed by guardian: …" rather than the tool
  // silently running. Registered ONLY under the opt-in ⇒ default-OFF byte-identical
  // (no observer ⇒ the reviewer slice's emit is a no-op). The notice is best-effort:
  // `decisionEmitterFromStream`-style throw isolation lives in the sink itself.
  if (ladderAutoReviewEnabled()) {
    setAutoApprovalReviewObserver({
      observe: (ev) => {
        const who = ev.reviewer === "guardian_subagent" ? "guardian" : "auto-review"
        const what =
          ev.phase === "started" ? "reviewing…" : ev.allowed ? "approved (no prompt)" : "denied"
        turnStream.emit({
          type: "tool_progress",
          id: ev.toolCallId ?? "",
          name: ev.tool,
          message: `auto-reviewed by ${who}: ${what}`,
        })
      },
    })
  }
  const permissionStore = await loadPermissionStore()
  const planExitPort = createCliPlanExitPort({ ask: (p) => askLine(midTurnApprovalChannel, p) })
  const userInputPort = createCliUserInputPort({
    ask: (p) => askLine(midTurnApprovalChannel, p),
    stream: turnStream,
  })
  // ADR-0296 PROMPT mode — see {@link buildBackgroundConsentPort}. Bound to the
  // SAME mid-turn approval channel the inline confirm uses. Default-OFF for
  // kill/background modes (never invoked), byte-identical when unread.
  const backgroundConsentPort = buildBackgroundConsentPort(midTurnApprovalChannel)
  const summarizerLlm = buildSessionMemoryAutoSummarizer(boot)
  // F2 (round-2) — load `.quanta/agents` (+ native dir) ONCE per session at this
  // async composition root, using the SESSION-RESOLVED `boot.cwd` (the jailed /
  // resume-switched cwd the surface already settled on — NOT raw `process.cwd()`).
  // Threaded onto the runtime overlay so the interactive REPL's per-turn
  // AgentConfig carries `namedAgentResolver`, giving the primary surface the same
  // named-agent resolution the headless `apps/agent` surface has. FAIL-OPEN +
  // default-OFF: a thrown loader ⇒ `undefined`; an empty registry (no agent dir)
  // ⇒ slot stays absent ⇒ no resolver set ⇒ byte-identical to today.
  const namedAgents = await loadNamedAgents(boot.cwd).catch(() => undefined)
  const namedAgentResolver =
    namedAgents !== undefined && namedAgents.size > 0 ? namedAgents : undefined
  // ticket-11 (P8 worktree) — mint the session-scoped active-worktree slot ONLY
  // when `QUANTA_WORKTREE_TOOL` is on (see {@link mintActiveWorktreeSlot} in
  // `@/agent`). Gate off ⇒ undefined ⇒ worktree tools unregistered + bash/edit
  // cwd byte-identical (default-OFF). `boot.cwd` is the SESSION-RESOLVED jail root
  // the edit-fence keeps absolute writes within — the slot NEVER widens it.
  const activeWorktreeSlot = mintActiveWorktreeSlot(args.envSource ?? process.env, boot.cwd)
  const runtimeContext = await composeRuntimeBootstrapContext({
    ...buildBootstrapContextArgs({
      boot,
      turnStream,
      confirmSlot,
      onConfirm,
      planExitPort,
      userInputPort,
      backgroundConsentPort,
      ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
      sandboxProfile,
      permissionStore,
      autoReview,
      env: args.envSource ?? process.env,
      ...(namedAgentResolver !== undefined ? { namedAgentResolver } : {}),
      ...(activeWorktreeSlot !== undefined ? { activeWorktreeSlot } : {}),
      ...(trustScope !== undefined ? { trustScope } : {}), // #20 durable
    }),
    ...(args.convStore !== undefined || args.responsesStore !== undefined
      ? {
          execution: {
            history: boot.history,
            cwd: boot.cwd,
            envSource: args.envSource ?? process.env,
            ...(args.convStore !== undefined ? { convStore: args.convStore } : {}),
            ...(args.responsesStore !== undefined ? { responsesStore: args.responsesStore } : {}),
          },
        }
      : {}),
    memoryAuto: {
      env: args.envSource ?? process.env,
      logWarn: (msg: string) => process.stderr.write(`[memory-auto] ${msg}\n`),
    },
  })
  return {
    approvalPrompt: buildCliApprovalPrompt({
      idleMonitor: boot.idleMonitor as IdleMonitor,
      rejectCounter: boot.rejectCounter as RejectCounter,
      channel: midTurnApprovalChannel,
      cwd: boot.cwd, // #19 (unused by the deferred prompt; CliHitlDeps shares the shape)
    }),
    midTurnApprovalChannel,
    runtimeContext,
    // UUX-4-04 — surfaced for the `/permission` inspector (same instance the
    // admissibility gate received above).
    permissionStore,
  }
}

/** Test seam — never import in production. Exposes the HITL prompt builders so
 *  the e2e suite can drive the REAL CLI confirm/approval wording + verb routing
 *  against the real gate/controller without booting a full session. */
export const __testing = {
  buildCliOnConfirm,
  buildCliApprovalPrompt,
}
