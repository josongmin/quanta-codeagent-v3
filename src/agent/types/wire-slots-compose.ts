export interface WireSlotsComposeConfig {
  /**
   * ADR-0236 — composition-root mega-wire (this slot). Mode-typed delegation
   * port (ADR-0218). When set, the subagent fork path may route mode-typed
   * delegations through this port (parent → child mode-typed subtask,
   * isolated context, boomerang result). Caller-side composition only —
   * the loop never reads it directly today; surfaces (Agent tool, future
   * `/delegate` slash) opt in by reading this slot. Absent ⇒ slot omitted,
   * byte-identical legacy (RFC §1.2 default-OFF).
   */
  delegation?: {
    readonly delegator: import("../subagent-typed").DelegationPort
    readonly modes?: ReadonlyArray<import("../subagent-typed").AgentMode>
  }
  /**
   * ADR-0236 / ADR-0219 — Focus Chain auto-reinject (Cline absorption). When
   * set, the loop advances the tracker once per turn (after steerBarrier /
   * conversation-action poll) and drains `getInjection()` into the per-turn
   * working memory tail so the next LLM call sees the rendered todo list.
   * Absent ⇒ no allocation, no `tickTurn`, no injection — byte-identical
   * legacy (RFC §1.2). `reinjectEveryN` is a documentation slot mirroring
   * what the host passed when constructing the tracker.
   */
  focusChain?: {
    readonly tracker: import("../focus-chain").FocusChainPort
    readonly reinjectEveryN?: number
  }
  /**
   * ADR-0236 / ADR-0226 — rich fork-session port (composition-root wire).
   * Sibling to the base {@link fork} slot (ADR-0201 sync `SessionForker`):
   * this slot exposes the richer async port (`Promise<Result>` + signal
   * cancel + optional branch label + shadow-ODB tag). Caller-side; loop
   * does not consume directly. Absent ⇒ slot omitted, byte-identical.
   */
  forkSession?: { readonly forker: import("../fork-session").ForkSessionPort }
  /**
   * ADR-0236 / ADR-0224 — text-inbox sink (composition-root wire). Caller-
   * side slot — the surface (REPL / Tauri / Web) drains through its own
   * `PromptSource.next()` and concatenates to the next user-turn body. The
   * slot exists so the composition root can publish the inbox handle to
   * other subsystems (e.g. a `/web` slash enqueueing for a different
   * surface). The loop NEVER drains this slot directly. Absent ⇒ omitted.
   */
  textInbox?: { readonly sink: import("../surface-ports").TextInbox }
  /**
   * ADR-0236 / ADR-0225 — plan-edit port (composition-root wire). Caller-
   * side; `/edit-plan` slash reads it via `SlashContext.planEdit`. Loop
   * does not consume. Absent ⇒ slash prints "not wired in this surface".
   */
  planEdit?: { readonly port: import("../surface-ports").PlanEditPort }
  /**
   * ADR-0236 / ADR-0225 — composer-edit port (composition-root wire).
   * Sibling to {@link planEdit}: drives `/edit-message`. Default-OFF.
   */
  composerEdit?: { readonly port: import("../surface-ports").ComposerEditPort }
  /**
   * ADR-0236 / ADR-0212 — sticky-model-per-mode store (composition-root
   * wire). Caller-side slot consumed by the model-resolver (`/status` may
   * surface the current preference; future `--sticky-model` CLI flag
   * activates an fs-backed store at composition root). Absent ⇒ slot
   * omitted; the global default model wins for every mode.
   */
  /**
   * MR-02 (final) — THE model-routing owner for this session.
   *
   * The loop reads model decisions through `modelRoutingFor(config)`, which
   * returns THIS when present. The three slots below (`stickyModelStore` +
   * `modelCandidates`) remain the compatibility shape for hosts and tests that
   * wire the pieces directly; `from-config.ts` builds an authority over them in
   * ONE place so the turn path still has exactly one implementation of the rules.
   */
  modelRouting?: import("../model-routing").ModelRoutingAuthority
  stickyModelStore?: {
    readonly store: import("../sticky-model").StickyModelStore
    /** aug-28 — the PROVIDER half of the sticky key (`<provider>:<mode>`), supplied
     *  by the surface that owns the store. Kept HERE rather than derived from
     *  `config.llm.provider` so the write key and the read key have ONE authority:
     *  a port whose provider field is absent would otherwise read a different key
     *  than the surface wrote, and the pick would silently not apply. */
    readonly provider?: string
    /** aug-28 — SYNC "what the next turn will run", published by the surface that
     *  owns the store (see `@/agent/effective-model`). Absent ⇒ consumers report
     *  the boot model, exactly as before. */
    readonly effectiveModel?: () => string | undefined
  }
  /**
   * ADR-0236 / ADR-0213 — tool-profile preset resolver (composition-root
   * wire). Caller-side slot — the admissibility gate (Wave-B follow-up)
   * may compose the profile's per-tool admissibility on top of the legacy
   * permission stack; `/profile` slash mutates the active name in place
   * via the host-supplied callback in `SlashContext.profile`. `defaultName`
   * is the initial profile applied at session start. Absent ⇒ no profile
   * layer, byte-identical.
   */
  toolProfile?: {
    readonly resolver: import("../tool-profile").ToolProfileResolver
    readonly defaultName?: import("../tool-profile").ToolProfileName
    /** Live active profile accessor. When present, the admissibility gate
     *  re-reads it per call so `/profile` mutations apply on the next turn
     *  without reassembling the session. Absent ⇒ `defaultName` remains the
     *  fixed active profile for the whole run. */
    readonly activeName?: () => import("../tool-profile").ToolProfileName
  }
  /**
   * ADR-0236 / ADR-0211 — system-prompt mode-variant registry (composition-
   * root wire). The composition root threads the variant for the active
   * mode through `buildSystemPrompt({ identity: variant.identity })` BEFORE
   * constructing the session. Loop never re-reads this slot mid-session
   * for the cached system prompt.
   *
   * ADR-0239 — when `perTurnReminderEnabled` is `true`, the loop ALSO
   * splices the variant's identity lines into the per-turn working memory
   * as a trailing `<system-reminder>` user message — Codex `ARCHITECT_NOTICE`
   * / `EDITOR_NOTICE` pattern. The reminder is independent from (and rides
   * AFTER) the existing prompt.ts `modeNotice` rendering: that one fires
   * unconditionally on architect/editor/plan/review/audit modes (and ships
   * the FULL multi-line notice from prompt.ts); this slice's per-turn
   * reminder rides the variant's IDENTITY lines (the one-sentence
   * `DEFAULT_MODE_VARIANTS[mode]`) so a host that overrode the registry's
   * identity gets THAT line splicea every turn, keeping the variant and the
   * reminder consistent. Default-OFF when explicitly `false`;
   * mode-conditional auto-ON when undefined (architect | editor only — the
   * two modes that benefit most from the per-turn nudge; legacy plan /
   * review / audit already get the fuller modeNotice and a 2nd reminder
   * would dilute it).
   */
  identityModeVariant?: {
    readonly registry: import("../system-prompt").SystemPromptVariantRegistry
    /** ADR-0239 — per-turn reminder splice opt-in. `true` ⇒ splice every
     *  turn for the active mode (regardless of mode). `false` ⇒ never
     *  splice. `undefined` ⇒ mode-conditional auto-ON for
     *  `architect | editor`; off for every other mode (matches the
     *  prompt.ts modeNotice cadence — architect/editor get the per-turn
     *  identity reminder; the other modes already ship a full modeNotice
     *  every turn). */
    readonly perTurnReminderEnabled?: boolean
    /** Live active mode accessor. When present, both the per-turn reminder
     *  splice and any surface-owned system-prompt source re-read the current
     *  mode each turn so `/identity` mutations apply immediately on the next
     *  turn. Absent ⇒ callers fall back to the loop's own effective mode. */
    readonly activeMode?: () => import("../system-prompt").ModeVariantKey
  }
  /**
   * ADR-0236 / ADR-0203 / ADR-0240 — inline-trigger watcher (composition-
   * root wire).
   *
   * Caller-side: the composition root may bind the watcher at session start
   * via {@link import("@/skill/playbook").startPlaybookAutoDispatch} and
   * stop it at session end (`.stop()`). Loop does NOT consume directly.
   *
   * Pre-ADR-0240 contract (just `{ watcher }`): the composition root owned
   * registry iteration + sink wiring. Kept for byte-identical back-compat.
   *
   * ADR-0240 additions (`enabled` / `watchGlobs` / `debounceMs` / `registry`
   * / `planQueueSink`): when the host wires the new fields, the orchestrator
   * does the iteration + dispatch. Default-OFF: absent or `enabled !== true`
   * ⇒ no watcher started.
   *
   * The two paths are compatible (the host MAY supply just `watcher` and
   * call the orchestrator itself; or supply the full block and let
   * `startPlaybookAutoDispatch` wire everything).
   */
  playbookTrigger?: {
    readonly watcher: import("@/skill/playbook").InlineTriggerWatcherPort
    /** ADR-0240 master switch — default `false` (opt-in). When `true`, the
     *  host's `startPlaybookAutoDispatch` call wires the registry + sink. */
    readonly enabled?: boolean
    /** ADR-0240 — registered playbooks the orchestrator iterates. Each
     *  must carry a non-empty `trigger` to actually wire. */
    readonly registry?: import("@/skill/playbook").PlaybookRegistry
    /** ADR-0240 — sink the dispatcher hands the `/play <name>` follow-up
     *  to. Absent ⇒ fires are detected but NOT enqueued. */
    readonly planQueueSink?: import("@/skill/playbook").PlaybookPlanQueueSink
    /** ADR-0240 — per-watcher debounce window (ms). Default 200ms when
     *  omitted (matches the watcher's intrinsic default). */
    readonly debounceMs?: number
    /** ADR-0240 — restricting glob list applied IN ADDITION to each
     *  registration's `trigger.watchGlob`. When set, only paths matching
     *  ANY of these globs AND the per-playbook glob fire. Default
     *  `["**" + "/*"]` (no extra restriction). */
    readonly watchGlobs?: readonly string[]
  }
  /**
   * ADR-0236 / ADR-0215 — RRULE automation engine (composition-root wire).
   * Caller-side: a host's background tick may drain due automations via
   * `tickScheduler({ engine, now, handler })`. Loop does not consume
   * directly. Absent ⇒ scheduler runs without automation drain.
   *
   * ADR-0239 — when `handler` is also wired AND `tickIntervalMs > 0`, the
   * loop starts a `setInterval`-backed background drain at session-start and
   * stops it in `finish`. Each tick consults `engine.next(now)` and fires
   * the soonest-due automation via `tickScheduler`. Default-OFF byte-
   * identical: absent `handler` OR `tickIntervalMs` ⇒ no timer is armed
   * (RFC §1.2). `handler` MAY be sync or async; throws are absorbed by
   * `tickScheduler` and surface as `kind: "errored"` outcomes via the
   * optional `onTick` observer.
   *
   * ALBB-14 — the ticker is now armed by the SHARED session lifecycle
   * (`maybeStartAutomationTicker` in session-bootstrap), so EVERY surface that
   * assembles an `AgentConfig` (web-daemon / headless, not just the CLI REPL)
   * delivers scheduled fires. A surface arming the ticker MUST supply a REAL
   * `handler` (an `AgentLoopPort.enqueueUserMessage` for its live loop). The
   * base composition-root handler (`agent-arg-builder.ts#resolveAutomation`) is
   * a FAIL-LOUD stub: it warns AND increments the
   * `automation.fires_dropped_no_handler` metric counter on each invocation, so
   * a surface that arms the ticker without overriding the handler surfaces the
   * delivery gap in metrics instead of silently dropping fires.
   */
  automationEngine?: {
    readonly engine: import("@/scheduler/automation-engine").AutomationEnginePort
    /** ADR-0239 — host-supplied fire callback. When set with a positive
     *  `tickIntervalMs`, the loop arms a setInterval that calls
     *  `tickScheduler({ engine, now: Date.now(), handler })` every interval.
     *  Absent ⇒ no timer (the slot stays helper-only, matching the original
     *  ADR-0215 default-OFF posture). */
    readonly handler?: import("@/scheduler/automation-engine").AutomationHandler
    /** ADR-0239 — tick cadence in ms. Absent / 0 / negative / NaN ⇒ no
     *  timer (the loop short-circuits at the optional-chain). The loop has
     *  NO baked-in default; callers must opt in explicitly. */
    readonly tickIntervalMs?: number
    /** ADR-0239 — optional observer fired AFTER each `tickScheduler` returns
     *  (idle / fired / errored / engine-error). Tests and ops surfaces wire
     *  this to count ticks / forward to OTel / surface errored automations
     *  to an inbox UI. Throws are absorbed (the timer keeps ticking). */
    readonly onTick?: (outcome: import("@/scheduler/automation-engine").TickOutcome) => void
    /** ADR-0239 — injected clock for tests + replay. Default `Date.now`. */
    readonly now?: () => number
    /** ADR-0453 — OPTIONAL autorun-eligibility gate threaded into
     *  `tickScheduler` (the scheduler-path 4th guard). Consulted BEFORE the
     *  claim; a not-eligible verdict skips the fire (no claim, no anchor
     *  advance). Absent ⇒ ticks byte-identical. Built at the composition root
     *  over the pure `evaluateAutorunEligibility` (closed `QUANTA_AUTORUN_POLICY`
     *  knob). */
    readonly eligibility?: () => import("@/scheduler/automation-engine").TickEligibilityVerdict
  }
  /**
   * ADR-0234 — git-directive emit wire (turn-scoped collector pattern).
   * Closes the gap between ADR-0221 (phase-guarded emitter) and the
   * mutating git tools (`git_commit`, `git_branch_switch`, future
   * `gh_pr_create`). Tools call `collector.record(directive)` during
   * their intermediate-phase execution; the loop calls `collector.flush()`
   * at the turn boundary, draining each entry through the wired emitter
   * with `phase: "final-answer"` — the natural moment that satisfies the
   * ADR-0221 phase invariant without forcing call sites to lie about
   * phase.
   *
   * Default-OFF: absent or `enabled !== true` ⇒ no collector built, no
   * emit wire installed, the loop is byte-identical to the pre-ADR-0234
   * path (RFC §1.2). When `enabled: true` the loop wires the collector
   * into the per-session `git_commit` / `git_branch_switch` factories
   * (via `gitTools({ gitDirectiveCollector })` at the composition root)
   * AND calls `flush()` once per turn end (after `gitObservability`
   * endTurn, before `emitWorkMetrics` — same "post-turn-body" boundary).
   *
   * `sink`: where the emitter writes the wire line. `"stdout"` (default)
   * matches the Codex protocol (UI consumers grep `^::git-` from the
   * agent's stdout); `"stderr"` is for hosts that frame structured
   * channels separately; the inline function form lets tests + Tauri
   * hosts intercept without process I/O.
   *
   * `includeIntermediate`: when `true`, the collector emits at record
   * time AS WELL AS at flush time (for live-progress surfaces that need
   * mid-turn visibility). Default `false` — strict final-answer-only
   * discipline.
   *
   * `emitter`: optional pre-built emitter override (test-injection seam,
   * mirrors `dedupGate`/`gitObservability.session`). When set, `sink`
   * is ignored (the caller supplied a complete port).
   *
   * `collector`: optional pre-built collector override (test-injection
   * seam). When set, the loop uses this collector verbatim instead of
   * constructing one — the same surface the tool wire passes to git
   * tools. `emitter` is ignored in this branch (the collector already
   * owns its emitter).
   */
  gitDirectiveEmit?: {
    readonly enabled: boolean
    readonly sink?: "stdout" | "stderr" | ((line: string) => void)
    readonly includeIntermediate?: boolean
    readonly emitter?: import("../../git/directive-emit").DirectiveEmitterPort
    readonly collector?: import("../../git/directive-emit").GitDirectiveCollector
  }

  // ─── ADR-0327 Codex-r2 wire seam ──────────────────────────────────────────
  //
  // Three optional slots that the loop forwards to `buildTurnContext` when
  // present. ALL ABSENT ⇒ loop is byte-identical to pre-ADR-0327. The slots
  // are intentionally narrow function/port shapes — caller (composition
  // root / session setup) constructs and threads them, holding any cursor
  // / detector / store state in its own closure. Default-OFF (RFC §1.2).

  /** ADR-0326 — session-scoped system-prompt cache port. When set together
   *  with {@link systemPromptCacheKey}, the loop forwards both to
   *  `buildTurnContext` so the default `buildSystemPrompt()` factory is
   *  memoized per key. `system` (caller-provided prefix) bypasses the cache.
   *  Absent ⇒ per-turn rebuild (byte-identical). */
  systemPromptCache?: import("@/llm/system-prompt-cache").SystemPromptCachePort

  /** ADR-0326 — opaque session key for {@link systemPromptCache}. When the
   *  cache is set but the key is absent (or vice-versa), the cache stays
   *  DISENGAGED (legacy build path) — both slots are required to wire. */
  systemPromptCacheKey?: import("@/llm/system-prompt-cache").SystemPromptCacheKey

  /** ADR-0321 — per-turn context-change events producer. Called once per
   *  `buildTurnContext` build. The producer owns its own cursor / detector /
   *  store state (closure pattern); the loop forwards the returned array
   *  verbatim to `contextChangeEvents`. NO-THROW invariant: a thrown error
   *  is logged and converted to an empty array so a misconfigured producer
   *  cannot break the turn. Absent / empty ⇒ no splice (byte-identical). */
  contextEventsForTurn?: () => readonly import("@/agent/context-change").ContextEvent[]

  /** ADR-0325 / ADR-0418 — mention-injection runner. When set, the loop
   *  extracts the latest user-role text content, `await`s the runner, and
   *  forwards the returned messages to `mentionInjectionMessages`. ASYNC
   *  (ADR-0418 supersedes ADR-0325's sync shape) so `@file` / `@symbol`
   *  resolvers can do I/O. NO-THROW invariant: a thrown / rejected runner is
   *  converted to `[]`. Absent ⇒ no parse, no injection (byte-identical). */
  mentionInjector?: (userInputText: string) => Promise<readonly import("@/llm").Message[]>

  /** ADR-0418 — declarative DI knobs for the `@file` / `@symbol` mention
   *  resolvers. A composition root reads `QUANTA_MENTION_FILE*` /
   *  `QUANTA_MENTION_SYMBOL*` env into this bag (or a host injects it
   *  directly) and threads it into `createCompositeMentionResolver`. This is
   *  the DATA shape only — the wire from this bag to a built `mentionInjector`
   *  is the composition root's job. Absent ⇒ file/symbol mentions resolve to
   *  `null` (skipped), byte-identical to the legacy 3-kind path. */
  mentionInjection?: {
    /** Pre-built `@file` resolver (e.g. from `createFileResolver`). */
    readonly fileResolver?: (target: string) => Promise<{ readonly bodyText: string } | null>
    /** Pre-built `@symbol` resolver (e.g. from `createSymbolResolver`). */
    readonly symbolResolver?: (target: string) => Promise<{ readonly bodyText: string } | null>
    /** File read cap before truncation (default 256 KiB). */
    readonly maxFileBytes?: number
    /** Fraction of the cap reserved for the file tail (0..1, default 0). */
    readonly tailRatio?: number
    /** `@symbol` lookup strategy: `lsp` | `semantic` | `auto` (default auto). */
    readonly symbolPriority?: "lsp" | "semantic" | "auto"
    /** Per-strategy `@symbol` lookup timeout in ms (default 5000). */
    readonly symbolTimeoutMs?: number
  }

  /** ADR-0324 — typed compaction-event emitter. Called when a proactive
   *  (top-of-turn `maybeCompact`) compaction succeeds. The callback is
   *  expected to push the event onto a `TypedHistoryEventStore` (ADR-0320)
   *  so consumers (typically a context-events producer fed by the SAME
   *  store) can surface compaction as a typed-history narrative event.
   *  NO-THROW: callback errors are swallowed so an emitter glitch cannot
   *  break the turn. Absent ⇒ no emit (byte-identical). */
  compactionEventEmit?: (event: import("@/memory/typed-event").CompactionEventVariant) => void

  /** ADR-0340 — plugin activation closure. When set, the loop / surface
   *  hook may call `activatePlugins(parsedMentions, { turnId })` once per
   *  turn after `parseMentions` to spawn each plugin's declared MCP
   *  servers (ADR-0338) and resolve its declared skills (ADR-0339). The
   *  returned `AggregatedActivation.resolvedSkills` is intended to be
   *  unioned into `TurnContextInput.activeSkills` via
   *  `unionActiveSkills`; the returned `handles` are session-scoped
   *  (the composition root retains the `PluginMcpRegistry` lifetime and
   *  calls `shutdownAll()` on session end).
   *
   *  NO-THROW: thrown errors degrade to `{ handles: [], resolvedSkills: [] }`
   *  so a misconfigured plugin handler cannot break the turn. Absent ⇒
   *  no activation, no spawn, byte-identical legacy behaviour. */
  activatePlugins?: (
    mentions: readonly import("@/agent/mention-injection").ParsedMention[],
    opts?: { readonly turnId?: string },
  ) => Promise<import("@/agent/plugin-activation-handler").AggregatedActivation>
  /** jun-6 (RFC jun-6-ai-session-title) — fire-and-forget AI session titler.
   *  Duck-typed (NO `@/runner` import) so `@/agent` stays free of the
   *  composition root. When set (the root built it because
   *  `QUANTA_SESSION_AUTO_TITLE` is on AND `QUANTA_SESSION_TITLE_MODEL` resolved
   *  a cheap `LLMPort`), `runSessionStartSequence` calls
   *  `maybeTitle(sessionId, firstPrompt)` ONCE on the first turn AFTER the
   *  `session_start` emit, when the first prompt is non-empty. The call returns
   *  IMMEDIATELY (the work runs on a detached promise the turn never awaits; all
   *  failures swallowed; a human rename is never clobbered). Absent ⇒ the branch
   *  is dead (byte-identical default-OFF, RFC §1.2). */
  autoTitlePort?: { maybeTitle(sessionId: string, firstPrompt: string): void }
}
