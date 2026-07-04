# Quanta Agent Loop — Full Decision Map (for external review)

**Scope.** Every decision point in one agent turn cycle: session entry → per-turn
preparation → prompt assembly → stream + recovery → tool dispatch → permission →
plan-mode → stop/resume thresholds → finish. Each row is `condition → decision`
with a `file:line` anchor so a reviewer can diff against source.

**Method.** Derived by reading the current working tree (includes uncommitted
in-flight changes on the plan-entry / sdk-embed workstreams). No inference — every
claim has a source anchor. Line numbers are working-tree-relative and may shift by a
few lines; the reviewer should treat the symbol name as authoritative and the line as
a hint. Items that were traced to an injected interface (implementation in a separate
slice) are marked **[boundary]**, not omitted.

**Default-OFF invariant.** Nearly every lever below is gated by a config field being
present (`cfg.X !== undefined`) or a `QUANTA_*` env flag. When absent, the branch does
not execute and the behavior is byte-identical to the pre-lever baseline. Such rows are
marked **(OFF⇒noop)**.

---

## 0. Top-level shape

```
runAgentInner (entry.ts:68)
  ├─ createRunAgentContext            session-bootstrap.ts:100   (wire refs, ctx.finish closure)
  ├─ runSessionStartSequence          session-lifecycle.ts:284   → continue | aborted{hook_deny|interrupt}
  │     aborted ─► ctx.finish("aborted", 0, interruptedCategory(cause))   entry.ts:82
  ├─ runAgentTurnLoop(ctx)            turn-loop.ts:124           (loop owns ALL finishes → AgentOutcome)
  └─ finally: diagnosticsHook.dispose + ctx.disposeResources    entry.ts:86  (D12 idempotent)
```

`runAgentTurnLoop` returns a fully-built `AgentOutcome`; `entry.ts:85` awaits it
unchanged (max_turns is handled inside the loop, not the caller — see §2/§10).

---

## 1. Session boundary

### 1.1 runSessionStartSequence — pre-loop gate (session-lifecycle.ts:284–317)

| condition | decision | anchor |
|---|---|---|
| UserPromptSubmit / start hook returns DENY | `{status:"aborted", cause:"hook_deny"}` | session-lifecycle.ts:306 |
| interrupt control-op present (checked **before** snapshot restore, fail-closed) | `{status:"aborted", cause:"interrupt"}` | session-lifecycle.ts:309–311 |
| otherwise | `{status:"continue"}` (after snapshot restore: follow-up queue, plan) | session-lifecycle.ts:316 |

Abort mapping at the caller: `hook_deny → interruptedCategory("system")`,
`interrupt → interruptedCategory("user")`, both `ctx.finish("aborted", 0, …)` (entry.ts:78–84).

### 1.2 finishAgentSession / buildFinalAgentOutcome (session-lifecycle.ts:188–266)

`ctx.finish(reason, turns, stopCategory?, refusal?)` resolves to `finishAgentSession`, which:
1. updates `activeTurnRef` (230–235), 2. `persistFinalMessages` (237–245),
3. `cleanupFinishedSession` dispose + snapshot save (246–250), 4. `recorder.stopReason` (251),
5. hooks emit (252–254), 6. `stream.emit("done")` (255), 7. returns `buildFinalAgentOutcome` (256–265).

`buildFinalAgentOutcome` (188–209) builds `{reason, turns, messages:[...copy]}` plus
present-only spreads: `stopCategory`, `memoryCitations` (len>0), `redactions` (size>0),
`refusal`, `turnTiming` (non-null).

---

## 2. Master turn cycle (turn-loop.ts:124–189)

```
for turn = 1 … maxTurns:                                              turn-loop.ts:125
  ① prepareTurnIteration → "continue" | "aborted"                    turn-iteration.ts:180
       "aborted" ─► finish("aborted", turn-1)                        turn-loop.ts:138
  ② DEFAULT_PRE_TURN_STOP_CONDITIONS (registry, OCP)                 stop-conditions.ts:89
       costPreflight: budgetMeter & (accum+inputFloor > maxCostUsd)
            ─► finish("budget_exhausted", turn-1)   ← L2 pre-call     stop-conditions.ts:54
  ③ executeTurnWithObservability → runTurn → TurnResult{kind}        turn-loop.ts:50, §5
       throw SessionApprovalRequired ─► span=aborted (HITL pause)    turn-loop.ts:82
  ④ resolveTurnLoopOutcome(TurnResult)                              turn-outcome.ts:52
       (routing table below)
  ⑤ shouldParkOnGate (completed turn + subagentTurnGate present)     turn-outcome.ts:117
       gate.wait()=settle ─► parkSettleFinish("aborted", system)     turn-loop.ts:164
       gate.wait()=woke/resume ─► continue (subagent resumes)        turn-loop.ts:163
  ⑥ DEFAULT_POST_CONTINUE_STOP_CONDITIONS (registry, OCP)           stop-conditions.ts:94
       ledgerHardBreach: budgetLedger.hardBreach()
            ─► finish("budget_exhausted", turn)   ← L4 post-turn      stop-conditions.ts:72
loop exhausted (turn>maxTurns):
  ─► finish("max_turns", maxTurns, completedCategory("max_turns"))    turn-loop.ts:188  [explicit, not undefined]
```

### 2.1 resolveTurnLoopOutcome routing (turn-outcome.ts:52–133)

| TurnResult.kind | plan-queue side-effect | decision | anchor |
|---|---|---|---|
| aborted | clearQueuedPlanLifecycle (drop) | finish("aborted", turn-1, user) | 49 |
| interrupted | clearQueued (drop) | **park**(turn-1) | 57 |
| error | clearQueued (drop) | finish("error", turn-1, classifyErrorReason) | 60 |
| refusal | clearQueued (drop) | finish("refusal", turn, rationale) | 69 |
| completed | clearQueued (drop) | finish("completed", turn)  ← meter ignored | 80 |
| tools | **applyQueuedPlanLifecycle** (apply) → then meter | see below | 93 |
| tools & budgetMeter.checkExhausted() | — | finish("budget_exhausted", turn) | 100 |
| tools & meter OK | wm.append(resultBlocks) | **"continue"** | 112 |

Plan queue: `applyQueuedPlanLifecycle` applies the queue's exit (dominates) or entry on
the **continue** path only; every terminal path calls `clearQueuedPlanLifecycle` to drop
the queued transitions unapplied (turn-outcome.ts:20–50). This moved **before** the
meter-exhaustion check (in-flight change).

---

## 3. Turn preparation + queued-input absorption (turn-iteration.ts:180–222)

```
prepareTurnIteration:
  signal.aborted ─► "aborted"                                         :194
  localizePhaseState.turn = turn-1 · budgetMeter.tick("turn") · steer barrier · active turn header
  syncQueuedTurnInputs:                                               :199 (control-poll.ts)
    pollFollowUpQueue   followUpQueue & !paused → user msg append     control-poll.ts:135   (OFF⇒noop)
    pollPeerInbox       peerInbox → peer mail append                  control-poll.ts:97    (OFF⇒noop)
    pollControlRequests QUANTA_CONTROL_REQUEST=1 → drain ≤64:         control-poll.ts:122   (OFF⇒noop)
                        set_model|set_permission_mode|set_thinking|get_context_usage (wm unchanged; ADR-0496)
    pollConversationAction:
        finish_aborted → interruptedTurnBuffer.capture → "aborted"    turn-iteration.ts:76
        injection      → wm.append(user msg) + effort observer        :85
        summarize      → compactNowOnDemand(force)                    :89
        rejected msg   → NO_REQUEUE(empty|too_large|interrupted)=drop  / else requeue next turn   control-poll.ts:47
  injectFocusChainMessage  planStore sync → tickTurn → getInjection → append (fail→emit error)   :153  (OFF⇒noop)
  injectWorkflowKeywordNudge · injectTurnBudgetReminder · stampTurn(dedup)
  shellSnapshotSession.snapshotForTurn(turn)                          :213  (OFF⇒noop)
  hooks.emit("turn_start") → promptHook → hookPromptPending.push       :217  (OFF⇒noop)
  ─► "continue"
```

`pollControlRequests` control types: set_model (modelAllowlist), set_permission_mode
(permissionModes allowlist, mandatory), set_thinking (thinkingLevels), get_context_usage
(snapshot). Drain ≤64/turn via `drainControlRequests` (control-request/apply.ts:77).

---

## 4. Prompt assembly

### 4.1 Path (context-assembler.ts:280 → prompt.ts)

```
prepareTurnContext (context-assembler.ts:280)
  resolveMemoryContext → maybeCompact/tokenBaselineBox → activate memory/skills/plugins
  assemble TurnContextInput (352–391): baseMessages, cwd, planMode, system, languageHint,
     activeLevers[in-flight], promptSurfaceProfile[in-flight], sessionCtx, memorySummaryMd[in-flight],
     memoryContext, repoRules, globRules, changedPaths, augmentedSkills, workingState,
     hookPromptInjects (373, only if len>0), taskBudget, brief, untrustedEnvelope
  buildTurnContext(turnInput)              prompt.ts:643
  injectRedactionBanner + injectIdeContext + emitPromptAssembled()
```

`hookPromptPending` is a session-scoped array: filled at turn_start (turn-iteration.ts:217),
copied+drained per turn (`turnInjects=[...pending]; pending.length=0`, same-turn-engine.ts:20–28),
passed as `hookPromptInjects`.

### 4.2 buildSystemPrompt — STATIC, cached prefix (prompt.ts:66, join at :84)

```
INTRO_LINES
+ identityLines(identity)          [ADR-0198]  absent⇒∅
+ personaLines(persona)            [ADR-0068]  default⇒∅
+ BODY_AFTER_PERSONA               Policy stack · Operating principles · Internal vocab ·
                                   Git posture · Evidence/Trust ladder · Budget · Tool failures · Tool routing
+ ── 3 INDEPENDENT AXES (jul-4) ──
  renderPostureBase(envPosture ?? "frozen")   frozen=CORE_RULES / owned=OWNED_RULES     prompt-rules/index.ts
  renderTaskRules(promptPack ?? "interactive") batch/headless/ci-bot; interactive/ide=∅  prompt-rules/index.ts
  renderVerifyStrategy(verifyStrategy)         reproduce-first / verify-after-edit / absent=∅  prompt-rules/verify-strategy.ts
+ BODY_AFTER_PROMPT_PACK           Vision · Honesty rail · Trust&inputs · Reporting shape · Verification report · Completion bar
```
Each slot absent ⇒ 0 lines ⇒ byte-identical. Composed once, `cache:true`.

### 4.3 buildTurnContext — messages[] + dynamic tail (prompt.ts:643–724)

```
system[]  = staticBase (cache:true)   single-block, OR 4-section preset when repoRules|sessionCtx|userAppend|memorySummaryMd present  (:664)
messages[] = [...baseMessages]
           + appendHookContextMessage         (hook.injectBeforeUser → separate <hook-context> user msg)  :709/:480
           + appendContextChangeMessages       [ADR-0321]
           + appendMentionInjectionMessages     [ADR-0325]
           + push {user, <system-reminder> embedUntrusted(dynamic)}                                        :726
dynamic (buildDynamicContext :560): date · cwd/git · mode notice · brief · directives · languageHint · env ·
           repoRules(if not in static) · glob rules · active skills · working-state · memory ·
           hook.injectAfterSystem ("## Hook context") · task-budget line
```
All dynamic content is wrapped by `embedUntrusted("system-reminder", …)` which defangs
inner `<system-reminder>` boundaries (injection defense). Static prefix never shifts →
provider prefix cache holds.

### 4.4 Resume (interrupted-turn.ts)

capture on abort: `captureInterruptedTurn(wm.snapshot(), reason, now)` → last user text +
all subsequent assistant text (skips tool_result carriers) (48–76). On `/resume`:
`handleResumeAction` → `buffer.take()` → `buildResumeMessage(turn)` (`"Resume the previously
interrupted task … The task was: … Your partial progress: …"`, 115–121) → injected as a normal
user message (turn-iteration.ts:87) → part of next turn's baseMessages.

---

## 5. One turn execution: stream + recovery

### 5.1 runTurn — inner retry loop, does NOT advance turn counter (same-turn-engine.ts:29–70)

| condition | decision | anchor |
|---|---|---|
| signal.aborted \| gate.wasInterrupted() | classifyTurnAbort → {aborted\|interrupted}, **return** | 30 |
| prepareTurnContext → compaction breaker.abort (thrash) | {error}, **return** | 55 |
| streamConsume → "aborted" in result | classifyTurnAbort, **return** | 57 |
| applyAction → step.done===true | **return** step.result | 69 |
| otherwise | **continue** (same turn) | 29 |

### 5.2 streamConsume return (stream-consume.ts:337–353)

`{message, stopReason, resultBlocks}` (assembled, 344) | `{aborted:true}` (338) |
`{error, message}` (350). `SessionApprovalRequired` is rethrown (HITL pause, not aborted, 352).
Text chunks emit to user; tool_use chunks collected; drives §6 streamingTurn.

### 5.3 Recovery decision (recovery.ts) + execution (recovery-executor.ts)

Call order in `resolveTurnAction` (recovery.ts:318–360): (1) if error → `decideOnStreamError`;
(2) refusal-fallback check; (3) `decideFromStopPolicy` (null⇒fallthrough); (4) `decideOnAssembled`.

| source | condition | decision | anchor |
|---|---|---|---|
| decideOnStreamError | retryable & streamRetries<3 | backoff → retry (else error) | recovery.ts:177 |
| decideOnStreamError | prompt_too_long | compact → retry | recovery.ts:185 |
| decideOnStreamError | non-retryable | error | recovery.ts:186 |
| decideOnAssembled | stop=refusal | {refusal} terminal | recovery.ts:206 |
| decideOnAssembled | stop=max_tokens & outputContinues<3 | nudge → retry (else truncation+proceed) | recovery.ts:210 |
| decideOnAssembled | stop=tool_use & !hasTools & malformedRetries<1 | nudge → retry (else error MALFORMED) | recovery.ts:230 |
| decideOnAssembled | empty turn & consecutiveEmpties<2 | nudge → retry (else error EMPTY_EXHAUSTED) | recovery.ts:258 |
| decideOnAssembled | not empty (hasTools\|text) | consecutiveEmpties=0 → proceed | recovery.ts:268 |
| decideFromStopPolicy | StopAction surface/abort/hitl | error (tagged) | recovery.ts:301 |
| resolveTurnAction | refusal & refusal.enabled & !toolUse & fallbacks<1 & forkBudgetOk | refusal_fallback (neutralize+re-prompt) → retry | recovery-executor.ts:70 |
| applyAction "proceed" | hasTools | {tools, message, resultBlocks} → §6 | recovery-executor.ts:273 |
| applyAction "proceed" | !hasTools | {completed} (+ closeout critic) | recovery-executor.ts:267 |

`RECOVERY_CAPS` (recovery.ts:23, frozen): streamRetries 3, outputContinues 3,
malformedRetries 1, consecutiveEmpties 2, refusalFallbacks 1. `freshRecovery()` resets per turn.

### 5.4 empty-stream circuit breaker (empty-stream-breaker.ts)

`DEFAULT_EMPTY_STREAM_BREAKER_K=2` (65), `DEFAULT_..._DECAY_MS=300_000` (80). K consecutive
content-less streams → throws FATAL LLMError (`"consecutive empty streams (no content)"`, 69),
cutting the continuation-retry loop. Env injected by caller via `maxConsecutiveEmpty` option
(112); breaker itself does not read env.

### 5.5 TurnResult.kind (types.ts:28–34)

`tools` (counter advances) | `completed` | `aborted` | `interrupted` | `error` | `refusal`.

---

## 6. Tool dispatch gate chain (dispatch.ts:353 → admissibility-gate.ts:74)

One tool_use reaching `tool.run`. Any gate deny short-circuits to a synthetic tool_result.

```
SEAM0 registry.has(name)=false ────────────────────► deny "unknown tool"       dispatch.ts:363
SEAM1 collab=plan & !isReadOnly ───────────────────► deny                       dispatch.ts:369
SEAM2 preflight consults (preflight-consults.ts):
   dedup-gate       gate.record().blocked ─► synthetic short-circuit            :38   (OFF⇒noop)
   localize-phase   Phase1 & MUTATING_TOOL_NAMES ─► deny                        :86   (OFF⇒noop)
   test-scope       protectTestPaths & mutating & test-file ─► deny             :122  (OFF⇒noop)
   dispatch-guard   check → allow | ask(deny) | deny                            :143  (OFF⇒noop)
SEAM3 admissibility-gate (11 sub-gates, ordered; each allow|deny|ask|fallthrough)   gates.ts:
   1  denyIfModeBlocked      mode∈{plan,review,audit} & mutating ─► deny         :120
   2  earlyHardDeny          bypassActive & HARD_DENY ─► deny(hard-deny)         :654   ⎫HARD_DENY
   3  runHandoffFloorGate    tier=hand-off-required ─► deny/hook                 :163   ⎪ evaluated
   4  runPermissionRequestHook  permission_request hook verdict                 :709   ⎪ twice
   5  runToolProfileGate     /profile overlay allow/deny/confirm                 :63    ⎪ (intentional,
   6  runPatternAutoPassGate granted patterns → preToolUse hook                 :138   ⎪  §7.5)
   7  runRulesDsl            prefix-rule allow/deny/ask/no_match                 :774   ⎪
   8  runHitlReviewGate      hitl.enabled/universalFloor: always-confirm=ask(pause) :176 ⎪
   9  runPermissionStackGate per-thread/per-host allow/deny/ask                 :211   ⎪
   10 runModePolicy          default/acceptEdits/bypass/auto(+classifier §7)     :561   ⎬ HARD_DENY recheck
   11 runPreToolUseHook      repo-local hook deny/updatedInput (last)            shared.ts:388 ⎭
SEAM2.5 consultOwnership     subagent FS boundary write ─► deny                 dispatch.ts:327 (after admissibility)
EXECUTE (dispatch.ts:257 executeWithStuckTracking → execute → registry.run)
POST    cap-reminder · repro-doubt steer · post_tool_use(_failure) hooks
```

### 6.1 EXECUTE~POST pipeline (dispatch.ts + dispatch/execute.ts)

```
capEnforcer.check(name,input)  prior hint IGNORED → reminder (increase_max_depth|raise_max_files|narrow_path)  cap-enforcer.ts:121 (OFF⇒noop)
executeWithStuckTracking       detector.tickToolStart → execute → finally tickToolEnd (≥2s ⇒ bg-poll)  dispatch.ts:257 (OFF⇒noop)
  execute():                                                                     dispatch/execute.ts:254
    LocalEffectChannel → registry.run(name,input,ctx,op)                         registry.ts:122
      (1)unknown (2)inputSchema.safeParse (3)tool.execute() AsyncIterable (4)progress fwd
      (5)enforceOutputSchema (6)toModelOutput (7)capToolOutput(spill)
    throw → {ok:false, output:errMsg}  ·  signal.aborted pre-check → {ok:false,"aborted"}   effect-channel.ts:153
    → decorateToolOutput(redact→wrap→deferred→lint→edit-repair) → shapeDispatchResult(+capEnforcer.record nextAction)
prependCapReminder (if reminder)                                                 dispatch.ts:460
applyReproDoubtSteer  hasEdited & !steered & runsSinceEdit≥stuckRuns → REPRO_DOUBT_STEER (1/streak)  repro-doubt-guard.ts:76 (OFF⇒noop)
emitPostToolUseHooks  post_tool_use(always) → !ok ⇒ post_tool_use_failure (try/catch)   dispatch.ts:490 (OFF⇒noop)
```

### 6.2 streamingTurn 4 phases + concurrency (streaming-dispatch.ts:571)

```
Phase1  per tool_use_end → scheduleResolvedCall:                                 :303
   isConcurrencySafe(name,input) false/throw → barrierEngaged=true, defer        :328
   barrierEngaged already → defer                                                :334
   isReadOnly(name) false → defer  (FIX6: agent also defers)                     :376
   both pass → slot.promise = dispatch(call) in-flight                           :384
Phase2  early-started settle  Promise.allSettled  (approval rethrown)            :603
Phase3  stopReason=refusal → deferred dropped / else drainDeferredSlots serial   :511,616
Phase4  collectResultBlocks in model-call order  rejected→dispatchFailedBlock    :541
```
Judgment SSOT (per-tool, registry.ts): `isReadOnly()` default false (:39);
`isConcurrencySafe()` unknown/parse-fail → false (:109); `isEarlyDispatchSafe()` falls back
to `isReadOnly` (:60), currently void (FIX6).

---

## 7. Permission internals

### 7.1 auto-mode evaluateAuto (policy.ts:347–415)

Order: 1 HARD_DENY(shell)→deny (362); 2 action.isReadOnly→allow (365);
3 precheckCircumvention: escalate→force ask / advisory→append prompt note (370);
4 classifier.evaluate 2-stage (§7.3); 5 decision.fallback→force ask (391);
6 allow→clearOnAllow(effects) / deny→noteDenied(effects,tool,turn) (398/409).

### 7.2 circumvention-detect (circumvention.ts:369–422)

Match all: was **soft-deny** (hard-deny is terminal, not tracked) ∧ write to **same
canonicalized path** ∧ **different tool** (`deniedByTool≠tool`). Write patterns recognized (6):
redirect (`>` `>>` `&>`), `tee`, `sed -i`, `cp`/`mv` (+`-t`/`--target-directory`),
inline python `open("…","w"|"a"|"x")`, `dd of=`. Path canonicalization absolutizes + resolves
`..` (clamped). Conservative skip if token has `$` backtick `*` `?` `~` `=` or leading `-`.
TTL = 20 turns (`DENIAL_LIMITS.maxTotal`, synced to denial budget). Posture: advisory (default,
LLM note) / escalate (force ask) / never (no auto-verdict).

### 7.3 classifier 2-stage (classifier.ts:447–473)

Stage1 "fast" (`STAGE1_BOTH_TAIL`: err toward block, do not apply user intent): clear allow →
return allow; block/unavailable → Stage2. Stage2 "thinking" (`STAGE2_THINKING_TAIL`): allow →
allow; block → applyDenial → deny or denial-limit→ask; unavailable → adopt stage1 or ask.
`runStage` calls the injected `port` **[boundary]** (489–498; throw ⇒ undefined, fail-safe).
Denial-limit (362): consecutiveDenials≥3 OR totalDenials≥20 → fallback ask (+reset at 20).
Exfil-scouting taxonomy line appended when enabled (157–168; else byte-identical).

### 7.4 HARD_DENY rules — 25 total (`HARD_DENY_RULES`, policy-rules.ts:91–294)

Verified count: 25 rule objects in the ordered `HARD_DENY_RULES` array (5 delete + 12 git +
5 RCE + 2 exfil + 1 perms). `HARD_DENY` (:299) is `HARD_DENY_RULES.map(r => r.pattern)`.

- Delete/destroy (5): `rm -rf` /·~·$HOME · `find` /·~ -delete/-exec rm · `find` -delete/-exec/-execdir · `mkfs` · `dd of=/dev/`
- Git-destructive (12): `-c` injection · `--exec-path` · `--config-env` · `reset --hard` ·
  `push --force`/`-f` · `checkout --` · `commit --amend` · `rebase -i` · `clean -f` ·
  `push --mirror` · `push --force`+`--delete` · `push` multi-branch delete (`:x` ×3+)
- RCE (5): `curl|wget | sh` · `base64 | sh` · `curl|wget | python·node·…` · fork-bomb `:(){ :|:& };:` · `shutdown/reboot/halt`
- Exfil (2): `~/.ssh`·`.aws/credentials`·`id_rsa`·`.env` `| (curl·nc·ssh·scp·aws·gh·gcloud·az…)` · raw write `/dev/sd·nvme…`
- Perms (1): `chmod -R` /·~·$HOME

`normalizeShellForDeny` (329): strips empty quote pairs (`r""m`→`rm`) and mid-token backslashes
(`c\url`→`curl`) so evasion can't split command names. Groups: SHELL_GROUP
(bash/zsh/…/fish/pwsh/osascript), INTERP_GROUP (python/node/deno/bun/tsx/…), EXFIL_GROUP
(curl/nc/ssh/scp/rsync/mail/aws/gh/gcloud/az/…), SYSTEM_ROOTS (etc/usr/…/Users/Library/System).

### 7.5 Why HARD_DENY is checked twice (gate 2 + gate 10)

`earlyHardDeny` (gate 2) runs **only when an allow-capable bypass is active**
(rulesStore | reviewerPort | permissionPatternStore | permission_request hook) — pulling the
HARD_DENY check ahead so those bypasses cannot tunnel a dangerous command. `runModePolicy`
(gate 10) rechecks HARD_DENY for the no-bypass legacy path. Same rule source (SSOT), intentional
double-cover, not a redundancy bug.

### 7.6 Ask / escalation branches

`resolveAskBranch` (gates.ts:375–423): trustScopeGrants→skip ask (ADR-0050: registry hasGrant +
`isSimpleCommand` prefix-guard, fail-closed on chained cmds); else `onConfirm` (throws
SessionApprovalRequired→rethrow; other throw→structured deny); allowed→`cascadeOnApprove`→
preToolUse hook. brokerEscalation (Capability B, 432–448): SOFT-deny + `hardDenyReason===null`
only → `broker.escalate`; approved→allow, else deny; throw→fail-closed deny.

---

## 8. Plan-mode transition (queue-based)

Callbacks wired in session-bootstrap.ts: `onPlanEnterRequest` push→`pendingPlanEntryRef.current[]`
(133–137), `onPlanExitOutcome` push→`pendingPlanExitRef.current[]` (124–128) — both changed from
single `|null` refs to **arrays** (in-flight). Applied at turn boundary on the continue path:
`applyQueuedPlanLifecycle` (turn-outcome.ts:20) picks exit (dominates) else entry, then clears
the queues; terminal paths call `clearQueuedPlanLifecycle` (drop). Enter
(plan-enter-wire.ts:38): only write-capable modes (default/editor) set mode=plan; review/audit are
no-op. Exit (plan-exit-wire.ts:26): approved→mode=default / requested_changes→plan kept + feedback /
rejected→plan store cleared.

---

## 9. Stop / resume thresholds

### 9.1 budgetMeter.checkExhausted (budget/meter.ts:283–323)

Compares accumulated counters against injected `BudgetDials` (no literals), deterministic order:
maxTurns, maxModelCalls, maxToolCalls, maxShellCommands, maxTestRuns, maxInputTokens,
maxOutputTokens, maxReasoningTokens, maxTotalTokens(=in+out+reason), maxFilesChanged,
maxPatchBytes, maxRetries, maxConsecutiveFailures, maxWallClockMs, maxCostUsd(accum),
maxCostPerTurnUsd(this-turn). First breach returns `{exhausted, kind, budget, observed}`.
`tick("turn")` resets `costUsdThisTurn` (independent per-turn limit).

### 9.2 pre-flight cost (budget/meter.ts:209–217)

`wouldExceedCost`: `costUsdAccum + projectedUsd > maxCostUsd` (caller supplies `projectedUsd` =
input-floor price; meter holds no rate card). Non-finite/negative ⇒ fail-open. Drives
`costPreflightCondition` (§2 L2).

### 9.3 budgetLedger.hardBreach (budget-ledger.ts:727–776)

`perSession[id].totalCost > sessionHardLimit` OR `perDay[UTCday].totalCost > dailyHardLimit`
(policy-supplied). Each `(scope,kind)` fires at most once per ledger lifetime (Set of fired keys
`session-hard:<id>` / `daily-hard:<YYYY-MM-DD>`). Drives §2 L4.

### 9.4 subagentTurnGate.wait / wake (subagent/turn-gate.ts:143–195)

wait(): disposed→"settle"; pending→"resume"; loop signal.aborted→"settle"; else park (Promise).
wake("interrupt"): idle→resolve "woke"; busy→`turnAbort.abort()` + pending=true + "queued"
(abort threads to in-flight stream/tool). wake("followup"): idle→"woke"; busy→pending=true+"queued".
`wasInterrupted()` = current turnAbort.signal.aborted (129).

### 9.5 compaction thresholds (compaction.ts:594; token-baseline.ts:320)

`resolveThreshold` priority: explicit thresholdTokens > env `QUANTA_COMPACT_TOKENS` >
model-derived (`contextWindow − maxOutput − 13_000` safety margin) > `120_000` default.
trigger tokens = baseline-aware (`measuredInputTokens + estimate(messages after baseline)`) else
`estimate(all)` (chars/4). `force=true` skips threshold (604); `currentTokens≤threshold`⇒no-op
(605); `findBoundary≤0`⇒no_boundary (608). Hooks: preCompactHook (ADR-0133) → preflight
(ADR-0075: defer_one_turn|approve|force_now) → postCompactEmit.
dropOldestSalvage (521): reactiveCompact (keep K=2, fail if shrink<15%) → else hard-drop loop
(≤8 rounds, dropOldestTurn keepFloor=1, orphan-safe) until ≤targetTokens.

---

## 10. Stop reasons + reasonCode (stop-category.ts:78–228)

6 StopReasons, all via explicit `finish()`: completed, max_turns, aborted, error,
budget_exhausted, refusal. 18 reasonCodes:

```
completed.normal · completed.max_turns · completed.empty_exhausted · completed.malformed_exhausted
user.interrupt · system.abort · model.refusal · model.malformed_tool_use · model.empty_exhausted
provider.rate_limit(429) · provider.overloaded(529) · provider.network · provider.auth(401/403)
provider.bad_request(400/422) · provider.unknown · compaction.thrash · runtime.unknown_error
shell.needs_approval [reserved, not wired]
```
`classifyErrorReason` (144) matches in order: compaction-thrash → [malformed-tool-use] →
[empty-turn] → rate-limit → overloaded → network → auth → bad_request → provider → RUNTIME fallback.

---

## 11. Control knobs (defaults; all default-OFF unless noted)

| lever | default | env / field |
|---|---|---|
| stream retries | 3 | RECOVERY_CAPS |
| output continues | 3 | RECOVERY_CAPS |
| malformed retries | 1 | RECOVERY_CAPS |
| empty-turn retries | 2 | RECOVERY_CAPS |
| refusal fallbacks | 1 (hard) | RECOVERY_CAPS |
| empty-stream breaker | K=2 / decay 300s | maxConsecutiveEmpty opt (`QUANTA_LLM_EMPTY_STREAM_BREAKER_K`) |
| compaction threshold | model-derived / 120k | `QUANTA_COMPACT_TOKENS` |
| cost meter (L2) | OFF | `cfg.budgetMeter` |
| cost ledger (L4) | OFF | `cfg.budgetLedger` |
| subagent gate | OFF | `cfg.subagentTurnGate` |
| dedup gate | OFF | `cfg.dedupGate` |
| localize-phase | OFF | `cfg.localizePhase` |
| test-scope | OFF | `cfg.protectTestPaths` |
| dispatch-guard | OFF | `cfg.dispatchGuard` |
| cap-enforcer | OFF | `cfg.capEnforcer` |
| stuck-tracking | OFF | `cfg.autoBackground.detector` |
| repro-doubt | OFF | `cfg.reproDoubt` |
| hooks (pre/post/permission) | OFF | `cfg.hooks` |
| control-request | OFF | `QUANTA_CONTROL_REQUEST` |
| auto-mode classifier | OFF | `permission.mode="auto"` + classifier port |
| circumvention-detect | OFF | `QUANTA_CIRCUMVENT_DETECT` + tracker |
| prompt verify axis | OFF | `QUANTA_BENCH_REPRODUCE_FIRST` (SWE) / `QUANTA_VERIFY_AFTER_EDIT` (CLI) |
| prompt env posture | frozen | `QUANTA_TB_ENV_OWNED` (terminal) |

---

## 12. Open items (not omitted — bounded to injected interfaces)

- **classifier port implementation** — the 2-stage LLM-backed classifier is an injected
  `ClassifierPort`; its concrete impl lives in a separate slice (**[boundary]**, classifier.ts:489).
- **circumvention-detect internal algorithm beyond the 6 write patterns** — pattern set and TTL
  confirmed; the exact canonicalizer edge cases are in circumvention.ts and not fully enumerated here.
- Everything on the loop/dispatch/permission decision path itself is anchored above.
