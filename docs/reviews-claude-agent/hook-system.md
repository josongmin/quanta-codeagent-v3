# Hook system — 29종 라이프사이클 훅

Claude Code v2.1.143은 `hookEventNames` 배열에 정의된 **29종**의 라이프사이클 훅을 지원한다. v0.2.8에는 훅 시스템이 전혀 없었다.

훅 종류 (`Ez5` / `hookEventNames`, `extracted-functions.js:9615`):

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch,
Notification, UserPromptSubmit, UserPromptExpansion,
SessionStart, SessionEnd,
Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact,
PermissionRequest, PermissionDenied,
Setup, TeammateIdle,
TaskCreated, TaskCompleted,
Elicitation, ElicitationResult,
ConfigChange,
WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged
```

훅 이벤트 → 트램폴린 함수 매핑은 `hookEventRegistry` 객체에 모인다 (line 18831 끝):

```
bp3 = {
  PreToolUse: GX_, PostToolUse: RX_, PostToolUseFailure: LX_, PostToolBatch: qP_,
  PermissionDenied: FX_, PermissionRequest: p4H, Notification: XQ,
  Stop: x4H, SubagentStop: x4H, StopFailure: $NH,
  TeammateIdle: HP_, TaskCreated: EX_, TaskCompleted: dVH,
  UserPromptSubmit: sZ_, UserPromptExpansion: Xf_,
  SessionStart: Mw_, SessionEnd: nNH, Setup: fw_, SubagentStart: OP_,
  PreCompact: lg, PostCompact: PwH, ConfigChange: VAH,
  CwdChanged: Jw_, FileChanged: Dw_, InstructionsLoaded: pGH,
  Elicitation: sP_, ElicitationResult: tP_,
  WorktreeCreate: evH, WorktreeRemove: hsH,
}
```

각 트램폴린은 페이로드를 만들고 다음 두 실행 엔진 중 하나로 `yield*` 또는 `await` 한다:

- `coreHookEngine` (line 18860) — **REPL/agent loop용 generator** — 메시지 스트림을 yield, 부수효과(updatedInput, permissionBehavior, watchPaths, additionalContext 등) 전달.
- `oneShotHookEngine` (line 18866) — **REPL 밖에서 일회 실행** — `Promise.all` 로 모든 훅을 병렬 실행하고 결과 배열 반환. SessionEnd, WorktreeCreate/Remove, ConfigChange, Elicitation, CwdChanged, FileChanged, InstructionsLoaded, Notification 등이 사용.

## 훅 분류

| 그룹 | 훅 | 특징 |
|---|---|---|
| Tool lifecycle | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied` | tool_use_id 단위, 도구 실행 파이프라인에서 fire |
| Session lifecycle | `SessionStart`, `SessionEnd`, `Setup`, `SubagentStart`, `SubagentStop` | 세션/서브에이전트 boot·종료 |
| Prompt | `UserPromptSubmit`, `UserPromptExpansion` | 사용자 입력 처리 시점 |
| Stop | `Stop`, `SubagentStop`, `StopFailure` | model이 더 이상 tool_use를 하지 않을 때 = 턴 종료 직전 |
| Compact | `PreCompact`, `PostCompact` | 압축 전후 |
| Misc / Notification | `Notification`, `ConfigChange`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult` | 멀티에이전트·MCP elicitation·설정 변경 등 |
| Worktree / Watcher | `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged` | 워크트리 도구 + 파일/메모리 watcher |

## 1. 호출 그래프

### 1.1 PreToolUse — `executeToolPipeline` 안에서 (`extracted-functions.js:13875`)

```
Bq3 (turn loop)
└── Hj_ → _j_ → r63 → a63
       (a63 = single tool full pipeline)
       1. inputSchema.safeParse → 실패 시 즉시 tool_result(is_error)
       2. validateInput?.()
       3. backfillObservableInput
       4. for await (qH of dA6(...)) {                  ← PreToolUse hooks runner
            type: "message"     → progress / context attach
            type: "hookPermissionResult" → L = permission decision
            type: "hookUpdatedInput"     → X = updatedInput (replace tool input)
            type: "preventContinuation"  → W = true
            type: "stopReason"           → G = stopReason
            type: "additionalContext"    → f.push(message)
            type: "defer"     → return hook_deferred_tool (print-mode + solo-only)
            type: "stop"      → push InterruptToolUse + return f
          }
       5. t5H()?.observe("pre_tool_hook_duration_ms", Date.now()-v)   ← OTEL
          if (E >= Ty8) log "Slow PreToolUse hooks: …"                 ← Ty8 = 2000ms
       6. QA6(L, H, X, …)        ← Permission decision orchestrator
            - hook이 "deny"면 즉시 deny
            - hook이 "allow" but updatedInput 있으면 user interaction satisfied
            - otherwise canUseTool() 호출, dont 쓰는 deny rule이 hook 결정 override
       7. tool.call(...) → mapToolResultToToolResultBlockParam
       8. for await (yH of FA6(...)) { … }              ← PostToolUse hooks runner
            updatedToolOutput  → TH replace, ZH=true
            preventContinuation → hook_stopped_continuation
            additionalContexts  → hook_additional_context
       9. if (ZH) outputSchema.safeParse(TH); 실패 시 hook_error_during_execution
      10. (catch error) gA6(...)                          ← PostToolUseFailure runner
```

### 1.2 Stop / SubagentStop — `runTurnLoop` 끝에서 (line 14043)

`runTurnLoop` 안에서 모델 응답에 `tool_use`가 더 없으면 (`!t`):

```
Bq3 (no tool_use this turn)
└── yield* Va7(x, wH, q, K, O, Z, z, h, riH())     ← Stop / SubagentStop runner
       1. classifier (Ra7) — last user prompt 분석 → post_turn_summary
       2. brief-mode enforcement 메시지 삽입 (optional)
       3. activeGoal이 있으면 frontmatter Stop hook을 임시로 제거하여 deferred 평가
       4. for await (x of x4H(…)) {        ← bp3.Stop = bp3.SubagentStop = x4H
            x.blockingError    → Z.push(meta-user-message), m=true
            x.preventContinuation → I=true, C=stopReason, yield hook_stopped_continuation
            x.message          → yield through; track progress + hook_success
          }
       5. if (활성 task가 있으면) → TaskCompleted hook 실행 (dVH)
       6. → TeammateIdle hook 실행 (HP_)
       7. finally: P (제거된 goal hook) 다시 sessionHooksRegistry.add 복원

return { blockingErrors, preventContinuation }
```

`runTurnLoop` 안 stop hook 결과 처리:

```
let J_ = yield* Va7(...);
if (J_.preventContinuation) return { reason: "stop_hook_prevented" };
if (J_.blockingErrors.length > 0) {
  B_ = stopHookBlockingCount + 1;
  if (maxTurns && nextTurn > maxTurns) return "max_turns";
  cap = parseInt(env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, 10) || 8;
  if (cap > 0 && B_ > cap) {
    yield warning("A hook blocked the turn from ending {B_} consecutive times — overriding…");
    return { reason: "completed" };
  }
  D = { messages: [...x, ...wH, ...J_.blockingErrors],
        stopHookActive: true, stopHookBlockingCount: B_,
        transition: { reason: "stop_hook_blocking" } };
  continue;   // 한 턴 더 (blocking message가 user-input 처럼 작동)
}
return { reason: "completed" };
```

### 1.3 PostToolBatch — `runTurnLoop` 안에서 (line 14057, mid-tail)

`PostToolUse`는 도구마다 (concurrent 가능) 발사되지만, `PostToolBatch`는 **한 턴의 모든 tool_use 결과가 다 모인 후 한 번만** fire:

```
if (JS("PostToolBatch", appState, agentId)) {
  T_ = "hook-" + uuid();
  H_ = Map<tool_use_id, tool_response_content>(...);
  for await (J_ of qP_(_H.map(b_ => ({tool_name, tool_input, tool_use_id, tool_response})), T_, dH, …)) {
    if (J_.message) yield J_.message;
    if (J_.additionalContexts.length) yield hook_additional_context, JH.push(...);
    if (J_.blockingError) G_ = true, M_ = blockingError;
    if (J_.preventContinuation) G_ = true, M_ ??= stopReason;
  }
  if (G_) {
    yield hook_stopped_continuation; mJH(dH, z); return { reason: "hook_stopped" };
  }
}
```

`PostToolBatch`는 `runTurnLoop` 한 턴에서 **`PreToolUse`/`PostToolUse`/`PostToolUseFailure` 다음, 다음 model request 직전**에 fire (페이로드 `tool_calls: Array<{tool_name, tool_input, tool_use_id, tool_response?}>`).

### 1.4 SessionStart / SessionEnd / Setup / SubagentStart

- `Mw_(source, ...)` (line 18809) — `SessionStart` (source: `startup` | `resume` | `clear` | `compact`).
- `nNH(reason)` (line 18812) — `SessionEnd` (reason: `clear` | `resume` | `logout` | `prompt_input_exit` | `other` | `bypass_permissions_disabled`). `oneShotHookEngine` 기반 — REPL 밖에서도 호출됨. timeout은 `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 또는 `B2_()` 계산값.
- `fw_(trigger)` (line 18810) — `Setup` (trigger: `init` | `maintenance`). **확인**: `init` = 세션 시작 시 1회, `maintenance` = (추정) 주기적 / config 변경 시.
- `OP_(agent_id, agent_type, ...)` (line 18811) — `SubagentStart`. line 14064의 서브에이전트 build path에서 호출, 결과 `additionalContexts`를 서브에이전트 메시지에 prepend.

### 1.5 UserPromptSubmit / UserPromptExpansion

`sZ_(prompt, permissionMode, ctx)` (line 18827): REPL의 사용자 입력 처리 path에서 호출. `session_title: FA(k_())` 자동 포함. 출력 `hookSpecificOutput`:
- `additionalContext`: 사용자 입력 뒤에 system context 추가.
- `sessionTitle`: `/rename`과 동일 효과.
- `suppressOriginalPrompt`: `decision === "block"`일 때 원본 prompt 숨김.

`Xf_(expansion_type, command_name, command_args, command_source, prompt, ...)`: slash command / MCP prompt 확장 시 fire. `expansion_type: "slash_command" | "mcp_prompt"`.

### 1.6 Compact

`lg(trigger, customInstructions, signal, timeoutMs)` (PreCompact, `oneShotHookEngine` 기반): manual `/compact` 호출 또는 auto-compact 진입 직전 fire. blocking 시 압축을 막을 수 있음.
`PwH(trigger, compact_summary, ...)` (PostCompact): 압축 성공 후 fire.

### 1.7 Worktree / Watcher

- `evH(name)` (line 18828) — `WorktreeCreate`. `EnterWorktree` 도구에서 호출 → 실행한 훅 중 첫 번째 succeeded hook의 stdout(첫 줄)을 worktree path로 사용. 훅이 0개거나 모두 실패하면 throw. `hookSpecificOutput.worktreePath`도 허용 (callback/http용).
- `hsH(worktree_path)` (line 18830) — `WorktreeRemove`. `ExitWorktree` 도구에서. 적어도 1개 succeeded 면 true 반환.
- `KEK`/`Jw_(old_cwd, new_cwd)` — `CwdChanged`. cwd 추적기에서 trigger.
- `Dw_(file_path, event)` — `FileChanged` (event: `change` | `add` | `unlink`). SessionStart/CwdChanged hook이 반환한 `watchPaths` 위에서만 watch.
- `pGH(file_path, memory_type, load_reason, globs?, trigger_file_path?, parent_file_path?)` — `InstructionsLoaded`. CLAUDE.md / memory load 시 fire. `memory_type: "User"|"Project"|"Local"|"Managed"`, `load_reason: "session_start"|"nested_traversal"|"path_glob_match"|"include"|"compact"`.

### 1.8 Misc

- `XQ(message, title?, notification_type)` — `Notification`. permission 대기·idle·plan-mode 등 desktop notification path.
- `VAH(source, file_path?)` — `ConfigChange` (source: `user_settings`|`project_settings`|`local_settings`|`policy_settings`|`skills`). `policy_settings`는 blocked 결과를 무시 (warning만).
- `HP_(teammate_name, team_name)` (line 18815) — `TeammateIdle`. multi-claude / coordinator 모드. Va7가 `KO()` 조건일 때 `dVH` (TaskCompleted) 다음 호출. **추정**: teammate가 idle 상태로 진입했을 때 main thread가 work를 할당할지 결정.
- `EX_(task_id, task_subject, task_description?, teammate_name?, team_name?)` (line 18816), `dVH(...)` (line 18817) — `TaskCreated` / `TaskCompleted`. Coordinator mode에서 task 생성/완료 시 fire. blockingError는 다음 턴을 강제할 수 있음.
- `sP_(mcp_server_name, message, mode?, url?, elicitation_id?, requested_schema?)` — `Elicitation`. MCP 서버가 user input을 요청할 때 (dialog 표시 전). hook이 `accept`/`decline`/`cancel` 액션과 content를 반환하면 dialog를 건너뜀.
- `tP_(mcp_server_name, elicitation_id?, mode?, action, content?)` — `ElicitationResult`. 사용자 응답 후 MCP에 보내기 직전. hook이 action/content override 가능.
- `$NH(error, error_details?, last_assistant_message?)` — `StopFailure`. Stop hook 자체가 실패했을 때 fire. error 종류: `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `rate_limit`, `invalid_request`, `server_error`, `unknown`, `max_output_tokens`.

## 2. 핵심 로직

### 2.1 `runPreToolUseHooks` — PreToolUse 핸들링 (의사코드, line 13604)

```js
async function* dA6(toolUseCtx, tool, parsedInput, toolUseId, msgId, requestId, mcpServerType, mcpServerBaseUrl) {
  const t0 = Date.now();
  let deferredHook, hasDeny = false;
  try {
    for await (const j of GX_(tool.name, parsedInput, toolUseId, toolUseCtx, mode, abortSignal)) {
      // GX_ → T2 → 각 훅 실행, j는 훅 산출물 1개
      try {
        if (j.message && j.message.type !== "attachment:hook_blocking_error")
          yield { type: "message", message: { message: j.message } };

        if (j.blockingError) {
          hasDeny = true;
          const msg = Av8(`PreToolUse:${tool.name}`, j.blockingError);
          yield { type: "hookPermissionResult",
                  hookPermissionResult: { behavior: "deny", message: msg,
                                          decisionReason: { type: "hook", hookName, reason: msg } } };
        }
        if (j.preventContinuation) {
          yield { type: "preventContinuation", shouldPreventContinuation: true };
          if (j.stopReason) yield { type: "stopReason", stopReason: j.stopReason };
        }
        if (j.permissionBehavior !== undefined) {
          if (j.permissionBehavior === "defer") { deferredHook = j.hookSource || `PreToolUse:${tool.name}`; continue; }
          if (j.permissionBehavior === "deny")  hasDeny = true;
          const reason = { type: "hook", hookName, hookSource: j.hookSource, reason: j.hookPermissionDecisionReason };
          if (j.permissionBehavior === "allow")
            yield { type: "hookPermissionResult",
                    hookPermissionResult: { behavior: "allow", updatedInput: j.updatedInput, decisionReason: reason } };
          else if (j.permissionBehavior === "ask")
            yield { type: "hookPermissionResult", hookPermissionResult: { behavior: "ask", updatedInput, message, decisionReason: reason } };
          else  // "deny"
            yield { type: "hookPermissionResult", hookPermissionResult: { behavior: j.permissionBehavior, message, decisionReason: reason } };
        }
        if (j.updatedInput && j.permissionBehavior === undefined)
          yield { type: "hookUpdatedInput", updatedInput: j.updatedInput };
        if (j.additionalContexts?.length > 0)
          yield { type: "additionalContext",
                  message: { message: T9({ type: "hook_additional_context", content: j.additionalContexts, hookName, toolUseID, hookEvent: "PreToolUse" }) } };

        if (toolUseCtx.abortController.signal.aborted) {
          d("tengu_pre_tool_hooks_cancelled", {...});
          yield { type: "message", message: { message: T9({ type: "hook_cancelled", hookName, toolUseID, hookEvent: "PreToolUse" }) } };
          yield { type: "stop" };
          return;
        }
      } catch (J) {
        vH(J);
        d("tengu_pre_tool_hook_error", { duration: Date.now()-t0, … });
        yield { type: "message", message: { message: T9({ type: "hook_error_during_execution", content: E4H(J), hookName, toolUseID, hookEvent: "PreToolUse" }) } };
        yield { type: "stop" };
      }
    }
  } catch (j) { vH(j); yield { type: "stop" }; return; }

  if (deferredHook && !hasDeny) yield { type: "defer", hookName: deferredHook };
}
```

### 2.2 `runPostToolUseHooks` — PostToolUse (의사코드, line 13600)

```js
async function* FA6(ctx, tool, toolUseId, msgId, parsedInput, toolOutput, requestId?, mcpServerType?, mcpServerBaseUrl?, ext?) {
  const t0 = Date.now();
  try {
    const mode = ctx.getToolPermissionContext().mode;
    for await (const J of RX_(tool.name, toolUseId, parsedInput, toolOutput, ctx, mode, ctx.abortController.signal, undefined, ext)) {
      try {
        if (J.message?.type === "attachment" && J.message.attachment.type === "hook_cancelled") {
          d("tengu_post_tool_hooks_cancelled", {...});
          yield { message: T9({type:"hook_cancelled", hookName:`PostToolUse:${tool.name}`, ...}) };
          continue;
        }
        if (J.message && !(attachment.type === "hook_blocking_error"))
          yield { message: J.message };
        if (J.blockingError)
          yield { message: T9({ type: "hook_blocking_error", hookName, toolUseID, hookEvent: "PostToolUse", blockingError: J.blockingError }) };
        if (J.updatedToolOutput !== undefined)
          yield { updatedToolOutput: J.updatedToolOutput };
        if (J.updatedMCPToolOutput !== undefined && RG(tool))      // RG = isMcp tool
          yield { updatedToolOutput: J.updatedMCPToolOutput };
        if (J.preventContinuation) {
          yield { message: T9({ type:"hook_stopped_continuation", message: J.stopReason || "Execution stopped by PostToolUse hook", hookName, toolUseID, hookEvent:"PostToolUse" }) };
          return;
        }
        if (J.additionalContexts?.length > 0)
          yield { message: T9({ type:"hook_additional_context", content: J.additionalContexts, hookName, toolUseID, hookEvent:"PostToolUse" }) };
      } catch (D) {
        d("tengu_post_tool_hook_error", { duration: Date.now()-t0, … });
        yield { message: T9({ type:"hook_error_during_execution", content: E4H(D), hookName, toolUseID, hookEvent:"PostToolUse" }) };
      }
    }
  } catch (j) { vH(j); }
}
```

`executeToolPipeline`이 yield된 `updatedToolOutput`을 받으면:

```js
if (ZH) {              // any hook replaced output
  const parse = tool.outputSchema?.safeParse(TH);
  if (parse && !parse.success) {
    log("PostToolUse hook returned updatedToolOutput that does not match {tool}'s output shape");
    TH = qH.data;      // 원본 복원
    push hook_error_during_execution attachment
  } else {
    const block = tool.mapToolResultToToolResultBlockParam(TH, toolUseId);
    if (block === undefined) fail similarly
    else use block as new tool_result content
  }
}
```

`PostToolUseFailure`는 `runPostToolUseFailureHooks` (line 13601, FA6와 거의 동일)이 처리. `is_interrupt` 플래그로 사용자 인터럽트와 다른 에러 구분.

### 2.3 `runStopHooks` — Stop / SubagentStop (의사코드, line 14043)

```js
async function* Va7(originalMessages, freshAssistantMessages, systemPrompt, userContext, systemContext, ctx, querySource, stopHookActive, threadId) {
  const t0 = Date.now();
  // 1. classifier: post_turn_summary 분류
  if ((querySource startsWith repl_main_thread || querySource === "sdk") && classifier present && main thread)
    classifier.classifyAndPush(...) → ctx.setAppState({ postTurnSummary }); emit post_turn_summary system event;
  // 2. extract_memories, brief-mode enforcement (옵션)
  let briefMsg = ...; if (briefMsg) yield briefMsg;
  let removedGoalHook;  // activeGoal이 background task 중이면 임시 제거
  try {
    if (ctx.appState.activeGoal && background-tasks-running) {
      removedGoalHook = find Stop hook with prompt === goal.condition;
      if (removedGoalHook) ctx.sessionHooksRegistry.remove(sessionId, "Stop", removedGoalHook);
    }
    const v = x4H(mode, abortSignal, undefined, stopHookActive, agentId, ctx, messages, agentType);
    let progressToolUseId, progressCount=0, preventCont=false, stopReason="", anyOutput=false, errs=[], pendingCmds=[];
    for await (const x of v) {
      if (x.message) {
        yield x.message;
        if (x.message.type === "progress") { progressToolUseId = x.message.toolUseID; progressCount++; … }
        if (attachment.hookEvent === "Stop" || "SubagentStop") {
          if (hook_non_blocking_error) errs.push(stderr); anyOutput=true;
          else if (hook_error_during_execution) errs.push(content); anyOutput=true;
          else if (hook_success) {
            if (stdout/stderr non-empty) anyOutput=true;
            // goal-completion handling: removedGoalHook 매칭 시 sessionHooksRegistry 정리, goal_status emit
          }
        }
      }
      if (x.blockingError) {
        const meta = D6({ content: my8(x.blockingError), isMeta: true });
        Z.push(meta); yield meta; anyOutput=true;
        // active goal handling: iterations++
        else errs.push(x.blockingError.blockingError);
      }
      if (x.preventContinuation) preventCont=true, stopReason=x.stopReason || "Stop hook prevented continuation",
                                  yield hook_stopped_continuation;
      if (ctx.abortController.signal.aborted) {
        d("tengu_pre_stop_hooks_cancelled", {...});
        yield EHH({toolUse:false});
        return { blockingErrors: [], preventContinuation: true };
      }
    }
    if (progressCount > 0) yield stopHookSuggestion(progressCount, pendingCmds, errs, preventCont, …);
    if (preventCont) return { blockingErrors: [], preventContinuation: true };
    if (Z.length > 0) return { blockingErrors: Z, preventContinuation: false };

    // === Coordinator mode (KO()): in_progress tasks 정리 + teammate idle 통지 ===
    if (KO()) {
      const blocking = [], cont = false;
      for (each in_progress task owned by me) {
        for await (wH of dVH(task.id, task.subject, task.description, owner, team, mode, signal, undefined, ctx)) { …TaskCompleted… }
      }
      for await (o of HP_(owner, team, mode, signal, undefined, ctx)) { …TeammateIdle… }
      …
    }
    return { blockingErrors: [], preventContinuation: false };
  } catch (Z) {
    d("tengu_stop_hook_error", {...});
    yield VO(`Stop hook failed: ${PH(Z)}`, "warning");
    return { blockingErrors: ... };
  } finally {
    if (removedGoalHook) ctx.sessionHooksRegistry.add(sessionId, "Stop", "", removedGoalHook);
  }
}
```

### 2.4 `coreHookEngine` — 핵심 훅 실행 엔진 (의사코드, line 18860)

```js
async function* T2({ hookInput, toolUseID, matchQuery, signal, timeoutMs=x5, toolUseContext, getAppState, messages, forceSyncExecution }) {
  if (bm()) return;                                          // disableAllHooks managed setting
  if (process.env.CLAUDE_CODE_SIMPLE) return;
  if (!_5H()) {                                              // workspace trust 검사
    log("Skipping ... hook execution - workspace trust not accepted"); return;
  }
  const event = hookInput.hook_event_name;
  const name = matchQuery ? `${event}:${matchQuery}` : event;
  const matched = await cQ8(appState, sessionId, event, hookInput, options?.tools);  // 매칭된 훅 목록
  if (matched.length === 0) return;

  const nonInternal = matched.filter(h => !WEK(h));         // WEK = callback && internal
  if (nonInternal.length > 0)
    d("tengu_run_hook", { hookName: name, numCommands, hookTypeCounts, pluginHookCounts });
  else {
    // pure-callback hooks (내부) — yield 없이 그냥 실행
    for (const {hook} of matched) if (hook.type === "callback") await hook.callback(hookInput, ...);
    t5H()?.observe("hook_duration_ms", Date.now() - t0);
    d("tengu_repl_hook_finished", { ... });
    return;
  }

  // 1. 진행상황 hook_progress 이벤트 yield (한번씩, 시작 알림)
  for (const {hook} of matched) yield { message: { type:"progress", data:{ type:"hook_progress", hookEvent:event, hookName:name, command: vS(hook), promptText?, statusMessage? }, ... } };

  // 2. 각 훅을 병렬 generator로 실행 (V76 = concurrent merger)
  const generators = matched.map(async function*({hook, pluginRoot, pluginId, skillRoot}, idx) {
    // hook.type 분기:
    //   - "callback" → Fp3({...}) (internal callback runner)
    //   - "function" → Up3({hook, messages, ...}) — Stop hooks 전용; messages 없으면 hook_error
    //   - "prompt"   → UhK(hook, ...) — prompt-based hook (model이 ok/reason/impossible 평가)
    //   - "agent"    → ghK(hook, ...) — subagent-based hook
    //   - "http"     → gQ8(hook, ...) → JSON 파싱 → g26 → hook_success or hook_blocking_error
    //   - "mcp_tool" → QQ8(hook, ...) → 동일
    //   - "command"  → d26(hook, ...) → child_process.spawn, stdin=JSON, stdout=JSON
    //                  exit code:
    //                    0 → hook_success
    //                    2 → blockingError (단, Stop/SubagentStop/TaskCompleted/TeammateIdle 에서 "no such file" stderr이면 non_blocking으로 강등)
    //                    other → hook_non_blocking_error
    //                  JSON stdout 있으면 g26로 파싱 → permissionBehavior / updatedInput / additionalContext / 등
  });

  for await (const g of V76(generators)) {
    outcomes[g.outcome]++;
    if (g.updatedToolOutput !== undefined) yield { updatedToolOutput };
    if (g.updatedMCPToolOutput !== undefined) yield { updatedMCPToolOutput };
    if (g.preventContinuation) yield { preventContinuation: true, stopReason };
    if (g.blockingError) yield { blockingError, suppressOriginalPrompt, ... }; aggregate="deny";
    if (g.message) yield { message: g.message };
    if (g.systemMessage) yield { message: T9({ type:"hook_system_message", content, ... }) };
    if (g.terminalSequence) am8(g.terminalSequence);    // OSC 0/1/2/9/99/777 / BEL only
    if (g.additionalContext) yield { additionalContexts: [...persisted...] };
    if (g.initialUserMessage) yield { initialUserMessage };
    if (g.watchPaths) yield { watchPaths };
    if (g.sessionTitle) yield { sessionTitle };
    if (g.permissionBehavior) {
      // aggregate: deny > defer > ask > allow > passthrough
      yield { permissionBehavior: aggregate, hookPermissionDecisionReason, hookSource, updatedInput };
    }
    if (g.updatedInput && !g.permissionBehavior) yield { updatedInput };
    if (g.permissionRequestResult) yield { permissionRequestResult };  // PermissionRequest의 explicit decision
    if (g.retry) yield { retry };                                       // PermissionDenied의 retry signal
    if (g.elicitationResponse) yield { elicitationResponse };
    if (g.elicitationResultResponse) yield { elicitationResultResponse };
    if (sessionHook && onHookSuccess && g.outcome === "success") try { onHookSuccess(g.hook, g); } catch(...) {};
  }

  t5H()?.observe("hook_duration_ms", Date.now() - t0);
  d("tengu_repl_hook_finished", { numSuccess, numBlocking, numNonBlockingError, numCancelled, totalDurationMs, additionalContextChars, systemMessageChars, initialUserMessageChars, hookSuccessStdoutChars });
}
```

`cQ8` (line 18856) — 매칭 로직:
1. `Bp3()` 로 모든 등록된 hook matcher를 수집 (managed settings + main-thread agent settings + registered hooks + session hooks + sessionState hooks).
2. event 별로 matcher 키 (tool_name, command_name, source, trigger, notification_type, reason, agent_type, mcp_server_name, ConfigChange source, InstructionsLoaded load_reason, FileChanged basename) 추출.
3. matcher (regex/alternation/glob) 가 매치 안 하는 hook 제거.
4. 동일 plugin/skill 같은 hook은 (type, command/prompt/url + if 조건) 키로 deduplicate.
5. `if` 조건이 있는 hook은 `mp3` (tool_name + tool_input 기반 permission matcher) 평가 → 통과해야 fire.
6. `SessionStart` / `Setup` 에서는 HTTP hook 제외 (지원 안됨).

### 2.5 `g26` — JSON 출력 → 정규화 (line 18840)

훅 stdout JSON을 파싱한 후 표준 객체로 변환:

```js
function g26({json, command, hookName, toolUseID, hookEvent, expectedHookEvent, stdout, stderr, exitCode, durationMs}) {
  const w = {};

  // 공통 필드
  if (json.continue === false) { w.preventContinuation = true; if (json.stopReason) w.stopReason = json.stopReason; }
  switch (json.decision) {
    case "approve": w.permissionBehavior = "allow"; break;
    case "block":   w.permissionBehavior = "deny"; w.blockingError = { blockingError: json.reason || "Blocked by hook", command }; break;
    case undefined: break;
    default: throw Error(`Unknown hook decision type: ${json.decision}. Valid types are: approve, block`);
  }
  if (json.systemMessage) w.systemMessage = json.systemMessage;
  if (json.terminalSequence) { /* allowlist filter: OSC 0/1/2/9/99/777 + BEL */ }
  if (w.permissionBehavior !== undefined && json.reason !== undefined) w.hookPermissionDecisionReason = json.reason;

  // hookSpecificOutput
  if (json.hookSpecificOutput) {
    if (expectedHookEvent && hookSpecificOutput.hookEventName !== expectedHookEvent)
      throw Error(`Hook returned incorrect event name: expected '${expectedHookEvent}' but got '${...}'.`);
    switch (hookSpecificOutput.hookEventName) {
      case "PreToolUse":
        switch (permissionDecision) {
          case "allow": case "ask": → w.permissionBehavior;
          case "deny":  → w.permissionBehavior="deny", w.blockingError={blockingError: permissionDecisionReason || reason || "Blocked by hook", command};
          case "defer": → w.permissionBehavior="defer";
        }
        w.hookPermissionDecisionReason = permissionDecisionReason;
        if (updatedInput) w.updatedInput = updatedInput;
        w.additionalContext = additionalContext;
        break;
      case "UserPromptSubmit":  w.additionalContext, w.sessionTitle, w.suppressOriginalPrompt; break;
      case "UserPromptExpansion": w.additionalContext; break;
      case "SessionStart":      w.additionalContext, w.initialUserMessage, w.watchPaths; break;
      case "Setup":             w.additionalContext; break;
      case "SubagentStart":     w.additionalContext; break;
      case "PostToolUse":       w.additionalContext, w.updatedToolOutput, w.updatedMCPToolOutput; break;
      case "PostToolUseFailure": w.additionalContext; break;
      case "PostToolBatch":     w.additionalContext; break;
      case "PermissionDenied":  w.retry; break;
      case "PermissionRequest": w.permissionRequestResult = decision; w.permissionBehavior = decision.behavior==="allow"?"allow":"deny"; if (allow && updatedInput) w.updatedInput; break;
      case "Elicitation":       w.elicitationResponse = {action, content}; if (action==="decline") w.blockingError={blockingError: reason || "Elicitation denied by hook", command}; break;
      case "ElicitationResult": w.elicitationResultResponse = {action, content}; if (action==="decline") w.blockingError; break;
    }
  }
  return { ...w,
    message: w.blockingError
             ? T9({type:"hook_blocking_error", hookName, toolUseID, hookEvent, blockingError: w.blockingError})
             : T9({type:"hook_success", hookName, toolUseID, hookEvent, content:"", stdout, stderr, exitCode, command, durationMs}) };
}
```

Async 응답:
- `d_H(json) = "async" in json && json.async === true` → 훅을 백그라운드로 분리, `MEK` 가 별도 process 추적. async hook 은 `hookSpecificOutput` 을 처리하지 않고 `Promise.all`에서 빠진다.

### 2.6 출력 스키마 (Zod, line 18761 `Zp3` / `ysH`)

훅이 반환할 수 있는 최상위 객체:

```ts
type HookOutput =
  | { async: true; asyncTimeout?: number }
  | {
      continue?: boolean;            // false → preventContinuation
      suppressOutput?: boolean;
      stopReason?: string;           // continue==false일 때 사용자에게 표시
      decision?: "approve" | "block"; // 레거시; "block"이면 PreToolUse deny
      systemMessage?: string;        // 사용자에게 경고 표시
      terminalSequence?: string;     // OSC 0/1/2/9/99/777 / BEL only
      reason?: string;
      hookSpecificOutput?: HookSpecific
    };

type HookSpecific =
  | { hookEventName: "PreToolUse";
      permissionDecision?: "allow" | "deny" | "ask" | "defer";
      permissionDecisionReason?: string;
      updatedInput?: Record<string,unknown>;
      additionalContext?: string }
  | { hookEventName: "UserPromptSubmit"; additionalContext?: string; sessionTitle?: string; suppressOriginalPrompt?: boolean }
  | { hookEventName: "UserPromptExpansion"; additionalContext?: string }
  | { hookEventName: "SessionStart"; additionalContext?: string; initialUserMessage?: string; watchPaths?: string[] }
  | { hookEventName: "Setup"; additionalContext?: string }
  | { hookEventName: "SubagentStart"; additionalContext?: string }
  | { hookEventName: "PostToolUse"; additionalContext?: string; updatedToolOutput?: unknown; updatedMCPToolOutput?: unknown }
  | { hookEventName: "PostToolUseFailure"; additionalContext?: string }
  | { hookEventName: "PostToolBatch"; additionalContext?: string }
  | { hookEventName: "PermissionDenied"; retry?: boolean }
  | { hookEventName: "Notification"; additionalContext?: string }
  | { hookEventName: "PermissionRequest";
      decision: { behavior: "allow"; updatedInput?: {...}; updatedPermissions?: ... }
              | { behavior: "deny"; message?: string; interrupt?: boolean } }
  | { hookEventName: "Elicitation"; action?: "accept"|"decline"|"cancel"; content?: Record<string,unknown> }
  | { hookEventName: "ElicitationResult"; action?: "accept"|"decline"|"cancel"; content?: Record<string,unknown> }
  | { hookEventName: "CwdChanged"; watchPaths?: string[] }
  | { hookEventName: "FileChanged"; watchPaths?: string[] }
  | { hookEventName: "WorktreeCreate"; worktreePath: string };
```

검증 실패 시 (확인, `XEK` line 18837): `hookSpecificOutput` 에 `hookEventName` 누락이면 그 issue를 우선 보여주고, 그 외에는 첫 이슈 + 나머지 + 유효 스키마 doc를 함께 stderr 로 표시. 비 JSON 출력은 `plainText` 로 캐치되어 `hook_success` 메시지의 content에 들어간다.

## 3. State / Schema

### 3.1 베이스 페이로드 `hookPayloadBase` (line 9615)

```ts
{
  session_id: string,
  transcript_path: string,    // ~/.claude/projects/<key>/<session>.jsonl
  cwd: string,                // E_() 호출 결과
  permission_mode?: string,   // 호출 시 명시되면 (예: PreToolUse)
  agent_id?: string,          // 서브에이전트일 때만
  agent_type?: string,        // "general-purpose", "code-reviewer" 등
  effort?: { level: string }  // "low"/"medium"/"high"/"xhigh"/"max"; 모델이 effort 지원할 때만
}
```

기본 입력 빌더 `T5(permissionMode, sessionId, ctx)` (line 18836):
```js
T5(H, _, q) → {
  session_id: _ ?? k_(),
  transcript_path: QL(sessionId),
  cwd: E_(),
  permission_mode: H,
  agent_id: q?.agentId,
  agent_type: q?.agentType ?? jh(),
  effort: (model supports effort && getEffortValue) ? { level: sR(model, getEffortValue()) } : undefined,
}
```

### 3.2 훅별 입력/출력 매트릭스

| 이벤트 | 입력 필드 (Aw + ...) | 트램폴린 | yields/output 처리 |
|---|---|---|---|
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | `GX_` (line 18818) | `permissionDecision: allow\|deny\|ask\|defer`, `permissionDecisionReason`, `updatedInput`, `additionalContext`, `continue:false` |
| `PostToolUse` | + `tool_response`, `duration_ms?` | `RX_` (line 18819) | `additionalContext`, `updatedToolOutput`, `updatedMCPToolOutput` (revalidated against `outputSchema`) |
| `PostToolUseFailure` | + `error`, `is_interrupt?` | `LX_` (line 18820) | `additionalContext` |
| `PostToolBatch` | `tool_calls: Array<{tool_name, tool_input, tool_use_id, tool_response?}>` | `runPostToolBatchHook` (line 18821) | `additionalContext`; `decision:"block"` → next turn 중단 |
| `Notification` | `message`, `title?`, `notification_type` | `XQ` | `additionalContext` |
| `UserPromptSubmit` | `prompt`, `session_title?` | `sZ_` (line 18827) | `additionalContext`, `sessionTitle`, `suppressOriginalPrompt`; `decision:"block"` → prompt 차단 |
| `UserPromptExpansion` | `expansion_type`, `command_name`, `command_args`, `command_source?`, `prompt` | `Xf_` | `additionalContext` |
| `SessionStart` | `source: startup\|resume\|clear\|compact`, `agent_type?`, `model?` | `Mw_` (line 18809) | `additionalContext`, `initialUserMessage`, `watchPaths[]` (FileChanged 등록) |
| `SessionEnd` | `reason: clear\|resume\|logout\|prompt_input_exit\|other\|bypass_permissions_disabled` | `nNH` (line 18812, `oneShotHookEngine`) | 결과 무시; 실패 시 stderr 출력 |
| `Stop` | `stop_hook_active`, `last_assistant_message?` | `dispatchStopHook` | `decision:"block"` + `reason` → blockingError → 한 턴 더; `preventContinuation` |
| `StopFailure` | `error: CJ8 enum`, `error_details?`, `last_assistant_message?` | `runStopFailureHook` | additionalContext 무관 |
| `SubagentStart` | `agent_id`, `agent_type` | `OP_` (line 18811) | `additionalContext` |
| `SubagentStop` | `stop_hook_active`, `agent_id`, `agent_transcript_path`, `agent_type`, `last_assistant_message?` | `dispatchStopHook` | Stop와 동일; subagent 종료 직전 |
| `PreCompact` | `trigger: manual\|auto`, `custom_instructions: string\|null` | `lg` | `decision:"block"` → 압축 차단; `additionalContext` |
| `PostCompact` | `trigger`, `compact_summary` | `PwH` | `additionalContext` |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_suggestions?: PermissionUpdate[]` | `p4H` (line 18823) | `hookSpecificOutput.decision: {behavior:"allow"\|"deny", …}` — 권한 다이얼로그를 hook이 결정 |
| `PermissionDenied` | `tool_name`, `tool_input`, `tool_use_id`, `reason` | `runPermissionDeniedHook` (line 18822) | `retry: boolean` — `auto-mode` classifier 거부 후 재시도 가능 표시 |
| `Setup` | `trigger: init\|maintenance` | `fw_` (line 18810) | `additionalContext` |
| `TeammateIdle` | `teammate_name`, `team_name` | `HP_` (line 18815) | blockingError / preventContinuation 허용 (다음 턴 강제) |
| `TaskCreated` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` | `EX_` (line 18816) | — |
| `TaskCompleted` | 동일 | `dVH` (line 18817) | blockingError / preventContinuation |
| `Elicitation` | `mcp_server_name`, `message`, `mode?`, `url?`, `elicitation_id?`, `requested_schema?` | `sP_` | `action: accept\|decline\|cancel`, `content` — dialog 우회 / 자동 응답 |
| `ElicitationResult` | + `action: accept\|decline\|cancel` | `tP_` | action/content override |
| `ConfigChange` | `source: user_settings\|project_settings\|local_settings\|policy_settings\|skills`, `file_path?` | `VAH` (`oneShotHookEngine`) | `policy_settings`는 blocked 결과 무시 |
| `WorktreeCreate` | `name` | `evH` (line 18828, `oneShotHookEngine`) | stdout 첫 줄(또는 `hookSpecificOutput.worktreePath`) = 새 worktree 절대경로 — **0개면 throw** |
| `WorktreeRemove` | `worktree_path` | `hsH` (line 18830, `oneShotHookEngine`) | 1개 이상 succeed면 true |
| `InstructionsLoaded` | `file_path`, `memory_type: User\|Project\|Local\|Managed`, `load_reason: session_start\|nested_traversal\|path_glob_match\|include\|compact`, `globs?`, `trigger_file_path?`, `parent_file_path?` | `pGH` (`oneShotHookEngine`) | additionalContext 무관 — 알림용 |
| `CwdChanged` | `old_cwd`, `new_cwd` | `Jw_` (`oneShotHookEngine` 변종 `HEK`) | `watchPaths` (FileChanged 재등록) |
| `FileChanged` | `file_path`, `event: change\|add\|unlink` | `Dw_` | `watchPaths` |

### 3.3 `sessionHooksRegistry`

`ToolUseContext.sessionHooksRegistry` 는 4개 메서드를 가지는 객체 (`XVH(setAppState)`, line 12862):

```ts
{
  add(sessionId, hookEvent, matcher, hookDef, onHookSuccess?, skillRoot?),
  remove(sessionId, hookEvent, hookDef),
  clear(sessionId),
}
```

내부 저장소는 `AppState.sessionHooks: Map<sessionId, { hooks: { [event]: Array<{matcher, skillRoot?, hooks: Array<{hook, onHookSuccess?}>}> } }>` (line 10801 `sessionHooks: new Map`).

조회 함수들 (line 12858~):
- `OJH(appState, sessionId, event?)` — non-function 훅 (command/prompt/agent/http/mcp_tool) 만 반환.
- `Bm7(appState, sessionId, event?)` — function 타입 훅만.
- `Um7(appState, sessionId, event, matcher, hookDef)` — 특정 훅 lookup (onHookSuccess 콜백 회수).
- `Wf_` — `clear`.

훅 소스 우선순위 (`Bp3`, line 18853):
1. **Managed settings** (`Qg()` = policy settings). 다른 소스보다 우선.
2. **Main-thread agent hooks** (`mB()`, frontmatter `hooks:` 블록). Managed only가 아닐 때만.
3. **Registered hooks** (`Ex()`, programmatic registration). Managed only면 approved channels allowlist 통과한 것만.
4. **Session hooks** (sessionHooksRegistry → OJH + Bm7). Managed only가 아닐 때만.

훅 정의 타입 (`type` 디스크리미네이터):
- `"command"` — `{ command, args?, shell?, timeout?, if?, matcher? }` — `/bin/sh -c` 또는 `pwsh` 로 spawn, stdin=JSON, stdout=JSON 또는 plain text.
- `"http"` — `{ url, ... }` — POST JSON 페이로드.
- `"mcp_tool"` — `{ server, tool, input? }` — MCP tool call.
- `"prompt"` — `{ prompt, continueOnBlock? }` — Claude가 transcript 위에서 `ok/reason/impossible` 판정 (Stop/SubagentStop만).
- `"agent"` — subagent로 평가.
- `"callback"` — SDK 내부에서만 사용 (in-process JS function).
- `"function"` — Stop hooks 전용; signature `(messages, signal) => boolean | Promise<boolean>`. REPL 밖에서는 사용 불가.

`la7(registry, sessionId, hooksFromFrontmatter, label, isSubagent)` (line 14059) — agent definition frontmatter의 `hooks:` 블록을 sessionHooksRegistry 에 등록. **`isSubagent=true`이면 `Stop` 이벤트가 자동으로 `SubagentStop`으로 변환** (서브에이전트는 Stop이 아닌 SubagentStop을 발사하기 때문).

### 3.4 사용자 `~/.claude/settings.json` 훅 vs callback 훅

- `settings.json` 의 `hooks` 블록은 거의 모두 **shell command exec** (`type:"command"`) 형태. `cQ8` 가 settings 파일 + plugin / managed 모든 소스를 머지하여 `command` 타입 hook list를 만들고, `d26` (line 18841) 가 `child_process.spawn` 으로 실행한다.
- 환경변수 주입: `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_OPTION_*`, `CLAUDE_EFFORT`, `TRACEPARENT`, `CLAUDE_ENV_FILE` (SessionStart/Setup/CwdChanged/FileChanged 한정).
- Windows 처리: bash shebang `.sh` 자동 `bash` prefix, Git Bash 자동 탐색 (없으면 throw).
- async 훅: 첫 줄 stdout 이 `{"async":true,"asyncTimeout":...}` 이면 `MEK` 로 백그라운드 분리, 나중에 결과로 rewake 트리거 가능 (`asyncRewake`).
- **callback 훅은 SDK 호스트 (`@anthropic-ai/claude-code-sdk-ts`) 만 등록 가능** — `Ex()` 또는 sessionHooksRegistry 통해. `WEK` 가 `internal:true` callback을 분류하여 텔레메트리 카운트에서 제외.

## 4. 타임아웃 / 보호 장치

| 항목 | 값 | 위치 |
|---|---|---|
| `x5` (기본 hook timeout) | hook config의 `timeout` (초) × 1000, fallback은 build-default | line 1977 등 |
| `slowHookWarnMs` (Slow* 경고 threshold) | **2000 ms** | line 13877 `var Ty8=2000;` |
| `hm7` (UserPromptSubmit 전용) | 별도 값 | line 18827 |
| `Ip3` (notification text limit) | 200 chars | line 18827 |
| `m26` (SessionEnd default timeout) | 빌드 상수 | `B2_()` line 18832 |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | env override | line 18832 |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | **기본 8** | line 14057 |

Slow* 사용처:
- `Slow PreToolUse hooks: {ms}ms for {tool} ({count} hooks)` — `executeToolPipeline` 안 PreToolUse 누적 시간이 `>= Ty8`일 때 (line 13875).
- `Slow PostToolUse hooks: {ms}ms for {tool} ({count} hooks)` — 같은 함수의 후반부.
- `Slow permission decision: {ms}ms for {tool} (mode=auto, behavior=...)` — `mode === "auto"` (LLM classifier) 일 때만.

OTEL 관측치 (`t5H()?.observe(...)`):
- `pre_tool_hook_duration_ms` — `executeToolPipeline` 에서 PreToolUse generator 소비 후 (line 13875, 세 군데).
- `hook_duration_ms` — `coreHookEngine` 끝, generator-only path 와 일반 path 양쪽.
- 추가 카운터: `preToolHookDurationMs`, `permissionDurationMs` 가 `tengu_tool_use_success` 이벤트의 필드로 같이 기록.

## 5. 특수 동작

### 5.1 `defer` (PreToolUse 전용)

`a63:case "defer"` (line 13875):
```js
case "defer":
  t5H()?.observe("pre_tool_hook_duration_ms", Date.now()-v);
  if (!K.options.isNonInteractiveSession) {
    log("Hook {hookName} returned permissionDecision=defer in interactive mode; ignoring (defer is print-mode only)", "warn");
    break;
  }
  const e = countOfToolUseInThisAssistantMessage;
  if (e > 1) {
    log("Hook {hookName} returned permissionDecision=defer but {e} tool calls are in this batch; ignoring (defer is solo-only — siblings would be orphaned on resume)", "warn");
    break;
  }
  d("tengu_pre_tool_hook_deferred", {...});
  f.push({ message: T9({ type:"hook_deferred_tool", toolUseID, toolName, toolInput, hookName, hookEvent:"PreToolUse", permissionMode }) });
  return f;
```

조건:
- **non-interactive (print-mode / `-p`) 만** 작동.
- 같은 assistant message 안에 tool_use가 **정확히 1개** 일 때만 (siblings 가 resume 시 orphan 되므로).
- 둘 다 만족하지 못하면 무시 (warning 만).

### 5.2 `preventContinuation` (PreToolUse + PostToolUse + Stop + PostToolBatch + TaskCompleted + TeammateIdle)

- PreToolUse: 도구 실행 후의 후속 도구 호출 단계를 차단.
- PostToolUse: tool_result 직후 hook_stopped_continuation emit → 턴 종료.
- Stop: `runTurnLoop` 가 `{ reason: "stop_hook_prevented" }` 로 즉시 리턴.

### 5.3 `updatedToolOutput`

PostToolUse hook의 `hookSpecificOutput.updatedToolOutput` (또는 MCP tool 전용 `updatedMCPToolOutput`) 은 도구 결과를 model에게 전달하기 전 **`tool.outputSchema.safeParse(TH)`로 재검증** (a63 line 13877):

```js
const dH = tool.outputSchema?.safeParse(TH);
if (dH && !dH.success) {
  log("PostToolUse hook returned updatedToolOutput that does not match {tool}'s output shape: {error}", "error");
  TH = qH.data;   // 원본 복원
  push hook_error_during_execution attachment;
} else {
  const block = tool.mapToolResultToToolResultBlockParam(TH, toolUseId);
  if (block === undefined) { log("mapper returned undefined"); fail similarly; }
  else use block as new tool_result content;
}
```

mapper 가 `undefined` 반환하거나 throw 해도 같은 처리.

### 5.4 `blockingErrors` (Stop / SubagentStop)

`runTurnLoop` 안:
```js
if (J_.blockingErrors.length > 0) {
  B_ = I + 1;  // stopHookBlockingCount
  if (Y && nextTurn > Y) return { reason: "max_turns", turnCount };
  const cap = parseInt(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, 10) || 8;
  if (cap > 0 && B_ > cap) {
    d("tengu_stop_hook_block_count", { count: B_, is_subagent, hit_max_turns:false, hit_cap:true });
    yield warning("A hook blocked the turn from ending {B_} consecutive times — overriding and ending turn. "
                  + "For Stop/SubagentStop hooks, check stop_hook_active in the input and return success while it's true. "
                  + "Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP to raise this limit.");
    return { reason: "completed" };
  }
  D = { messages: [...x, ...wH, ...J_.blockingErrors],
        stopHookActive: true,           // 다음 턴부터 페이로드의 stop_hook_active=true
        stopHookBlockingCount: B_,
        transition: { reason: "stop_hook_blocking" } };
  continue;   // 한 턴 더 (blocking errors가 meta user message로 들어감)
}
```

Stop 페이로드의 `stop_hook_active` 필드가 두 번째 이후 호출에서 `true` — 훅이 직접 무한 루프를 깨는 단서로 활용.

### 5.5 `hook_progress` 메시지

`coreHookEngine` 시작부에서 매 hook 마다 한 번 yield (line 18860):

```js
for (const {hook} of matched) yield {
  message: {
    type: "progress",
    data: {
      type: "hook_progress",        // sA5 (line 9615): hook_id, hook_name, hook_event, stdout, stderr, output
      hookEvent: event,
      hookName: name,
      command: vS(hook),             // 쉘 커맨드 / URL / "<prompt>" / "<agent>" / "<mcp:server/tool>"
      ...(hook.type === "prompt"  && { promptText: hook.prompt }),
      ...("statusMessage" in hook && hook.statusMessage != null && { statusMessage: hook.statusMessage }),
    },
    parentToolUseID: toolUseID,
    toolUseID,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
};
```

`makeHookProgressMsg` 는 한 군데서만 등장 (`extracted-functions.js:13871, 15510`) — `wrapToolWithProgressQueue` (a63 의 progress queue wrapper) 안에서 `runSingleTool` 와 함께 hook_progress 메시지를 SSE 스트림으로 전달. 즉 long-running hook은 일반 도구처럼 progress 이벤트로 사용자/SDK 호스트에 실시간 표시된다.

stderr / stdout 의 라인 단위 progress (long-running command hook)는 추가로 system event 형태로 emit 된다 (`sA5`: `system.subtype="hook_progress"`).

### 5.6 `hook_error_during_execution`

`g26` 의 출력 정규화에서 **JSON 파싱 실패가 아닌** generator 내부의 throw 가 발생했을 때 (각 runner 의 `catch` 블록):

```js
yield { message: T9({
  type: "hook_error_during_execution",
  content: E4H(D),                    // Error → 사람이 읽을 수 있는 string
  hookName, toolUseID, hookEvent
}) };
```

`PostToolUse` 의 `updatedToolOutput` 이 `outputSchema` 검증을 통과 못 하거나 mapper가 깨진 경우에도 동일 메시지가 추가로 push 된다. 이 메시지는 transcript 에 남지만 모델에는 fail 메시지로 전달.

JSON 형식 자체가 깨진 경우 (`XEK` / `PEK` / `Q26`) 는 `hook_non_blocking_error` 로 분류되어 exit code 1 + stderr 에 validation error 메시지가 들어간다 — model 은 보지 않음.

### 5.7 `tengu_*` 텔레메트리 이벤트

| 이벤트 | 발사 조건 |
|---|---|
| `tengu_run_hook` | 매칭된 외부 훅이 1개 이상일 때 (T2 시작) |
| `tengu_repl_hook_finished` | T2 끝 — `numCommands`, `numSuccess`, `numBlocking`, `numNonBlockingError`, `numCancelled`, `totalDurationMs`, `additionalContextChars`, `systemMessageChars`, `initialUserMessageChars`, `hookSuccessStdoutChars` |
| `tengu_pre_tool_hook_error` | dA6 catch |
| `tengu_post_tool_hook_error` | FA6 catch |
| `tengu_post_tool_failure_hook_error` | gA6 catch |
| `tengu_pre_tool_hooks_cancelled` | abort 도중 |
| `tengu_post_tool_hooks_cancelled` | abort |
| `tengu_post_tool_failure_hooks_cancelled` | abort |
| `tengu_pre_tool_hook_deferred` | defer 결정 |
| `tengu_pre_stop_hooks_cancelled` | abort |
| `tengu_stop_hook_error` | Va7 catch |
| `tengu_stop_hook_block_count` | Stop blocking 누적 / cap 도달 / max_turns |
| `tengu_hook_plugin_injected` | plugin이 inject한 chars 누적 |

## 6. 차이점 (v0.2.8 대비)

v0.2.8 에는 **훅 시스템이 존재하지 않았다**. `query()` 가 단일 재귀 generator였고 tool call 직전/직후에 어떤 hook도 발사하지 않았다. 권한 결정은 `tool.needsPermissions()` boolean 한 줄로 끝났고, 압축은 사용자가 `/compact` 슬래시 명령을 입력할 때만 발생했으며 외부 코드가 끼어들 지점이 전혀 없었다.

v2.1.143 의 hook system 도입은 다음 변화를 수반한다:

1. **29개 라이프사이클 지점이 신설** — 도구 lifecycle 6종 (Pre/Post/PostFailure/PostBatch/PermReq/PermDeny), session lifecycle 5종 (SessionStart/End, Setup, SubagentStart/Stop), prompt 2종, stop 3종, compact 2종, worktree 5종, misc 7종.

2. **호스트 통합 API**:
   - `~/.claude/settings.json` 의 `hooks` 블록 (shell command 기반).
   - Plugin / Skill frontmatter 의 `hooks:` 블록 — `la7` 가 sessionHooksRegistry 에 등록 (subagent 일 때는 Stop→SubagentStop 자동 변환).
   - SDK 의 in-process callback / function 훅 — `getRegisteredHooks` / `clearRegisteredPluginHooks` API.
   - 매니지드 settings (`policy_settings`) — 우선순위 최상위, `disableAllHooks` 로 전체 차단 가능.

3. **새로운 흐름 제어 신호** — 훅이 (a) tool input을 mutate (`updatedInput`), (b) 도구 결과를 mutate (`updatedToolOutput`), (c) 권한을 결정 (`permissionBehavior` allow/deny/ask/defer), (d) 추가 컨텍스트를 model 에 주입 (`additionalContext`, `initialUserMessage`), (e) 턴을 강제 종료/연장 (`preventContinuation`, blockingError), (f) 도구를 보류 (`defer`, print-mode + solo-only) 할 수 있다.

4. **OTEL/텔레메트리 인스트루먼테이션**: `pre_tool_hook_duration_ms`, `hook_duration_ms` 관측치와 `tengu_run_hook` / `tengu_repl_hook_finished` 이벤트가 도입되어 호스트가 훅 비용을 모니터링 가능.

5. **재시도 가드** — Stop blocking 무한 루프 방지를 위해 `stopHookBlockingCount` 가 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (기본 8) 을 넘으면 강제 종료. 페이로드의 `stop_hook_active: boolean` 필드로 훅이 직접 자기 호출을 인지하도록 안내.

6. **Workspace trust 게이팅** — `_5H()` (workspace trust accepted) 가 false 면 모든 훅 실행 건너뜀.

---

**식별자 표** (이 문서에 등장한 minified):

| ID | 역할 |
|---|---|
| `hookEventNames` / `Ez5` | 29-event 배열 상수 |
| `hookPayloadBase` | 베이스 페이로드 Zod |
| `Sz5`/`Iz5`/`bz5`/`uz5`/... | 각 이벤트별 입력 스키마 |
| `Zp3`/`ysH` | 출력 객체 Zod (`async` union + main) |
| `hookEventRegistry` | 29 → trampoline 매핑 |
| `coreHookEngine` | 메인 generator 엔진 (REPL) |
| `oneShotHookEngine` | one-shot 병렬 실행 (REPL 외) |
| `g26` | JSON stdout → 정규화된 yield 객체 |
| `d_H` | `async` 마커 검사 |
| `SS` | 비-async 객체 검사 |
| `cQ8` | 매칭된 훅 리스트 빌더 |
| `Bp3` | 4-source merge (managed/main-agent/registered/session) |
| `JS` | 특정 이벤트에 훅 1개 이상 등록 여부 |
| `up3` / `mp3` | matcher (regex/alternation) / `if` 조건 evaluator |
| `T5` | 베이스 페이로드 빌더 |
| `d26` | command 타입 spawn 실행기 |
| `gQ8` / `QQ8` | http / mcp_tool 실행기 |
| `evaluateGoal` / `ghK` | prompt / agent 실행기 |
| `Fp3` / `Up3` | callback / function 실행기 |
| `aP` | hook_response system event emit |
| `MEK` | async hook 백그라운드 tracker |
| `slowHookWarnMs` | **2000ms** Slow* threshold |
| `Av8` / `Tv8` | hook deny 메시지 formatter |
| `lookupStopSessionHook` / `Bm7` / `Um7` | sessionHooks 조회 |
| `XVH` | sessionHooksRegistry factory |
| `la7` | frontmatter `hooks:` → registry 등록 (subagent Stop→SubagentStop 변환) |
| `WEK` | internal callback 분류기 |
| `otelMeter` | OTEL meter accessor |

확인 필요 (추정):
- `Setup.trigger="maintenance"` 의 정확한 fire 시점 — 코드에는 enum 값만 있고 trigger 호출처는 찾지 못함.
- `TeammateIdle` 의 coordinator 모드 트리거 — `KO()` (coordinator mode 활성) 조건일 때만 `runStopHooks` 안에서 발사. 외부에 다른 발사점이 있는지는 미확인.
- `makeHookProgressMsg` 는 r63 의 progress queue 와 연결되지만 정확한 시그니처는 미확인 — 정의가 inline 으로 흩어진 듯.
