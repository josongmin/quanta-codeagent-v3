# Agent loop — Stop/SubagentStop, goal evaluation, PostToolBatch, end-of-turn yield protocol

`runTurnLoop`([`extracted-functions.js:14057`](../../extracted-functions.js#L14057)) 의 한 턴이 종료될 때 (마지막 assistant 응답에 `tool_use`가 없을 때, 또는 tool batch 완료 후 다음 model 호출 직전) **세 개의 후속 게이트** 가 작동한다:

1. **stream 끝 + `tool_use` 없음 경로** — `runStopHooks`([`extracted-functions.js:14043`](../../extracted-functions.js#L14043)) 가 Stop / SubagentStop / TaskCompleted / TeammateIdle hooks + `post_turn_summary` 분류기 + brief-mode + active goal 평가를 한 번에 묶어 처리한다. 결과는 `{ preventContinuation, blockingErrors }`.
2. **tool batch 완료 직후 경로** — `runPostToolBatchHook`([`extracted-functions.js:18821`](../../extracted-functions.js#L18821)) 가 `PostToolBatch` 훅을 한 번 발사한다. `hook_stopped_continuation` 또는 `blockingError`가 발생하면 턴이 `hook_stopped`로 종료.
3. **tool dispatch 도중 경로** — 일반 tool stream에서 `hook_stopped_continuation` 또는 `hook_deferred_tool` attachment가 도착하면 `runTurnLoop`가 즉시 종료 (`hook_stopped` / `tool_deferred`).

이 문서는 위 세 경로 + 다음 턴 시작 시 yield 되는 `pendingToolUseSummary` (`startPostTurnSummary`/`awaitPostTurnSummary`) 를 다룬다. 자매 문서 [hook-system.md](./hook-system.md), [agent-loop.md](./agent-loop.md) 와 함께 읽는다.

---

## 1. 호출 그래프

```
Bq3 (turn end, !sawToolUse)
└── yield* Va7(messages, freshAssistantMessages, sysPrompt, userCtx, sysCtx, ctx, querySource, stopHookActive, threadId)
       1. post_turn_summary 분류기 (Ra7.classifyAndPush)
            · 게이트: surfaces.has("summary") && Z7H(querySource) === "main" && !agentId
            · yield { type:"post_turn_summary", value:null }    ← 슬롯 예약
            · onClassified 콜백이 setAppState/notifyMetadataChanged + system event 발사
       2. brief-mode enforcement (La7.isBriefEnabled() 등)
            · "잡담 금지" sentinel 메시지를 user(meta)로 yield, Z 누적
       3. activeGoal deferral
            · ctx.appState.activeGoal && background tasks 진행 중이면 (eX_(tasks) || nY6(tasks))
              그 goal에 해당하는 Stop prompt-hook (giH로 lookup)을 임시로 sessionHooksRegistry.remove
       4. yield* x4H(mode, signal, undefined, stopHookActive, agentId, ctx, messages, agentType)
            ← Stop 또는 SubagentStop (페이로드 stop_hook_active 포함)
            ← 결과 stream: x.message, x.blockingError, x.preventContinuation
       5. hook_success 메시지에 대해 goal-match (N$6 비교) 확인
            · 매치되면 active goal 클리어 + active_goal:undefined + goal_status{met:true|false,failed?}
       6. 진행 hooks (h>0)면 va7(...) (stop_hook_summary system event) yield
       7. preventContinuation → return {blockingErrors:[], preventContinuation:true}
       8. Z.length > 0 (brief sentinel + blockingErrors) → return {blockingErrors:Z, preventContinuation:false}
       9. coordinator mode (KO()) 추가 처리:
            · in_progress tasks → yield* dVH(...)  ← TaskCompleted hook
            · yield* HP_(...)                      ← TeammateIdle hook
            · 같은 blockingErrors/preventContinuation 누적 로직
       10. finally: 5단계에서 제거한 goal hook을 sessionHooksRegistry.add 로 복원

Bq3 (Va7 결과 처리)
├─ preventContinuation:true     → return { reason:"stop_hook_prevented" }
├─ blockingErrors.length > 0    → cap 비교 → continue (turn+1) OR  return { reason:"completed" }
└─ else                          → return { reason:"completed" }

Bq3 (tool batch 정상 진행)
└── for await (... of (TH.getRemainingResults() || Hj_(...)))
       · attachment.type === "hook_stopped_continuation"  → hookStopped=true
       · attachment.type === "hook_deferred_tool"         → hookDeferred=true
       → rH = t47({tools, signal, isNonInteractiveSession, lastAssistantText}).then(da7).catch(null)
       → if (hookDeferred) return { reason:"tool_deferred" }
       → if (hookStopped)  return { reason:"hook_stopped" }
       → JS("PostToolBatch", ...) 면:
            for await of qP_(tool_calls, hookId, ctx, mode, signal)
               · message, additionalContexts, blockingError, preventContinuation 누적
               · blockingError||preventContinuation → yield hook_stopped_continuation → return "hook_stopped"

Bq3 (다음 턴 진입)
└── D = { ..., pendingToolUseSummary: rH }
└── 다음 while iteration 시작 직후: if (E) { let v = await E; if (v) yield v }
```

핵심 함수 매핑:

| 식별자 | 위치 | 역할 |
|---|---|---|
| `runStopHooks` | [`extracted-functions.js:14043`](../../extracted-functions.js#L14043) | Stop/SubagentStop + 부가 처리 결합 generator (확인) |
| `dispatchStopHook` | (`bp3.Stop = bp3.SubagentStop = x4H`, line 18814 부근) | Stop/SubagentStop 페이로드 빌더 + `coreHookEngine` 호출 (확인). 별도 함수는 없고 `agentId` 유무로 분기 |
| `runPostToolBatchHook` | [`extracted-functions.js:18821`](../../extracted-functions.js#L18821) | PostToolBatch 트램폴린 (확인) |
| `startPostTurnSummary` | [`extracted-functions.js:9904`](../../extracted-functions.js#L9904) | tool-use summary 생성기 — 별도 LLM 호출 (확인, body는 template literal로 잘려 일부만 가시) |
| `awaitPostTurnSummary` | [`extracted-functions.js:15609`](../../extracted-functions.js#L15609) | `startPostTurnSummary` 결과 → `{type:"tool_use_summary", summary, precedingToolUseIds, uuid, timestamp}` 래퍼 (확인) |
| `Ra7` | [`extracted-functions.js:14043`](../../extracted-functions.js#L14043) (`Iy8` 모듈) | 분류기 — `captureLatestAsk` + `classifyAndPush` (확인) |
| `tX_` | (`xy8` 모듈) | post_turn_summary 분류기 surface/sink 라우터 (`detectSurfaces`/`sinksFor`/`engineFor`/`classifiedToPostTurnSummary`) (확인) |
| `La7` | (`di` 모듈) | brief-mode 토글 + sentinel 텍스트 (확인) |
| `KO` | [`extracted-functions.js:4260`](../../extracted-functions.js#L4260) | coordinator/multi-agent 모드 판별 (확인) |
| `dVH` | [`extracted-functions.js:18817`](../../extracted-functions.js#L18817) | `TaskCompleted` 트램폴린 (확인) |
| `HP_` | [`extracted-functions.js:18815`](../../extracted-functions.js#L18815) | `TeammateIdle` 트램폴린 (확인) |
| `va7` (소문자 v) | [`extracted-functions.js:15583`](../../extracted-functions.js#L15583) | `stop_hook_summary` system message factory (확인) |
| `giH` | [`extracted-functions.js:13890`](../../extracted-functions.js#L13890) | 사용자-정의 매처 없는 Stop prompt-hook 모음 lookup (확인) |
| `N$6` | [`extracted-functions.js:12852`](../../extracted-functions.js#L12852) | 두 hook 정의가 같은지 비교 (`type`+key 동등) (확인) |
| `evaluateGoal` | [`extracted-functions.js:18766`](../../extracted-functions.js#L18766) | prompt-type hook 평가기 — LLM에 `{ok,reason,impossible?}` 강제 (확인) |
| `eRH` | [`extracted-functions.js:10071`](../../extracted-functions.js#L10071) | computer-use MCP cleanup — Va7 진입 시 fire-and-forget (확인) |
| `abortCleanup` | [`extracted-functions.js:14051`](../../extracted-functions.js#L14051) | abort 시 분류기 상태 `markTurnAborted` 호출 (확인) |
| `interruptMessage` | [`extracted-functions.js:15505`](../../extracted-functions.js#L15505) | "interrupted by user" meta user 메시지 빌더 (확인) |
| `makeToolResultMessage` | [`extracted-functions.js:15503`](../../extracted-functions.js#L15503) | user 메시지 (isMeta 등) 빌더 (확인) |
| `makeAttachmentMessage` | [`extracted-functions.js:14331`](../../extracted-functions.js#L14331) | attachment wrapper: `{type:"attachment", attachment:H, uuid, timestamp}` (확인) |
| `my8` | [`extracted-functions.js:18858`](../../extracted-functions.js#L18858) | `Stop hook feedback:\n${blockingError}` 포맷터 (확인) |

---

## 2. 핵심 로직 (의사코드)

### 2.1 `runStopHooks` — 의사코드 (확인, 가독화)

```js
async function* Va7(originalMessages H, freshAssistantMessages _, systemPrompt q,
                    userContext K, systemContext O, toolUseContext T,
                    querySource $, stopHookActive z, threadId A) {
  const t0 = Date.now();
  const w = { messages:[...H, ..._], systemPrompt:q, userContext:K, systemContext:O,
              toolUseContext:T, querySource:$ };

  // ── 0. SDK 텔레메트리 ─────────────────────────────────────────
  if ($.startsWith("repl_main_thread") || $ === "sdk") hD8(cg(w));

  // ── 1. post_turn_summary 분류기 ──────────────────────────────
  const surfaces = tX_?.detectSurfaces();              // {bg,watched,ccr,bridge,desktop,cli}
  const sinks    = surfaces ? tX_.sinksFor(surfaces) : null; // {state, summary, name}
  const engine   = sinks ? tX_.engineFor(sinks) : null;       // "llm" | "heuristic" | null

  if (A /* threadId */ && engine && Z7H($) === "main" && !T.agentId) {
    A.lastEmittedDetail = "";
    if (sinks.has("summary")) yield { type:"post_turn_summary", value:null };   // 슬롯 예약

    A.onClassified = (classifyResult, errorOrTimeout) => {
      if (errorOrTimeout || !sinks.has("summary")) return;
      const summary = tX_.classifiedToPostTurnSummary(classifyResult); // {status_category, status_detail, needs_action}
      T.setAppState(s =>
        s.postTurnSummary?.status_category === summary.status_category
          && s.postTurnSummary.status_detail === summary.status_detail
        ? s : { ...s, postTurnSummary: summary });
      T.sessionState?.notifyMetadataChanged({ post_turn_summary: summary });
      uL()?.reportMetadata({ post_turn_summary: summary });
      tv({ type:"system", subtype:"post_turn_summary",
           summarizes_uuid: _.at(-1)?.uuid ?? "", ...summary });
    };

    // 마지막 user prompt 캡처 + classifyAndPush 트리거
    const lastUserText = w.messages.findLast(m => m.type==="user" && !m.isMeta &&
                                                   typeof m.message.content === "string");
    if (lastUserText) Ra7.captureLatestAsk(A, lastUserText.message.content);

    const job = Ra7.classifyAndPush(A, x0(), agentType, "", assistantMessages,
                                    eX_(T.taskRegistry.all()), engine, surfaces)
                .catch(e => N(`[classifier] error: ${PH(e)}`, {level:"error"}));

    // background / SDK 환경은 분류 결과를 60s까지 대기
    if (G7() || $ === "sdk") await Promise.race([job, sleep(60000).unref()]);
  }

  // ── 2. extract memories / prompt suggestion / brief mode ────
  if (!G4()) {
    if (!xH(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)) HJ7(w, A?.lastResult);
    if (!T.agentId && pi_()) bq3.executeExtractMemories(w, T.appendSystemMessage);
    if (!T.agentId) Bo7(w, T.appendSystemMessage);
  }
  if (!T.agentId) await eRH(T).catch(()=>{});       // computer-use cleanup (best-effort)

  // brief-mode enforcement: tool exists + 이전 턴에서 brief 호출 없었으면
  // "잡담 금지" sentinel meta user 메시지 1개 주입
  let briefMsg = null;
  if (replOrSdk && La7.isBriefEnabled() && !env.DISABLE_BRIEF_MODE_STOP_HOOK
      && !T.agentId && tools.includes(BRIEF_TOOL)) {
    // (lookup: 마지막 user 이후 BRIEF tool 호출 없고 enforce sentinel도 없으면)
    briefMsg = D6({ content:`${BRIEF_ENFORCE_SENTINEL} ${La7.getBriefEnforceText()}`,
                    isMeta:true });
    yield briefMsg;
  }

  // ── 3. activeGoal: background work이 끝나면 평가하려고 잠시 hook 제거 ──
  let removedGoalHook = null;
  try {
    const Z = [];                                  // 누적 blockingErrors
    if (briefMsg) Z.push(briefMsg);

    const W = T.getAppState();
    const mode = T.getToolPermissionContext().mode;
    const L = W.activeGoal;
    if (L) {
      const tasks = T.taskRegistry.all();
      if (eX_(tasks) /* in_progress 멤버 있음 */ || nY6(tasks) /* local_bash 진행중 */) {
        removedGoalHook = giH(W, k_()).find(h => h.prompt === L.condition);
        if (removedGoalHook) {
          T.sessionHooksRegistry.remove(k_(), "Stop", removedGoalHook);
          N("[goal] evaluation deferred — background work still running");
        }
      }
    }

    // 매치: 이 산출물(hook 결과)이 active goal에 해당하는지 확인하는 헬퍼
    const goalMatcher = (hook) => {
      if (!hook) return undefined;
      return (OJH(W, k_(), "Stop").get("Stop") ?? [])
              .flatMap(e => e.hooks)
              .some(g => N$6(g, hook)) ? hook : undefined;
    };

    // ── 4. Stop / SubagentStop 실행 ─────────────────────────────
    const v = x4H(mode, T.abortController.signal, /*timeoutMs*/undefined,
                  /*stopHookActive*/z, T.agentId, T, w.messages, T.agentType);

    let progressToolUseID = "", progressCount = 0,
        preventCont = false, stopReason = "",
        anyOutput = false, errs = [], cmds = [];

    for await (const x of v) {
      if (x.message) {
        yield x.message;
        if (x.message.type === "progress" && x.message.toolUseID) {
          progressToolUseID = x.message.toolUseID;
          progressCount++;
          const data = x.message.data;
          if (data.command) cmds.push({ command:data.command, promptText:data.promptText });
        }
        if (x.message.type === "attachment") {
          const F = x.message.attachment;
          if ("hookEvent" in F && (F.hookEvent==="Stop"||F.hookEvent==="SubagentStop")) {
            if (F.type === "hook_non_blocking_error") {
              errs.push(F.stderr || `Exit code ${F.exitCode}`); anyOutput = true;
            } else if (F.type === "hook_error_during_execution") {
              errs.push(F.content); anyOutput = true;
            } else if (F.type === "hook_success") {
              if ((F.stdout||"").trim() || (F.stderr||"").trim()) anyOutput = true;

              // ── goal 완료 처리 ─────────────────────────────────
              const matched = goalMatcher(x.hook);
              if (F.hookEvent === "Stop" && matched) {
                T.sessionHooksRegistry.remove(k_(), "Stop", matched);
                const goal = T.getAppState().activeGoal;
                if (goal?.condition === matched.prompt) {
                  const iter = goal.iterations + 1;
                  const dur  = Date.now() - goal.setAt;
                  const tok  = tf() - goal.tokensAtStart;
                  yield { type:"active_goal", value:undefined };       // 클리어
                  if (x.impossible) {
                    yield T9({ type:"goal_status", met:false, failed:true,
                               condition: matched.prompt, reason: x.stopReason,
                               iterations:iter, durationMs:dur, tokens:tok });
                    d("tengu_goal_failed", { promptLength:matched.prompt.length, ... });
                    mH("goal_met","impossible");
                  } else {
                    yield T9({ type:"goal_status", met:true,
                               condition: matched.prompt, reason: x.stopReason,
                               iterations:iter, durationMs:dur, tokens:tok });
                    d("tengu_goal_achieved", { ... });
                    EH("goal_met");
                  }
                }
              }
            }
            // duration 메모: 같은 command의 progress entry에 durationMs 추가
            if ("durationMs" in F && "command" in F) {
              const c = cmds.find(c => c.command === F.command && c.durationMs === undefined);
              if (c) c.durationMs = F.durationMs;
            }
          }
        }
      }

      // ── blockingError 처리 ────────────────────────────────────
      if (x.blockingError) {
        const meta = D6({ content: my8(x.blockingError), isMeta:true });
        Z.push(meta); yield meta; anyOutput = true;

        const matched = goalMatcher(x.hook);
        const goal = T.getAppState().activeGoal;
        if (matched && goal?.condition === matched.prompt) {
          // goal 평가가 "아직 못 만났음"으로 blocking — iterations 증가, 다시 평가하게 둠
          yield { type:"active_goal",
                  value:{ ...goal, iterations:goal.iterations+1, lastReason:x.stopReason } };
          yield T9({ type:"goal_status", met:false,
                     condition: matched.prompt, reason: x.stopReason });
        } else {
          errs.push(x.blockingError.blockingError);
        }
      }

      if (x.preventContinuation) {
        preventCont = true;
        stopReason = x.stopReason || "Stop hook prevented continuation";
        yield T9({ type:"hook_stopped_continuation", message:stopReason,
                   hookName:"Stop", toolUseID:progressToolUseID, hookEvent:"Stop" });
      }

      if (T.abortController.signal.aborted) {
        d("tengu_pre_stop_hooks_cancelled", { ... });
        yield EHH({ toolUse:false });
        return { blockingErrors:[], preventContinuation:true };
      }
    }

    // ── 5. stop_hook_summary system event ───────────────────────
    if (progressCount > 0) {
      yield va7(progressCount, cmds, errs, preventCont, stopReason,
                anyOutput, "suggestion", progressToolUseID);
      if (errs.length > 0) {
        const shortcut = Of("app:toggleTranscript","Global","ctrl+o");
        T.addNotification?.({ key:"stop-hook-error",
            text:`Stop hook error occurred · ${shortcut} to see`, priority:"immediate" });
        if (!z /* !stopHookActive */) tv({ type:"system", subtype:"notification",
                                          key:"stop-hook-error", text:"Stop hook error occurred",
                                          priority:"immediate" });
      }
    }

    if (preventCont)    return { blockingErrors:[], preventContinuation:true };
    if (Z.length > 0)   return { blockingErrors:Z,  preventContinuation:false };

    // ── 6. Coordinator mode 추가 처리 ───────────────────────────
    if (KO()) {
      const teammateName = RO() ?? "";
      const teamName     = q3() ?? "";
      const blocking = [];
      let prevent = false, stopReason2, lastID = "";

      // TaskCompleted: 내가 소유한 in_progress task 들마다
      const myTasks = (await bV(Ty())).filter(t => t.status==="in_progress"
                                                   && t.owner===teammateName);
      for (const task of myTasks) {
        for await (const wH of dVH(task.id, task.subject, task.description,
                                   teammateName, teamName, mode,
                                   T.abortController.signal, undefined, T)) {
          if (wH.message) {
            if (wH.message.type==="progress" && wH.message.toolUseID) lastID = wH.message.toolUseID;
            yield wH.message;
          }
          if (wH.blockingError) {
            const meta = D6({ content: SX_(wH.blockingError), isMeta:true });
            blocking.push(meta); yield meta;
          }
          if (wH.preventContinuation) {
            prevent = true;
            stopReason2 = wH.stopReason || "TaskCompleted hook prevented continuation";
            yield T9({ type:"hook_stopped_continuation", message:stopReason2,
                       hookName:"TaskCompleted", toolUseID:lastID,
                       hookEvent:"TaskCompleted" });
          }
          if (T.abortController.signal.aborted)
            return { blockingErrors:[], preventContinuation:true };
        }
      }

      // TeammateIdle: 마지막에 1회
      for await (const o of HP_(teammateName, teamName, mode,
                                T.abortController.signal, undefined, T)) {
        if (o.message) {
          if (o.message.type==="progress" && o.message.toolUseID) lastID = o.message.toolUseID;
          yield o.message;
        }
        if (o.blockingError) {
          const meta = D6({ content: py8(o.blockingError), isMeta:true });
          blocking.push(meta); yield meta;
        }
        if (o.preventContinuation) {
          prevent = true;
          stopReason2 = o.stopReason || "TeammateIdle hook prevented continuation";
          yield T9({ type:"hook_stopped_continuation", message:stopReason2,
                     hookName:"TeammateIdle", toolUseID:lastID,
                     hookEvent:"TeammateIdle" });
        }
        if (T.abortController.signal.aborted)
          return { blockingErrors:[], preventContinuation:true };
      }

      if (prevent)            return { blockingErrors:[], preventContinuation:true };
      if (blocking.length>0)  return { blockingErrors:blocking, preventContinuation:false };
    }

    return { blockingErrors:[], preventContinuation:false };
  }
  catch (e) {
    failed = true;
    d("tengu_stop_hook_error", { duration:Date.now()-t0, ... });
    yield VO(`Stop hook failed: ${PH(e)}`, "warning");
    return { blockingErrors: briefMsg ? [briefMsg] : [], preventContinuation:false };
  }
  finally {
    if (removedGoalHook) T.sessionHooksRegistry.add(k_(), "Stop", "", removedGoalHook);
    if (failed) mH("hook_stop_handler","hook_stop_handler_failed");
    else        EH("hook_stop_handler");
  }
}
```

### 2.2 `dispatchStopHook` — Stop/SubagentStop 페이로드 빌더 (확인, 추출본의 `function*` 시그니처가 template literal 줄바꿈에 먹혀 일부만 가시)

식별 가능한 코드 조각:

```js
async function* x4H(/*mode*/H, /*signal*/_, /*timeoutMs*/q=x5,
                    /*stop_hook_active*/K, /*agentId*/O, /*ctx*/T,
                    /*messages*/$, /*agent_type*/z, /*extendedHookInput*/M) {
  // last_assistant_message: $ 의 마지막 assistant 텍스트 (Pa_ 류 헬퍼로 추출)
  let J = $.length ? lastAssistantText($) : undefined;

  // agentId 가 있으면 SubagentStop, 없으면 Stop
  const D = O
    ? { ...T5(H, undefined, T),
        hook_event_name:"SubagentStop",
        stop_hook_active: K,
        agent_id: O,
        agent_transcript_path: _G(O),
        agent_type: z ?? "",
        last_assistant_message: J }
    : { ...T5(H, undefined, T),
        hook_event_name:"Stop",
        stop_hook_active: K,
        last_assistant_message: J };

  yield* T2({ hookInput:D, extendedHookInput:M,
              toolUseID: crypto.randomUUID(),
              signal:_, timeoutMs:q, toolUseContext:T, messages:$ });
}
```

핵심: **agentId 유무로 Stop/SubagentStop 분기** (별도 `x4H_subagent` 없음). `bp3.Stop = bp3.SubagentStop = x4H`. payload에 항상 `stop_hook_active` 동봉. `extendedHookInput` (M) 은 Va7에선 미사용 (undefined).

### 2.3 `runPostToolBatchHook` — PostToolBatch 트램폴린 (확인)

```js
function* qP_(tool_calls H, hookId _, ctx q, mode K, signal O, timeoutMs T=x5) {
  const appState = q.getAppState();
  const agentId  = q.agentId ?? k_();
  if (!JS("PostToolBatch", appState, agentId)) return;

  const hookInput = {
    ...T5(K, undefined, q),
    hook_event_name:"PostToolBatch",
    tool_calls: H,    // Array<{ tool_name, tool_input, tool_use_id, tool_response? }>
  };
  yield* T2({ hookInput, toolUseID:_, signal:O,
              timeoutMs:T, toolUseContext:q });
}
```

`runTurnLoop` 가 호출하는 모양 (확인):

```js
if (JS("PostToolBatch", dH.getAppState(), dH.agentId ?? k_())) {
  const T_ = `hook-${J.uuid()}`;
  // tool_use_id → tool_response 매핑 빌드
  const H_ = new Map();
  for (const J_ of JH /* tool_result messages */)
    if (J_.type==="user" && Array.isArray(J_.message.content))
      for (const b_ of J_.message.content)
        if (b_.type==="tool_result") H_.set(b_.tool_use_id, b_.content);

  let G_ = false /*hookStopped*/, M_ /*stopReason*/;
  for await (const J_ of qP_(
        _H.map(b_ => ({ tool_name:b_.name, tool_input:b_.input,
                        tool_use_id:b_.id, tool_response:H_.get(b_.id) })),
        T_, dH, dH.getToolPermissionContext().mode, dH.abortController.signal)) {
    if (J_.message && !(J_.message.type==="attachment"
                        && J_.message.attachment.type==="hook_blocking_error"))
      yield J_.message;
    if (J_.additionalContexts?.length > 0) {
      const b_ = T9({ type:"hook_additional_context",
                      content:J_.additionalContexts,
                      hookName:"PostToolBatch", toolUseID:T_,
                      hookEvent:"PostToolBatch" });
      yield b_; JH.push(b_);
    }
    if (J_.blockingError)        { G_ = true; M_ ??= J_.blockingError.blockingError; }
    if (J_.preventContinuation)  { G_ = true; M_ ??= J_.stopReason; }
  }

  if (dH.abortController.signal.aborted) {
    if (!dH.agentId) await eRH(dH).catch(()=>{});
    if (dH.abortController.signal.reason !== "interrupt")
      yield EHH({ toolUse:false, now:J.now, uuidFn:J.uuid });
    return mJH(dH, z), { reason:"aborted_tools" };
  }

  if (G_) {
    yield T9({ type:"hook_stopped_continuation",
               message: M_ || "Execution stopped by PostToolBatch hook",
               hookName:"PostToolBatch", toolUseID:T_, hookEvent:"PostToolBatch" });
    return mJH(dH, z), { reason:"hook_stopped" };
  }
}
```

**관찰**:
- **한 턴의 모든 tool_use가 끝난 뒤 한 번만** 발사 (`PostToolUse`는 도구별로, `PostToolBatch`는 일괄).
- 페이로드 `tool_calls` 는 이번 턴 assistant가 호출한 도구들의 `(name, input, id, response)` 배열. `tool_response`는 `JH` (tool_result user 메시지들) 에서 lookup — 응답이 없는 도구는 `undefined`로 들어감 (서버 도구, 실패 도구 등).
- `additionalContexts`는 **유저 메시지로 yield 되고 `JH`(next-turn messages)에 push** → 다음 model 호출의 context에 포함됨. 도구 결과처럼 취급.
- `blockingError` 또는 `preventContinuation` → `hook_stopped` 종료. **여기는 Stop hook과 달리 "blocking → 한 번 더 retry" 가 없다** — PostToolBatch 의 block은 즉시 턴을 죽인다.
- 첫 `blockingError`만 메시지로 사용 (`M_ ??=` 단축평가). 다음 것들은 yield 되지만 stopReason엔 누적되지 않음.

### 2.4 `startPostTurnSummary` + `awaitPostTurnSummary` — PostTurnSummary 비동기 생성 (확인 + 일부 추정)

```js
async function t47({ tools:H, signal:_, isNonInteractiveSession:q,
                     lastAssistantText:K }) {
  if (H.length === 0) return null;
  try {
    const O = H.map(A => {
      const Y = s47(A.input, 300);    // input 300자 미만으로 truncate
      const w = s47(A.output, 300);   // output 동일
      return `Tool: ${A.name}\n  Input: ${Y}\n  Output: ${w}`;  // (추정: 형식)
    }).join("\n\n");
    // ... 별도 LLM 호출 (lastAssistantText + tool 목록 → 짧은 요약) ...
    // 반환값: string (한 줄 요약) 또는 null
  } catch { return null; }
}

function da7(summaryText H, precedingToolUseIds _) {
  return {
    type: "tool_use_summary",
    summary: H,                          // t47 반환 텍스트
    precedingToolUseIds: _,              // 이 요약이 커버한 tool_use id 배열
    uuid: gL.randomUUID(),
    timestamp: new Date().toISOString(),
  };
}
```

추출 노트: `startPostTurnSummary` 의 body는 추출본에서 template literal의 raw newline으로 잘려서 외부에서 끝까지 가시화되지 않는다. 식별 가능한 사실:
- 시그니처 `{tools, signal, isNonInteractiveSession, lastAssistantText}` (확인).
- `tools.length === 0 → null` 빠른 반환 (확인).
- `s47(input, 300)` / `s47(output, 300)` 으로 도구 입출력을 300자 trim (확인).
- caller의 형태로 보아 **string|null Promise** 를 반환 (확인 — `.then(J_ => J_ ? da7(J_, G_) : null).catch(() => null)`).
- 내부 LLM 호출 여부는 본문이 잘려있어 직접 확인은 불가, 다만 `signal`/`isNonInteractiveSession`/`lastAssistantText` 파라미터가 들어오는 점으로 미루어 LLM 호출 가능성 매우 높음 (추정).

callsite (확인, `runTurnLoop` 안 tool batch 종료 직후):

```js
let rH;                                 // pendingPromise carrier
if (X.gates.emitToolUseSummaries
    && _H.length > 0
    && !Z.abortController.signal.aborted
    && !Z.agentId) {

  // 마지막 assistant 메시지의 마지막 text block (사용자한테 가는 한줄)
  const T_ = wH.at(-1);
  let H_;
  if (T_) {
    const J_ = T_.message.content.filter(b_ => b_.type === "text");
    if (J_.length > 0) {
      const b_ = J_.at(-1);
      if (b_ && "text" in b_) H_ = b_.text;
    }
  }

  const G_ = _H.map(J_ => J_.id);  // tool_use ids of this turn

  // (name, input, output) 튜플 빌드
  const M_ = _H.map(J_ => {
    const b_ = JH.find(l_ => l_.type==="user" && Array.isArray(l_.message.content)
                              && l_.message.content.some(p_ =>
                                   p_.type==="tool_result" && p_.tool_use_id===J_.id));
    const B_ = b_?.type==="user" && Array.isArray(b_.message.content)
               ? b_.message.content.find(l_ => l_.type==="tool_result"
                                                && l_.tool_use_id===J_.id)
               : undefined;
    return { name: J_.name, input: J_.input,
             output: B_ && "content" in B_ ? B_.content : null };
  });

  // 비동기 시작 — 절대 await 하지 않음
  rH = t47({ tools:M_, signal:Z.abortController.signal,
             isNonInteractiveSession:Z.options.isNonInteractiveSession,
             lastAssistantText:H_ })
       .then(summary => summary ? da7(summary, G_) : null)
       .catch(() => null);
}
```

다음 턴 시작 시 (확인):

```js
// outer while iteration 초입
const { ..., pendingToolUseSummary:E, ... } = D;
// ... stream 끝나고:
if (E) { let v = await E; if (v) yield v; }
```

핵심: **summary는 그것을 생성한 턴에서는 yield되지 않는다.** 다음 턴의 model stream이 끝난 직후, 그 다음 분기 (no tool_use 또는 reactive compact) 진입 직전에 한 번 yield된다. 즉 사용자/transcript view 입장에서 "도구 묶음 + 다음 어시스턴트 응답" 사이에 요약이 끼어든다.

### 2.5 `awaitPostTurnSummary` — 단순 래퍼 (확인)

```js
function da7(H, _) {
  return {
    type: "tool_use_summary",
    summary: H,
    precedingToolUseIds: _,
    uuid: gL.randomUUID(),
    timestamp: new Date().toISOString(),
  };
}
```

### 2.6 Bq3의 Va7 결과 처리 + Stop block cap 의사코드 (확인)

```js
if (!sawToolUse) {
  // ... PTL/image/max_output_tokens/malformed tool_use 분기들 먼저 ...
  // 마지막에:

  const stopRes = yield* Va7(x /*msgs*/, wH /*collectedAssistant*/,
                              q, K, O, Z, $ /*querySource*/,
                              h /*stopHookActive*/, A /*threadId*/);

  if (stopRes.preventContinuation)
    return { reason: "stop_hook_prevented" };

  if (stopRes.blockingErrors.length > 0) {
    const B_ = I /*stopHookBlockingCount*/ + 1;
    const b_ = C /*turnCount*/ + 1;

    if (Y /*maxTurns*/ && b_ > Y) {
      yield { type:"max_turns_reached", maxTurns:Y, turnCount:b_ };
      d("tengu_stop_hook_block_count",
        { count:B_, is_subagent:Boolean(Z.agentId),
          hit_max_turns:true, hit_cap:false });
      return { reason:"max_turns", turnCount:b_ };
    }

    const l_ = parseInt(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? "", 10);
    const p_ = Number.isNaN(l_) ? 8 : l_;
    if (p_ > 0 && B_ > p_) {
      d("tengu_stop_hook_block_count",
        { count:B_, is_subagent:Boolean(Z.agentId),
          hit_max_turns:false, hit_cap:true });
      yield VO(
        `A hook blocked the turn from ending ${B_} consecutive times — `
        + `overriding and ending turn. For Stop/SubagentStop hooks, check `
        + `stop_hook_active in the input and return success while it's true. `
        + `Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP to raise this limit.`, "warning");
      return { reason:"completed" };
    }

    D = {
      messages: [...x, ...wH, ...stopRes.blockingErrors],
      toolUseContext: Z,
      compactTracking: F,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: k,
      maxOutputTokensOverride: undefined,
      pendingToolUseSummary: undefined,             // ← 클리어
      stopHookActive: true,                         // ← 다음 hook 호출에 알림
      stopHookBlockingCount: B_,
      turnCount: b_,
      transition: { reason: "stop_hook_blocking" },
    };
    continue;
  }

  return { reason: "completed" };
}
```

---

## 3. State / Schema

### 3.1 `active_goal` / `goal_status` 이벤트 (확인)

`/goal <condition>` 슬래시 명령(또는 `QiH(condition, ctx)`)이 실행되면:

```js
QiH(condition H, ctx _) {
  const gate = jy8();                              // hooks/trust 게이트 검사
  if (gate) return gate.message;
  const sessionId = k_();
  // 기존 default-matcher prompt-hook 제거 (단일 활성 goal 보장)
  for (const t of giH(_.getAppState(), sessionId))
    _.sessionHooksRegistry.remove(sessionId, "Stop", t);
  // 새 Stop prompt-hook 추가
  _.sessionHooksRegistry.add(sessionId, "Stop", "", { type:"prompt", prompt:H });
  // appState.activeGoal 설정
  const goal = { condition:H, iterations:0, setAt:Date.now(), tokensAtStart:tf() };
  _.setAppState(s => ({ ...s, activeGoal:goal }));
  _.applyMessageOp({ type:"append", messages:[Wo7(false, H)] });
  d("tengu_stop_hook_added", { promptLength:H.length, via:"goal" });
  EH("goal_set");
  return null;
}
```

`Wo7(met, condition)` 는 attachment 메시지:

```js
{ type:"attachment", uuid, timestamp,
  attachment: { type:"goal_status", met, sentinel:true, condition } }
```

→ transcript에 "goal set" sentinel을 남김 (이후 resume 시 `BQK`/`Fa3` 로 복원).

**Va7에서 평가** (확인):
- Stop hook 묶음 안 prompt-hook들이 `evaluateGoal`에 의해 LLM 평가 → `{ok, reason, impossible?}`.
- `ok === true` → `outcome:"success"` + `hook_success` 메시지 → Va7가 `goalMatcher(x.hook)` 로 매치 확인 → 매치되면:
  - `sessionHooksRegistry.remove` (Stop hook 해제)
  - `yield { type:"active_goal", value:undefined }` (UI 클리어)
  - `yield T9({ type:"goal_status", met:true, condition, reason, iterations, durationMs, tokens })`
  - 텔레메트리 `tengu_goal_achieved` + `EH("goal_met")`
- `ok === false && impossible === true` → 동일 분기지만 `met:false, failed:true`. 텔레메트리 `tengu_goal_failed` + `mH("goal_met","impossible")`.
- `ok === false && !impossible` → `outcome:"blocking"` + `blockingError:{blockingError:"[<prompt>]: <reason>", command:<prompt>}` + `preventContinuation: !Y && !continueOnBlock` (Y=true for Stop) → blockingError 분기:
  - `D6({ content: my8(blockingError), isMeta:true })` 를 Z에 append + yield
  - 매치되면 `yield { type:"active_goal", value:{...goal, iterations+1, lastReason} }` (iteration 카운터만 증가)
  - `yield T9({ type:"goal_status", met:false, condition, reason })`
  - **blockingError로 카운트되어 다음 턴 들어감** → goal이 "한 턴 더 작업"을 강제

| 이벤트 type | yield 시점 | payload |
|---|---|---|
| `active_goal` | goal achieved/failed → `value:undefined` (클리어) <br/> goal not met yet → `value:{condition, iterations:N+1, setAt, tokensAtStart, lastReason}` (갱신) | `{type:"active_goal", value}` |
| `goal_status` | 위 두 분기 모두 | `T9({attachment:{type:"goal_status", met, failed?, sentinel?, condition, reason?, iterations?, durationMs?, tokens?}})` |

Statsig gate: **없음** (확인 — 코드상 `Z_("tengu_...")` 같은 gate 호출 없음). `/goal` 명령 자체가 `jy8` (hooks 비활성/trust) 게이트만 통과하면 동작. 단 brief mode와 무관.

분류기 (LLM 평가) — `evaluateGoal` 안의 `outputFormat: { type:"json_schema", schema:{...{ok,reason,impossible}...} }` 로 구조화. 모델은 `Ta7()?.useSmallFastModel === true` 일 때 작은/빠른 모델 (`PX()`), 아니면 `C7()` (기본 main 모델) 사용 (`$a7`, line 9847 근처 확인). thinking은 `disabled`. 즉 **별도 LLM 호출**.

### 3.2 `post_turn_summary` 이벤트 (확인)

목적: 사용자 UI/SDK consumer가 "이 턴이 끝났을 때 다음에 뭘 보여줘야 하나" 를 알기 위한 메타데이터 (`status_category: blocked|review_ready`, `status_detail: string`, `needs_action: string`).

라이프사이클 (확인):

1. **턴 끝 직전, Va7 진입 시점**:
   - `tX_.detectSurfaces()` → 환경에 따라 surface set 결정 (`bg | watched | ccr | bridge | desktop | cli`). 예: `G7()` (background mode) → `{bg}`. 일반 REPL은 `{cli}`.
   - `tX_.sinksFor(surfaces)` → 각 surface가 받는 sink 매핑. `Pa7 = {bg:[state], watched:[state], ccr:[summary], bridge:[summary], desktop:[summary], cli:[summary]}`. 단 `bg` surface가 있으면 `summary` 제거 (백그라운드 모드는 state만).
   - `tX_.engineFor(sinks)` → `"llm" | "heuristic" | null`. `state` sink가 있으면 llm, 아니면 env `CLAUDE_CODE_CLASSIFIER_SUMMARY` 또는 statsig `tengu_cobalt_wren` (kill switch) 로 결정.

2. **즉시 슬롯 예약** (sinks에 summary가 있을 때만):
   ```
   yield { type:"post_turn_summary", value:null }
   ```
   UI는 이 시점에 "곧 요약이 올거다" 라고 placeholder 표시 가능.

3. **백그라운드 분류기**: `Ra7.classifyAndPush(...).catch(...)` 가 별도 LLM 호출 시작. 결과가 도착하면 `A.onClassified(result, error)` 콜백:
   ```js
   const summary = tX_.classifiedToPostTurnSummary(result)
       // → { status_category: result.state==="blocked" ? "blocked" : "review_ready",
       //     status_detail:   result.detail,
       //     needs_action:    result.state==="blocked" ? result.needs??"" : "" }
   T.setAppState(s => /* dedup by (category,detail) */ ...);
   T.sessionState?.notifyMetadataChanged({ post_turn_summary: summary });
   uL()?.reportMetadata({ post_turn_summary: summary });   // OTEL/telemetry sink
   tv({ type:"system", subtype:"post_turn_summary",
        summarizes_uuid: lastFreshAssistant?.uuid ?? "",
        ...summary });   // transcript 에 system event 로 영구 기록
   ```

4. **`bg` 또는 `sdk` 모드 한정 동기 대기**: `await Promise.race([job, sleep(60000).unref()])` — 분류 결과를 최대 60s 기다림 (background dispatch는 결과가 필요).

5. **REPL CLI 모드** (`Ga7()` 반환 false): `isPostTurnSummaryVisibleInCli()` 가 false 이므로 sink는 있어도 UI에 보이진 않음. 그러나 sessionState 와 system event 는 기록됨.

`active_goal` 슬롯 예약과 달리 `post_turn_summary` 는 **값이 비동기로 채워진다** — Bq3가 다음 턴 시작 직후 또는 종료 직후에 실제 값을 yield 하지 않는다. UI는 `T.sessionState` 의 `notifyMetadataChanged` 또는 `tv` system event 를 직접 구독.

### 3.3 PostToolBatch 이벤트 정리 (확인)

- 페이로드: `{ ...baseHookInput, hook_event_name:"PostToolBatch", tool_calls: Array<{tool_name, tool_input, tool_use_id, tool_response?}> }`.
- 트램폴린: `runPostToolBatchHook` ([`18821`](../../extracted-functions.js#L18821)).
- 출력 처리는 `coreHookEngine` 일반 엔진:
  - `g.message` → `hook_progress` / `hook_success` / `hook_blocking_error` / `hook_non_blocking_error` / `hook_error_during_execution` / `hook_cancelled` — Bq3는 `hook_blocking_error` 이외 message는 그대로 yield.
  - `g.additionalContexts: string[]` → `hook_additional_context` attachment 로 변환 → yield + **`JH`(next-turn messages)에 push** (모델이 다음 호출에서 봄).
  - `g.blockingError: { blockingError, command }` → `G_=true`, `M_ ??= blockingError`. 의식: hook이 "이 턴 끝내라"고 신호. 단순히 다음 model 호출 안 함.
  - `g.preventContinuation: true` → 동일 처리 (`G_=true`, `M_ ??= stopReason`).

`hookSpecificOutput.hookEventName === "PostToolBatch"` 지원 필드: `additionalContext`. `decision:"block"` → blockingError → 위 G_ 경로.

**Stop 과의 차이** (확인):
| 항목 | Stop blockingError | PostToolBatch blockingError |
|---|---|---|
| Bq3 반응 | 메시지를 다음 턴 `D.messages` 에 append, `continue` | `yield hook_stopped_continuation` + `return { reason:"hook_stopped" }` |
| Retry | 가능 (cap 까지) | 없음 — 즉시 종료 |
| 페이로드 self-aware flag | `stop_hook_active` 있음 | 없음 |
| 다음 model 호출 | O (한 턴 더) | X |
| 종료 reason | (cap 초과 시만) `completed`/`max_turns` | `hook_stopped` |

### 3.4 `hook_stopped_continuation` vs `stop_hook_prevented` (확인)

| 신호 | 누가 발생 | Bq3 종료 reason |
|---|---|---|
| `attachment.type === "hook_stopped_continuation"` (tool stream) | PreToolUse hook의 `preventContinuation`, PostToolUse hook의 `preventContinuation`, 또는 그 외 tool dispatcher 안에서 hook이 `preventContinuation:true` 신호 | `hook_stopped` |
| `attachment.type === "hook_stopped_continuation"` (PostToolBatch loop) | PostToolBatch hook의 `blockingError` 또는 `preventContinuation` | `hook_stopped` |
| Va7 의 `preventContinuation:true` | Stop / SubagentStop / TaskCompleted / TeammateIdle hook의 `preventContinuation:true` (`Up3`/`evaluateGoal`/`d26` 등 모두 가능) | `stop_hook_prevented` |
| Stop blockingError 누적 + cap 초과 | Stop hook이 cap 회 연속 blocking | `completed` (경고 yield 후) |

차이의 의미:
- `hook_stopped`: 도구 실행 도중 또는 직후 hook 이 "이 도구 결과를 모델에게 안 보여줘"를 결정 → 다음 model 호출 자체를 막음. **`hookStopped`/`hookDeferred` 가 둘 다 messages는 그대로 유지** (이미 yield된 결과는 transcript에 있음).
- `stop_hook_prevented`: 모델이 turn을 끝내려 했는데 Stop hook이 "안 돼" 라고 함. 다음 model 호출 안 하고 종료 — 사용자 시점에서 "Stop hook이 막아서 멈췄음".

### 3.5 Stop block cap interplay (확인)

호출 사이클:

```
turn N:   stopHookActive = false (또는 carry over)
          Stop hook fires with payload {...stop_hook_active: false, ...}
          hook returns block → blockingErrors.length > 0
          Bq3: B_ = stopHookBlockingCount + 1 = 1
              D.stopHookActive = true, D.stopHookBlockingCount = 1
              continue

turn N+1: stopHookActive = true (carried)
          페이로드: {...stop_hook_active: true, ...}
          hook이 이걸 보고 "ah, 사용자가 retry 한 거지 — 통과시키자" → block 안 함
          Stop hook 성공 → return completed

(만약 hook 이 stop_hook_active 를 무시하고 또 block):
turn N+1: Stop hook block 또 발생 → B_ = 2
          D.stopHookActive = true (변화 없음), D.stopHookBlockingCount = 2
          continue
turn N+2 ...
          ...
turn N+8: B_ = 8, p_ = 8, cap 비교 B_ > p_? (8 > 8) 거짓 → 진행
turn N+9: B_ = 9, cap 비교 (9 > 8) 참
          → yield VO("A hook blocked the turn from ending 9 consecutive times — overriding ...", "warning")
          → return { reason:"completed" }
```

- 환경변수 파싱: `p_ = Number.isNaN(parseInt(env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? "", 10)) ? 8 : <parsed>`.
- `p_ === 0` 또는 음수 → cap 비활성 (무한 허용). `if (p_ > 0 && B_ > p_)` 조건이 false.
- `B_ > p_` 라서 정확히 N+9번째에 종료 (cap=8 기준).
- 정상 진행/다음 턴/recovery 진입 시 `D.stopHookBlockingCount = 0` 으로 리셋 — **연속 blocking 만 카운트**. tool_use 가 끼면 카운터 0.
- `D.stopHookActive: true` 는 reset 안 됨 — Bq3 진입 시 `H.stopHookActive ?? false` 에서 carry over. 정상 `next_turn` 분기에서도 carry 유지 (즉 한 번 active 되면 세션 끝까지 true 유지) → 의식: "이 세션은 한 번 Stop을 retry 한 적이 있음" 표시. (확인: `stopHookActive: stopHookActive` 형태로 모든 분기에서 같은 값 유지.)

텔레메트리 `tengu_stop_hook_block_count`:
- `{ count:B_, is_subagent:Boolean(agentId), hit_max_turns:bool, hit_cap:bool }`.
- max_turns에 먼저 걸리면 `hit_max_turns:true`, 그 외 cap에 걸리면 `hit_cap:true`. 정상 retry는 텔레메트리 발사 X.

### 3.6 `blockingErrors` 메시지 구조 (확인)

`runStopHooks` 가 누적하고 반환하는 `blockingErrors: Message[]` 각 원소는 `makeToolResultMessage`(...)의 결과 — **user 메시지**:

```js
D6({ content: my8(x.blockingError), isMeta: true })
// 즉:
{
  type: "user",
  message: { role: "user", content: my8(x.blockingError) /* string */ },
  isMeta: true,
  uuid: <random>,
  timestamp: <iso>,
  // 나머지 D6 옵셔널 필드 (isVisibleInTranscriptOnly, isVirtual, ...) 는 undefined
}
```

`my8(blockingError)` = `` `Stop hook feedback:\n${blockingError.blockingError}` `` — 즉 "Stop hook feedback:" prefix + hook이 반환한 deny reason. 모델은 이 메시지를 user input으로 보고 → 다음 턴에서 그 피드백에 답하는 형태로 행동.

**복수 errors**: 여러 hook이 동시에 block 하면 각각의 D6 메시지가 Z에 push 되고 `blockingErrors`로 반환되어 모두 next-turn messages에 append. 모델은 모든 피드백을 한꺼번에 봄.

요청서의 질문에 대한 답: **shape는 `makeToolResultMessage` 빌더 결과이며 attachment가 아니라 일반 user(meta) 메시지** — `{type:"user", message:{role:"user", content:"Stop hook feedback:\n..."}, isMeta:true, uuid, timestamp, ...}`. attachment 형식이 아님 (PostToolBatch 의 `hook_stopped_continuation` 과 다름).

### 3.7 `hook_deferred_tool` from Bq3 perspective (확인)

tool stream(`TH.getRemainingResults()` 또는 `Hj_(...)`) 안에서:

```js
for await (const t of toolStream) {
  if (dm(t)) { yield t; continue; }
  if (t.message) {
    yield t.message;
    if (t.message.type==="attachment"
        && t.message.attachment.type==="hook_deferred_tool")
      yH = true;     // hookDeferred
    if (t.message.type==="attachment"
        && t.message.attachment.type==="hook_stopped_continuation")
      NH = true;     // hookStopped
    if (!_P_(t.message)) {
      // tool 결과 user 메시지들을 JH (next-turn messages) 에 누적
      const refresh = i0([t.message], dH.options.refreshTools?.()??dH.options.tools, model);
      y$_(refresh, model.maxBase64Size);
      JH.push(...refresh.filter(x => x.type==="user"));
    }
  }
  if (t.newContext) dH = { ...t.newContext, queryTracking:p };
}
// ...
if (yH) return mJH(dH, z), { reason: "tool_deferred" };
if (NH) return mJH(dH, z), { reason: "hook_stopped" };
```

발생 원인: PreToolUse hook 이 `permissionDecision:"defer"` 를 반환 + non-interactive (print-mode) + 같은 assistant 메시지의 tool_use 개수 1개 (orphan 방지). 자세한 발사 로직은 [hook-system.md §5.1](./hook-system.md#5-특수-동작).

Bq3 입장에서는 "이 도구를 지금 실행하지 말고 permission flow로 보류해 둠 — 사용자가 승인하면 resume" 신호. 종료 reason `tool_deferred` 로 caller (REPL 또는 SDK) 에게 알림 + `mJH(dH, z)` 호출로 분류기 상태를 `markTurnAborted` (재개를 위한 정리).

### 3.8 yield 프로토콜 (이 문서 범위) — 보강 (확인)

agent-loop.md §4 의 표에 더해, Stop/PostToolBatch 경로에서만 발생하는 이벤트들:

| `type` | 발생 시점 | 페이로드 |
|---|---|---|
| `post_turn_summary` (placeholder) | Va7 진입 직후 `sinks.has("summary")` 일 때 | `{type:"post_turn_summary", value:null}` |
| (없음 — 실제 summary는 system event/메타데이터로만) | onClassified 콜백 발사 | `tv({type:"system", subtype:"post_turn_summary", summarizes_uuid, status_category, status_detail, needs_action})` (transcript 기록) |
| `active_goal` | goal hook 평가 결과 시 | clear: `{value:undefined}` / not-met yet: `{value:{condition, iterations, setAt, tokensAtStart, lastReason}}` |
| attachment `goal_status` | goal 평가 끝 (또는 한 단계 진행) | `T9({type:"goal_status", met, failed?, sentinel?, condition, reason?, iterations?, durationMs?, tokens?})` |
| system `stop_hook_summary` | Stop hook progress count > 0 | `va7(count, hookInfos, errors, preventedContinuation, stopReason, hasOutput, "suggestion", lastToolUseID, hookLabel, totalDurationMs)` |
| attachment `hook_stopped_continuation` (Stop/PostToolBatch) | preventContinuation 발생 | `T9({type:"hook_stopped_continuation", message:stopReason, hookName, toolUseID, hookEvent})` |
| attachment `hook_additional_context` (PostToolBatch) | additionalContexts 누적 | `T9({type:"hook_additional_context", content, hookName:"PostToolBatch", toolUseID, hookEvent:"PostToolBatch"})` — yield + `JH.push` |
| user(meta) `Stop hook feedback:` | Va7 blockingError | `D6({content:my8(blockingError), isMeta:true})` |
| warning notification | Stop cap 초과 | `VO("A hook blocked the turn from ending N consecutive times — overriding...", "warning")` |
| `tool_use_summary` (다음 턴 초입) | t47 → da7 결과 도착 | `{type:"tool_use_summary", summary, precedingToolUseIds, uuid, timestamp}` |

---

## 4. 차이점 (v0.2.8 → v2.1.143)

v0.2.8 에는:
- Stop/SubagentStop hook 자체가 없었다.
- PostToolBatch hook 자체가 없었다.
- post_turn_summary / active_goal / goal_status 이벤트 자체가 없었다.
- 분류기(`Ra7`) 가 없어 background dispatch / status detection 도 없었다.
- `startPostTurnSummary` 식 tool-use-summary 도 없었다. UI는 tool_result 를 그대로 표시.
- coordinator/multi-agent 모드(`KO()`) 가 없어 TaskCompleted/TeammateIdle hook 발사도 없었다.
- brief mode sentinel 강제 주입 같은 "다음 턴 nudge" 메커니즘이 없었다.
- recovery는 사용자가 직접 prompt 재입력하는 식. retry/cap 개념도 없었다.

v2.1.143 의 이 영역 도입은 다음 패턴들을 가능하게 함 (확인 + 일부 추정):

1. **"턴 종료 의사결정의 외부화"** — Stop hook은 자동화 사용자가 "끝나기 전에 LLM이 만족시켰는지 다시 검증해라" 같은 정책을 inject 가능. `/goal` 슬래시 명령이 그 직접적 활용 — 단일-prompt-hook 으로 "조건 만족 시까지 자동 retry" 만들기.

2. **무한 루프 방지** — `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (기본 8) + payload self-aware flag (`stop_hook_active`). hook이 무작정 block만 하면 cap 후 강제 종료 + 명시적 경고로 사용자에게 알림. **재시도 카운트는 같은 활성 hook chain만 셈** — 도중에 tool_use 한 번 끼면 0으로 리셋.

3. **백그라운드 상태 분류** — `post_turn_summary` 가 cli surface에선 안 보이지만 (`Ga7() === false`), `bridge`/`desktop`/`ccr` 같은 외부 통합 surface 에선 `notifyMetadataChanged` 로 호스트가 받음. 즉 "이 사용자가 다음에 뭘 해야 하는지" (blocked vs review_ready) 를 자동화 도구가 알 수 있도록.

4. **PostToolBatch — 도구 묶음 후 정리** — 한 턴의 모든 tool 결과가 모인 뒤 한 번만 발사. **개별 PostToolUse 와 달리 tool들 간 cross-cutting analysis 가 가능** (예: "이번 턴에 Bash + Edit + Bash 가 같이 갔는데 빌드 끊긴 거 아닌지 확인"). additionalContext는 다음 model 호출의 input에 들어가서 모델이 자동으로 그 시그널을 봄.

5. **`tool_use_summary` 의 사용자-UX 효과** — 도구가 30번 돌고 결과가 길어진 턴을 사용자가 transcript 에서 스크롤하면, 다음 턴 시작 시 짧은 한 줄짜리 요약이 끼어들어 "직전 턴 무슨 일이 있었나" 빠르게 인식 가능. **다음 턴에 yield 하는 이유**: 같은 턴에 yield하면 latency 가 도구 결과를 막아서 사용자 경험 저해 — 백그라운드로 LLM에 요약 시키고 결과는 다음 턴 도착 후 끼워넣는 패턴.

6. **goal evaluation 의 deferred semantics (추정 + 확인)** — `runStopHooks` 가 background tasks (`eX_(tasks) || nY6(tasks)`) 진행 중이면 goal hook을 일시적으로 sessionHooksRegistry에서 빼고 finally 에서 복원. 의식: 모델이 task tool을 실행해서 background work이 도는 중에는 "조건 만족했나" 평가가 무의미 (작업이 안 끝났으므로). 작업 완료 후 다음 턴에서 평가.

### 확인 / 추정 정리

- **확인**:
  - `runStopHooks` 전체 흐름 (post_turn_summary 분류기, brief mode, goal deferral, x4H stream 소비, coordinator mode 분기, finally goal hook 복원).
  - `runPostToolBatchHook` PostToolBatch 트램폴린 시그니처와 본문 — `coreHookEngine` 일반 엔진 위임.
  - Stop / SubagentStop 페이로드 — `agentId` 분기로 SubagentStop, `stop_hook_active: K` 항상 포함.
  - Stop block cap parse: `parseInt(env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? "", 10)` → `Number.isNaN(.) ? 8 : .`. 0/음수 → 비활성.
  - blockingErrors 메시지는 `D6({content:my8(error), isMeta:true})` user 메시지 (attachment 아님).
  - `hook_deferred_tool` / `hook_stopped_continuation` tool stream 분기 → `tool_deferred` / `hook_stopped` 종료.
  - PostToolBatch blockingError → `hook_stopped`, retry 없음 (Stop과 차이).
  - `pendingToolUseSummary` 는 next turn 초입에 await + yield (1회 소비).
  - `active_goal` / `goal_status` 이벤트는 Va7 goal-match 분기에서만 발사. Statsig gate 없음.
  - prompt-hook 평가기 `evaluateGoal` 는 별도 LLM 호출 (json_schema 강제, thinking disabled, small/fast model 옵션).

- **추정 / 불완전 추출**:
  - `startPostTurnSummary` 본문 — template literal raw newline 으로 추출본이 잘려 정확한 LLM 호출 형태와 prompt가 가시화되지 않음. 시그니처와 반환 형태(string|null Promise) 는 확인.
  - `dispatchStopHook` 본문 — 같은 문제. 시그니처는 callsite 와 페이로드 빌드 코드 fragment 로부터 재구성 (위 §2.2). `last_assistant_message` 추출 헬퍼 정확한 이름 (`Pa_` 류) 은 추정.
  - `Ra7.classifyAndPush` 내부 — 별도 LLM call 인지 heuristic 인지는 `engine = "llm"|"heuristic"` 분기에 따라 다름. `engineFor` 결정 로직은 확인.
  - background dispatch 60s wait 의 정확한 발사 surface (G7() || $==="sdk") — 코드 확인.
  - `Setup.trigger="maintenance"` 가 이 영역과 무관 — hook-system.md 의 추정 그대로.

---

**식별자 표** (이 문서 신규):

| ID | 역할 |
|---|---|
| `runStopHooks` | Stop hook + 부가 처리 결합 generator |
| `dispatchStopHook` | Stop / SubagentStop 페이로드 빌더 |
| `runPostToolBatchHook` | PostToolBatch 트램폴린 |
| `startPostTurnSummary` | tool-use-summary LLM caller |
| `awaitPostTurnSummary` | summary → `tool_use_summary` 메시지 wrapper |
| `Ra7` | 분류기 (Iy8 모듈) — captureLatestAsk/classifyAndPush |
| `tX_` | post_turn_summary surface/sink/engine 라우터 (xy8 모듈) |
| `Pa7` | surface→sink 매핑 상수 (`{cli:[summary], bg:[state], ...}`) |
| `La7` | brief-mode 토글 |
| `Cq3` | `classifiedToPostTurnSummary` — 분류기 결과 → `{status_category, status_detail, needs_action}` |
| `giH` | matcher 없는 Stop prompt-hook 모음 lookup |
| `N$6` | hook 정의 동등성 비교 |
| `evaluateGoal` | prompt-hook LLM 평가기 (`{ok,reason,impossible?}` json_schema) |
| `aZ_` | UhK 결과 Zod schema |
| `BQK` / `Fa3` | resume 시 transcript 에서 active goal 복원 |
| `Wo7` | goal sentinel attachment 빌더 |
| `QiH` / `diH` | `/goal set` / `/goal clear` 명령 진입점 |
| `jy8` | goal 설정 게이트 (hooks/trust 검사) |
| `va7` (소문자 v) | `stop_hook_summary` system event factory |
| `my8` | Stop hook feedback 메시지 포맷터 |
| `py8` | TeammateIdle hook feedback 메시지 포맷터 |
| `SX_` | TaskCompleted hook feedback 메시지 포맷터 |
| `eX_` | task registry: in_progress 멤버 있나? |
| `nY6` | task registry: local_bash 진행중? |
| `KO` | coordinator/multi-agent 모드 판별 |
| `dVH` | `TaskCompleted` 트램폴린 |
| `HP_` | `TeammateIdle` 트램폴린 |
| `EX_` | `TaskCreated` 트램폴린 |
| `Z7H` | querySource 분류 (main vs sub thread) |
| `eRH` | computer-use MCP cleanup (Va7 진입 시 fire-and-forget) |
| `abortCleanup` | 분류기 `markTurnAborted` 디스패처 |
| `interruptMessage` | "interrupted by user" meta user message factory |
| `bV` / `Ty` | task registry 헬퍼 (coordinator mode 안에서 사용) |
| `RO` / `q3` | 현재 teammate_name / team_name lookup |
| `lookupStopSessionHook` | sessionHooks Stop 이벤트 lookup |
| `tf` | 현재 turn token usage 합산 |
| `tv` | system event emit (transcript 기록) |
| `uL` | OTEL meter (reportMetadata 안에서) |
