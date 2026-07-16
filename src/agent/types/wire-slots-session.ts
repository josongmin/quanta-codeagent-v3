/**
 * AgentConfig wire slots — submission/context/budget/plan + retrieval/stream/error-routing + helper-port cluster (submission … shellSnapshotSession).
 *
 * EXTRACTED from `src/agent/types.ts` (god-module split, fix-on-sight per
 * AGENTS.md SE-metrics). `AgentConfig` `extends` this interface so every
 * field below stays on the public `AgentConfig` surface BYTE-IDENTICALLY via
 * declaration-merging — no consumer of `@/agent/types` changes. Field shapes
 * MUST stay byte-identical to the prior inline declarations; adding/renaming a
 * field here is a CONTRACT CHANGE. All members are default-OFF when absent
 * (RFC §1.2).
 */

import type { LLMPort, ResponsesContinuationStore } from "@/llm"
import type { LlmProvider } from "@/llm/providers"
import type { CodeActionPort, FormatPort, RenameApplyPort, SignatureHelpPort } from "@/lsp"
import type { CommitEmbedder, EmbeddingPort, RerankPort, RerankRegistry } from "@/retrieval"
import type { OsSandbox } from "@/runtime/os-sandbox"
import type { RedactionConfig } from "@/security"
import type { AppshotArtifactSink, AppshotSlot } from "@/tool"
import type { WebSearchProvider } from "@/tool/web"
import type { ApprovalStateMachinePort } from "../approval-state-machine"
import type { BudgetMeter, TaskBudget } from "../budget"
import type { BudgetLedger } from "../budget-ledger"
import type { CapEnforcer } from "../cap-enforcer"
import type {
  ControlEffectApplier,
  ControlRequestContext,
  ControlRequestPort,
} from "../control-request"
import type { ConversationActionPort } from "../conversation-action"
import type { ConversationCheckpointStore } from "../conversation-checkpoint"
import type { FollowUpQueue, PausedReason } from "../follow-up-queue"
import type { IdeContextProvider } from "../ide-context"
import type { ObjectivePort } from "../objective"
import type { RunLedgerPort } from "../run-ledger"
import type { ModePolicy } from "../run-mode"
import type { Submission } from "../submission"

export interface WireSlotsSessionConfig {
  /**
   * Codex Submission op envelope (ADR-0072, Spec A3). When set the loop
   * derives the seed user-turn from `submission.op` instead of `messages`
   * (`user_input` / `user_input_with_turn_context` only — other op variants
   * are accepted as shapes but the seed loop falls back to `messages`).
   * Absent ⇒ legacy `messages` path drives the seed (byte-identical).
   *
   * When BOTH `submission` and `messages` are set, `submission` wins for the
   * seed (the caller opted into the typed envelope explicitly); the loop
   * still uses `config.messages` for any caller-supplied history tail (e.g.
   * a resumed session), so passing both is a SUPERSET, not a contradiction.
   */
  submission?: Submission
  /**
   * ADR-0080 IDE context provider seam. Absent ⇒ no snapshot is captured per
   * turn, no `<ide-context>` block is rendered, and the loop is byte-identical
   * to the pre-ADR path. When present, the loop awaits
   * `ideContextProvider.snapshot(turnSignal)` ONCE per turn entry; a non-null
   * snapshot is deterministically rendered (see `renderIdeContext`) and
   * PREPENDED to the latest user message body (NOT inside the trailing
   * `<system-reminder>` — IDE state is user-side context, not a harness
   * reminder). Provider rejections/throws are caught at the boundary, logged
   * via `stream.emit({type:"error", ...})`, and treated as `null` — an IDE
   * bug must not crash the turn (this is a boundary, NOT a fallback for
   * missing data). The provider receives the turn's AbortSignal and is
   * responsible for honoring it.
   */
  ideContextProvider?: IdeContextProvider
  /**
   * Secret redaction (ADR-0078). DEFAULT-ON: with `redaction` absent, the
   * content-plane invariant is active — tool result text, JSONL envelope
   * writes, and memory-distill input are scrubbed through `redactSecrets`
   * (closed RedactionKind enum, deterministic regex, no confidence
   * scoring). Each match surfaces as a {@link RedactionHit} so the user
   * and audit can see WHAT was hidden.
   *
   * To DISABLE the layer the caller MUST set `disabled: true` AND supply
   * a non-empty `acknowledgedRisk` string; without the ack
   * `normalizeRedactionConfig` throws a startup error and the agent
   * refuses to start. `whitelist` is a list of structural overrides for
   * patterns the user trusts (e.g. fixture tokens). See
   * `src/security/redaction-config.ts`.
   */
  redaction?: RedactionConfig
  /**
   * The 12-lever discriminated-union vector for this run (interactive /
   * headless / batch / ci-bot). Absent ⇒ no mode policy is consulted and the
   * loop is byte-for-byte identical to the pre-RFC path. Wired by
   * `apps/agent/assemble.ts`; the LOOP itself does not read this back today,
   * but mode-preset assemble tests verify the field IS on the config, so this
   * is a CONSUMED field (not orphan) — its observability IS the contract.
   */
  modePolicy?: ModePolicy
  /**
   * RFC may-22-unified-agent-runtime / Phase 1 — budget meter slot.
   *
   * When present, the loop's tick sites (turn / model_call / tool_call /
   * shell_command / test_run / token usage) call `meter.tick(kind)` and
   * the per-turn epilogue calls `checkExhausted()`. Absent ⇒ optional-chain
   * no-op, byte-identical loop. The meter is operator-owned (clamped by
   * `ModePolicy.budgetCaps`); the loop only emits ticks.
   */
  budgetMeter?: BudgetMeter
  /**
   * jun-02 — SOFT, model-facing task token budget (Claude `task_budget` mirror).
   *
   * ORTHOGONAL to {@link budgetMeter}: this is NEVER an enforcement gate and
   * NEVER stops the run. When present with `tokens > 0`, the loop forwards it
   * (with `spent` accumulated from this session's observed token usage) into
   * `buildTurnContext`, which renders ONE advisory guidance line into the
   * trailing `<system-reminder>` so the model can self-moderate / wrap up.
   * Absent (or `tokens <= 0`) ⇒ `renderTaskBudgetBlock` returns `undefined` and
   * the dynamic context is BYTE-IDENTICAL to the pre-slice path (default-OFF).
   * Set by the `task-budget` knob (`QUANTA_TASK_BUDGET`).
   */
  taskBudget?: TaskBudget
  /**
   * RFC jun-6 §4 — bounded repo-map turn-0 injection. When present, the loop
   * calls `probeRepoMap` ON TURN 1 ONLY (caller-held latch) and merges its
   * bounded tree string into `TurnContextInput.env.repoMap`; on later turns the
   * field is absent ⇒ `renderEnvBlock` is byte-identical to the no-map path.
   * Carries the three caps (depth / file-count / char-backstop). Absent ⇒ the
   * probe never runs and the env block is byte-identical (default-OFF). Set by
   * the `repo-map` knob (`QUANTA_REPO_MAP`). Caller-side composition only — the
   * renderer never reads this slot, only the pre-rendered `env.repoMap`. */
  repoMap?: {
    readonly maxDepth: number
    readonly maxFiles: number
    readonly maxChars: number
  }
  /**
   * L4 wiring — control-op cluster (2026-05-23). Typed mid-turn
   * {@link ConversationActionPort} the loop polls at the TOP of each turn
   * (before `cfg.steerBarrier`, before the LLM stream opens). Absent ⇒ no
   * poll, no decision, byte-identical legacy. Present ⇒ exactly one
   * `port.next()` call per turn; non-undefined returns drive a single
   * `decideAction()` decision with the same caller-supplied clock the rest
   * of the loop uses.
   *
   * `accepted_injection` ⇒ pushed onto `wm` as a user message (same path as
   * `steerBarrier`), the turn continues. `accepted_control + cancel` ⇒
   * loop finishes with `aborted`. `accepted_control + cancel_subagent` ⇒
   * routed to `features.taskRegistry?.forceStop` (parent KEEPS running).
   * `rejected` ⇒ emit an observability event + skip; the turn proceeds.
   */
  conversationActionPort?: ConversationActionPort
  /**
   * L4 wiring — control-op cluster (2026-05-23). Per-thread queued follow-
   * ups (ADR-0037). When set, the loop calls
   * `followUpQueue.popReady(threadId, pausedReason(threadId))` at the TOP
   * of each turn (after steerBarrier, before the conversation-action
   * poll), and when a ready follow-up is returned its `content` is
   * appended to `wm` as the next user-turn seed. The thread id is the
   * session id ({@link AgentConfig.sessionId}) by default.
   *
   * Absent ⇒ no poll, no allocation, byte-identical legacy. Persistence
   * across restarts: callers wire {@link followUpQueueSnapshotStore} (also
   * default-OFF) to read/restore + write the queue snapshot at session
   * boundaries.
   */
  followUpQueue?: FollowUpQueue
  /**
   * Peer teammate messaging (RFC jun-6, DELTA #1) — auto-delivery drain. When
   * set, `syncQueuedTurnInputs` calls `peerInbox.drainFor(mailboxAgentId ??
   * "root")` at the turn-top seam (right after the follow-up drain) and appends
   * the rendered peer mail as a `role:"user"` message — so a teammate's message
   * auto-arrives in this agent's NEXT turn WITHOUT a manual
   * `subagent_read_messages` poll (and a wake'd idle teammate auto-receives).
   * The drain marks delivered (shares the SAME per-recipient cursor as the
   * manual poll ⇒ delivered exactly once across push+pull) and redacts each
   * body (untrusted-as-DATA). INFORMATION-only — it NEVER invokes the
   * permission decider (the peer bus is a comms channel, never a grant channel).
   *
   * Absent ⇒ `pollPeerInbox` returns null, no append, the turn loop is
   * byte-identical (default-OFF). Wired by the composition root only when
   * `QUANTA_TEAM_PEER_MSG` is on.
   */
  peerInbox?: import("../loop/control-poll").PeerInboxDrain
  /**
   * Control-request drain (ADR-0496, jul-03 A1 activation). The pure
   * `drainControlRequests`/`applyControlEffect` surface existed with ZERO loop
   * callers (inert). When this slot is wired AND `QUANTA_CONTROL_REQUEST` is on
   * (see `env`, defaulting to `process.env`), `pollControlRequests` drains the
   * `port` at the turn-top seam (sibling of `pollPeerInbox`), plans each request
   * against `context`'s live allowlists, and applies the effect via `applier`.
   *
   * SURFACE NOTE: the thick CLI has no control channel — this is the IDE / web-
   * host protocol surface (Claude Code control-request parity). Absent slot OR
   * gate-off ⇒ `pollControlRequests` never polls the port (byte-identical,
   * default-OFF). The gate is load-bearing: a wired slot with the gate off is a
   * strict no-op.
   */
  controlRequest?: {
    readonly port: ControlRequestPort
    readonly applier: ControlEffectApplier
    readonly context: ControlRequestContext
    /** Env for the gate check. Defaults to `process.env` at poll time. */
    readonly env?: Record<string, string | undefined>
  }
  /**
   * L4 wiring — control-op cluster (2026-05-23). Per-thread paused-reason
   * inspector (ADR-0037). When set, the loop calls this BEFORE each
   * `followUpQueue.popReady` so the queue knows whether the thread is
   * paused (null ⇒ ready; non-null ⇒ deferred with a `response_queued`
   * AgentEvent emitted). Absent ⇒ the loop passes `null` to popReady
   * (always ready when set without a reason source).
   */
  pausedReason?: (threadId: string) => PausedReason | null
  /**
   * ADR-0062 rule #3 — optional session-scoped cap enforcement tracker.
   * When set (built via `buildCapEnforcer`), the dispatch seam consults this
   * BEFORE executing a tool call to detect an ignored `nextAction` hint, and
   * AFTER execution to record a fresh hint from the result.
   *
   * DEFAULT-OFF: absent ⇒ no tracking, no reminder, dispatch byte-identical.
   * Enabled via `QUANTA_CAP_ENFORCE=1` env flag or `capEnforce:true` at
   * `runAgent` construction time. The `CapEnforcer` is built once per session
   * by `buildCapEnforcer(config.capEnforce)` and stored here.
   */
  capEnforcer?: CapEnforcer
  /**
   * ADR-0062 rule #3 — enable cap-as-instruction enforcement for this session.
   * When `true`, `runAgent` constructs a `CapEnforcer` (unless one was already
   * supplied via `capEnforcer`) and injects ignored-hint reminders via the
   * `AgentEvent` stream as `<system-reminder>` ToolEvents. Default: `false`.
   * Also enabled by the `QUANTA_CAP_ENFORCE=1` environment variable (checked
   * inside `buildCapEnforcer`).
   */
  capEnforce?: boolean
  /**
   * L4 wiring — control-op cluster (2026-05-23). Optional snapshot store
   * for the follow-up queue. When set, the loop calls
   * `snapshotStore.save(queue.toSnapshot())` at session-end (alongside
   * `persistSession`) AND calls `snapshotStore.load()` at session-start
   * (before the first turn) to restore queued follow-ups across restarts.
   * Absent ⇒ no save/restore, queue is process-scoped only.
   */
  followUpQueueSnapshotStore?: {
    /** Synchronous OR Promise — the loop awaits both. Throws/rejects are
     *  caught at the boundary and surface as an `error` AgentEvent. */
    load(): Promise<ReturnType<FollowUpQueue["toSnapshot"]> | undefined>
    save(snapshot: ReturnType<FollowUpQueue["toSnapshot"]>): Promise<void>
  }
  /**
   * ADR-0127 web tool slice — operator-wired `WebSearchProvider` (Brave /
   * DuckDuckGo / SerpAPI / etc.). When set, `buildSessionFeatures` (via
   * `buildWebSearchBlock`) registers the `web_search` tool bound to this
   * provider. Absent ⇒ `web_search` is NOT registered (default-OFF,
   * byte-identical for every legacy caller — RFC §1.2).
   *
   * Concrete providers live OUTSIDE the `@/tool` slice (no built-in default)
   * — shipping a default would lock the user into a specific search backend
   * + a specific API-key surface. The composition root owns the wire.
   *
   * Top-level (not nested) so future consumers (e.g. a citation surface
   * that wants to inspect query history) can read this slot directly.
   */
  webSearch?: { provider: WebSearchProvider }
  /**
   * ADR-0257 — agent-callable ADVISOR tool (consult a STRONGER / DIFFERENT
   * model for a SECOND OPINION mid-loop). When set, `buildAdvisorBlock`
   * registers the `advisor` tool; absent ⇒ tool NOT registered (default-OFF
   * byte-identical, RFC §1.2). The slot carries the host-built one-shot
   * `consult` (the composition root wraps a concrete `LLMPort` + role-model
   * resolution via the ADR-0256 'advisor' role) plus the `models` allowlist the
   * tool validates an explicit `model` argument against (empty / absent ⇒ no
   * explicit model is accepted; the consult always resolves the default).
   *
   * Top-level (not nested) and duck-typed: the `@/tool/advisor` slice owns the
   * `AdvisorConsultRequest` / `AdvisorConsultResult` shapes; this slot mirrors
   * the consult signature structurally so `@/agent` need not depend on the tool
   * slice's runtime. Caller-side composition only — the loop never reads it.
   */
  advisor?: {
    readonly consult: (req: {
      readonly question: string
      readonly context?: string
      readonly forwardHistory?: boolean
      readonly model?: string
      readonly signal?: AbortSignal
    }) => Promise<
      | { readonly ok: true; readonly analysis: string; readonly modelUsed: string }
      | {
          readonly ok: false
          readonly errorKind:
            | "model-not-allowlisted"
            | "advisor-error"
            | "timeout"
            | "cancelled"
            | "empty-analysis"
          readonly errorMessage: string
        }
    >
    readonly models?: readonly string[]
  }
  /**
   * ADR-0016 (compose seam) — diff→prose AUTHORING tools (`git_compose_commit`
   * + `git_compose_pr`, the Codex `yeet` / Cursor compose pattern). When set,
   * `buildComposeAuthoringBlock` registers the two READ-ONLY authoring tools
   * wired to this one-shot author `LLMPort`; absent ⇒ neither tool is
   * constructed nor registered (default-OFF byte-identical, RFC §1.2 —
   * proven by the compose hellgate battery). The composition root sources
   * `authorLLM` from the `compose-authoring` knob, which folds the session's
   * baseline `cfg.llm` into this slot.
   *
   * Top-level (not nested under git) so the slot mirrors the `gitTools(runner,
   * {authorLLM})` factory option directly and a future surface can read it
   * without reaching into a git-specific sub-object. Caller-side composition
   * only — the loop never reads it (it only sees the two extra tools the
   * builder adds to the registry).
   */
  composeAuthoring?: {
    readonly authorLLM: LLMPort
  }
  /**
   * ADR-0133 — typed pending-promptHook collector for subagent lifecycle
   * events. When a `subagent_start` / `subagent_stop` hook returns a
   * `promptHook` response, the subagent runner pushes it here so the
   * PARENT's next turn-context build can fold it into the system prompt.
   *
   * Today this is a simple array-like (push only) so the loop can drain it
   * once per turn-context build. A host that does NOT want subagent
   * promptHook responses to influence the parent prompt simply does NOT
   * wire this — the runner's `?.push(...)` is a no-op (RFC §1.2 default-
   * OFF, byte-identical).
   *
   * Pushed shape: the bare `HookPromptInject` (`{injectAfterSystem?,
   * injectBeforeUser?}`); the loop folds both sides into the prompt's
   * after-system / before-user slots.
   */
  subagentPendingPrompt?: {
    push: (entry: import("../hooks").HookPromptInject) => unknown
  }
  /**
   * ADR-0405 — gate for the LSP-diagnostics post-edit hook. Env-derived
   * (`QUANTA_LSP_DIAGNOSTICS_HOOK === "1"`) at the COMPOSITION ROOT and threaded
   * in as plain config so the agent slice never reads `process.env` itself
   * (slice-boundary invariant). Absent / false ⇒ the hook is not attached and
   * the loop body is byte-identical (RFC §1.2 default-OFF).
   */
  lspDiagnosticsHookEnabled?: boolean
  /**
   * ADR-0412 — gate for the `check_secrets` LLM tool. Env-derived
   * (`QUANTA_SECRET_CHECK_TOOL === "on"`) at the COMPOSITION ROOT and threaded
   * in as plain config so the agent slice never reads `process.env` itself
   * (slice-boundary invariant). Absent / false ⇒ the tool is NOT registered and
   * the tool set is byte-identical for every legacy caller (RFC §1.2 default-OFF).
   */
  secretCheckToolEnabled?: boolean
  /**
   * ADR-0136 budget-ledger slot — token × pricing → $$ + soft/hard breach
   * events at session/daily scope. When set, `buildBudgetBlock` registers the
   * `budget_status` tool wired against this ledger. Absent ⇒ the tool is NOT
   * registered (default-OFF, byte-identical for every legacy caller — RFC
   * §1.2). Top-level (not nested) so future consumers (mid-turn cost
   * surfacing, post-turn telemetry exporter) can read this slot directly.
   */
  budgetLedger?: BudgetLedger
  /**
   * ADR-0398 — Objective port slot (ADR-0394 substrate consumer wire).
   *
   * When set, `buildObjectiveBlock` (tier-1) registers the 3 LLM tools
   * `objective_set` / `objective_update` / `objective_get` bound to this
   * port so the agent can declare its own per-thread objective (goal /
   * success criteria / blockers / next actions / budget) and surface them
   * to the user. Absent ⇒ the 3 tools are NOT registered, the loop is
   * byte-identical for every legacy caller (RFC §1.2 default-OFF).
   *
   * Caller-wire (typically the composition root) constructs the port via
   * `createObjectiveStore()` (in-memory reference impl) — a future ADR
   * may add a persistent backing. Top-level (not nested) so future
   * consumers (compaction-preserve-objective, subagent-result attribution)
   * can read this slot directly.
   */
  readonly objective?: ObjectivePort
  /**
   * G1 (RFC jun-6-appgen-appshot) — host-wired appshot verify-loop slot. When
   * set, the per-session `buildAppshotBlock` (tier1) exposes `appshot_verify`
   * over this port. The composition root (`agent-config-assembler`) assembles
   * it ONLY when `QUANTA_APPSHOT=1` AND a real `BrowserPort` is wired (the slice
   * binds render/screenshot → that BrowserPort, verify → the judge `llm`,
   * scaffold → the jailed writer). Absent ⇒ no tool (byte-identical default-OFF).
   * Caller-override-safe; a pre-set slot is preserved. */
  appshot?: AppshotSlot
  /**
   * C1 — the SHARED per-session artifact registry (Canvas store), minted ONCE at
   * the composition root (`buildBaseFromArgs`) when `QUANTA_ARTIFACT_STORE=1` and
   * threaded here so the assembler can reuse the SAME instance as the appshot
   * artifactSink — the final scaffold registers into the very registry the
   * `artifact_*` tools read. Duck-typed to the single `register` method appshot
   * needs (the `@/artifact` `ArtifactRegistry` matches structurally). Absent ⇒
   * slot omitted (byte-identical). */
  readonly artifactRegistry?: AppshotArtifactSink
  /**
   * ADR-0415 — Run Ledger port slot (ADR-0395 substrate consumer wire).
   *
   * When set, the composition-root observability wire (ADR-0406) injects the
   * shared `RunLedgerPort` here so surface consumers (web-daemon
   * observability-emitter, future UI) + the run-ledger-attribution hook
   * subscriber (ADR-0401) read/write ONE unified long-running-work model.
   * Absent ⇒ no ledger; byte-identical default-OFF (RFC §1.2). Promoted from
   * the wire handle (Wave-3 deliberate hold) so it is reachable as a
   * first-class AgentConfig slot, not just inside the wire closure.
   */
  readonly runLedger?: RunLedgerPort
  /**
   * ADR-0415 — Approval state-machine port slot (ADR-0403 substrate consumer
   * wire). When set, the approval-gate wire (ADR-0407) records HITL approvals
   * here (attributing to Objective.blockers + Run Ledger.waiting) so the user
   * sees "why stopped / resume-from-step". Absent ⇒ legacy HITL passthrough,
   * byte-identical default-OFF. Promoted from the Wave-3 wire handle.
   */
  readonly approvalStateMachine?: ApprovalStateMachinePort
  /**
   * ADR-0124 conversation-checkpoint slot (helper-only). When set, callers
   * (apps/agent bootstrap, future `/rewind` slash command, future
   * auto-recovery hook) record/restore the `messages[]` history through this
   * store. Absent ⇒ no checkpoint store; the loop is byte-identical (no field
   * exists on AgentConfig in absent state under exactOptional). NOT consumed
   * by the loop itself today — slot exists for caller-side composition.
   */
  conversationCheckpoint?: { store: ConversationCheckpointStore }
  /**
   * OpenAI Responses continuation store (helper-only). Session composition
   * roots wire one lane-scoped store and execution-plane wrappers inject it
   * into `StreamInput.responsesContinuation` so continuation state remains
   * session-owned even when one boot-time `LLMPort` is shared across multiple
   * sessions. Absent ⇒ no explicit store; adapters may fall back to their
   * local default.
   */
  responsesContinuation?: { store: ResponsesContinuationStore }
  /**
   * ADR-0143 OS-sandbox port slot (helper-only). When set, future
   * shell/exec consumers wire through this port (Seatbelt on macOS / Landlock
   * on Linux). Absent ⇒ the consumers fall back to the legacy unsandboxed
   * spawner (byte-identical default-OFF). NOT consumed by the loop itself
   * today — slot exists for caller-side composition.
   */
  osSandbox?: OsSandbox
  /**
   * ADR-0139 LLM-provider port slot (helper-only). When set, future
   * factory-resolving consumers (BYO-key / Bedrock / Vertex / Foundry routes)
   * consult this port instead of the legacy `@/llm/factory` direct path.
   * Absent ⇒ the legacy path is byte-identical. NOT consumed by the loop
   * itself today — slot exists for caller-side composition.
   */
  llmProvider?: LlmProvider
  /**
   * ADR-0141 LSP sibling ports slot. Closed-port DI for the four LSP
   * sub-surfaces (code-action / format / signature-help / rename-apply). When
   * wired, future tools that need these surfaces consume them through this
   * slot. Absent ⇒ the consumers fall back to their null adapters or skip
   * registration entirely (byte-identical default-OFF). Caller-wire of these
   * tools to `extraTools` is a separate ADR; for now just the slot.
   */
  lspPorts?: {
    readonly codeAction?: CodeActionPort
    readonly format?: FormatPort
    readonly signatureHelp?: SignatureHelpPort
    readonly renameApply?: RenameApplyPort
  }
  /**
   * ADR-0159 retrieval-stack slot (composition-root wire). When set,
   * consumers downstream of the loop (memory recall via
   * `rankWithRetrievalStack`) may route their candidate lists through
   * the 3-stage retrieval funnel (BM25 → embedding → reranker).
   *
   * Default-OFF: absent ⇒ the loop is byte-identical for every legacy
   * caller (no consumer constructs the stack itself; the bridge functions
   * return identity behavior when this slot is undefined). The slot is
   * caller-side composition only — the agent loop NEVER reads it directly.
   *
   * The concrete builder lives at
   * `@/runner/assemble/retrieval.ts#buildRetrievalStackCore`. `RerankRegistry`
   * + `RerankPort` are owned by `@/retrieval` (leaf primitive slice — every
   * other slice may reach IN; the slice may NOT reach out, see ADR-0159
   * biome fence). Importing them here is the conventional direction.
   */
  retrievalStack?: {
    readonly registry: RerankRegistry
    readonly defaultReranker: RerankPort
    readonly embedding?: EmbeddingPort
    readonly commitEmbedder?: CommitEmbedder
  }
  /**
   * ADR-0278 search-pipeline slot (composition-root wire). Sibling of
   * {@link retrievalStack}: where `retrievalStack` exposes the reranker
   * registry for memory recall and localize, this slot exposes a
   * populated `SearchPipeline` for the `search_codebase` tool and any
   * future caller that wants pipeline-shaped search.
   *
   * Surface-default product behavior now wires lexical repo search on the
   * main agent/CLI surfaces and upgrades to hybrid when `QUANTA_INDEX=on`;
   * `QUANTA_PIPELINE=none` is the explicit kill-switch. The slot remains
   * helper-only — the loop / dispatch still never reads it directly.
   *
   * The slot is caller-side composition only — the agent loop NEVER
   * reads it directly. See `src/apps/agent/index.ts` for the wire and
   * ADR-0278 for the closed truth table.
   */
  searchPipeline?: import("@/retrieval/pipeline").SearchPipeline
  /**
   * ADR-0200 stream idle/total timeout watchdog slot. When BOTH this and
   * {@link streamTimeoutPolicy} are set, the loop wraps each LLM stream
   * with `streamWatchdog.wrap(src, policy, signal)` so hung providers
   * surface as a typed `StreamIdleError`/`StreamTotalError`/`StreamAbortError`
   * instead of parking the turn forever.
   *
   * Default-OFF: either slot absent ⇒ the loop yields the raw source
   * verbatim (byte-identical for every legacy caller). The composition
   * root MAY default this to `noOpWatchdog()` so dynamic enablement is a
   * pure policy swap; the loop tolerates either no-op-with-no-policy or
   * undefined.
   */
  streamWatchdog?: import("../stream-timeout").StreamWatchdog
  /**
   * ADR-0200 stream timeout policy. Holds `idleMs` / `totalMs` / `action`
   * and (optionally) a `SnoozeController` instance owned by the CLI repl.
   * Consumed only when {@link streamWatchdog} is also set.
   */
  streamTimeoutPolicy?: import("../stream-timeout").TimeoutPolicy
  /**
   * ADR-0203 wire (helper-only slot) — typed error classifier + 5-arm retry
   * router. Caller-side composition: when set, the CLI/host wires the slot
   * into `RetryingLLM({ errorRouting: cfg.errorRouting, ... })` so the
   * retry decorator may shortcut on `abort`/`hitl`. Absent ⇒ no consumer
   * touches it (byte-identical default-OFF — RFC §1.2). The loop itself
   * never reads this slot directly.
   */
  errorRouting?: {
    readonly classifier: import("../error-routing").ErrorClassifier
    readonly router: import("../error-routing").RetryRouter
  }
  /**
   * ADR-0206 wire (helper-only slot) — per-thread dynamic tool registry.
   * Caller-side composition: when set, the dispatch/composition root may
   * call `composeTools(globalRegistryTools, registry.list(threadId).map(...))`
   * to merge per-thread MCP tools on top of the global registry. Absent ⇒
   * no consumer reaches into this slot (byte-identical default-OFF — RFC
   * §1.2). The loop never reads this slot directly today.
   */
  threadToolRegistry?: import("../thread-tools").ThreadToolRegistry
  /**
   * ADR-0207 wire (helper-only slot) — per-thread Stage-1 distillation
   * usage/selection cache. SIBLING to `memoryConsolidator.store` (which
   * owns the watermark/promotion surface); this slot owns the
   * `get/put/touch/markSelectedForPhase2/list/prune` surface so future
   * phase1-completion hooks can mirror the entry and Phase 2 candidate
   * selectors can read across runs. Absent ⇒ no consumer touches it
   * (byte-identical default-OFF — RFC §1.2). The loop never reads this
   * slot directly today.
   */
  stage1OutputsStore?: import("../../memory/stage1-store").Stage1OutputsStore
  /**
   * ADR-0235 — per-turn shell-snapshot wire (caller-side composition).
   * Sibling to ADR-0204 (the snapshot primitive). When set, the loop
   * captures a snapshot at turn-start (`captureAtTurnStart`, default `true`)
   * and threads the resulting handle into `ToolContext.shellSnapshot` so
   * shell-class tools (`bash` today) forward it to `runShell` — which
   * augments the spawned argv to `source <path>; <user-cmd>`. The same
   * `snapshotPath` is reused for every `runShell` call within that turn.
   *
   * Default-OFF: absent ⇒ no capture, `ctx.shellSnapshot` omitted, every
   * `runShell` call byte-identical to the pre-ADR path (RFC §1.2). When
   * present but `port.capture` fails (shell-missing / capture-timeout /
   * write-failed / empty-capture / invalid-id), the loop continues WITHOUT
   * a snapshot for that turn and emits a single `error` AgentEvent — the
   * loop is no-throw at this boundary.
   *
   * Knobs:
   *  - `port`: REQUIRED. The {@link ShellSnapshotPort} (build via
   *    `createShellSnapshotPort(spawner)` at the composition root). Tests
   *    inject the headless stub.
   *  - `shell` (default `"auto"`): which adapter to use. `"auto"` reads
   *    `$SHELL` and picks `"zsh"` when the basename is `zsh`, else `"bash"`
   *    (every other supported shell falls through to bash since the bash
   *    adapter handles the broadest POSIX surface). Explicit `"zsh"` /
   *    `"bash"` force the adapter.
   *  - `captureAtTurnStart` (default `true`): when `true`, capture runs at
   *    the TOP of every turn (after `steerBarrier`, before `runTurn`). When
   *    `false`, capture runs ONCE at session start and the same handle is
   *    reused for every turn (operator decision — explicit opt-in to less
   *    work + stale-env risk).
   *  - `cleanupOlderThanMs` (default `864e5 * 10` = 10 days): how often to
   *    prune old snapshot files. Pruned ONCE at session start
   *    (best-effort; failures emit a single `error` AgentEvent).
   *  - `maxSizeBytes` (default `100 * 1024 * 1024` = 100MB): SOFT cap for
   *    the snapshot directory; consulted at session-start prune.
   */
  shellSnapshot?: {
    readonly port: import("@/runtime/shell-snapshot").ShellSnapshotPort
    readonly shell?: "auto" | "zsh" | "bash"
    readonly captureAtTurnStart?: boolean
    readonly cleanupOlderThanMs?: number
    readonly maxSizeBytes?: number
    /** Resolved SHELL env literal — composition root passes `process.env.SHELL`.
     *  Slice invariant (ADR-0144): no process.env in @/agent. Absent ⇒ "bash" fallback. */
    readonly shellEnv?: string
  }
  /**
   * ADR-0235 (internal slot) — populated by the loop at session start when
   * `shellSnapshot` is wired. Dispatch reads `currentSeam()` here to thread
   * the active restore handle into `ToolContext.shellSnapshot`. Mutable on
   * `cfg` (not the caller's `config`) because the loop rebinds a fresh
   * session per `runAgent` invocation; the caller's object is never touched
   * (see `runAgentInner`'s `cfg` copy discipline). Public-typed so the
   * dispatch module (separate file, no module-private channel) can read it.
   */
  shellSnapshotSession?: import("../shell-snapshot-session").ShellSnapshotSession
  /**
   * DIP (H1, jul-4 hexagonal audit F3) — the tool-DISPATCH port. `dispatchTool` (gate + execute +
   * permission + hooks) was the ONLY driven collaborator reached by a HARD import while `llm`/
   * `stream`/`registry` were inverted; this injects it. Absent ⇒ the dispatch call site binds the
   * default `dispatchTool` (byte-identical). Inline import-type to avoid a top-of-file cycle
   * (dispatch → AgentConfig → this file).
   */
  dispatchPort?: import("../dispatch").DispatchPort
}
