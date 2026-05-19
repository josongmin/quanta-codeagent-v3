# Plan Mode

`permissionMode` 6종 중 하나로, 모델이 코드를 짜기 전에 **계획만 세우도록 강제**하는 모드. write 계열 도구는 `behavior:"ask"`로 떨어지면서 `decisionReason:{type:"mode", mode:"plan"}`이 붙어 user 승인 흐름을 강제로 끌어낸다. Shift+Tab으로 토글, 또는 `EnterPlanMode` 도구로 진입.

## 호출 그래프

진입:

```
사용자 Shift+Tab / `/plan` 슬래시 커맨드 / EnterPlanMode tool
    └─ ctx.setToolPermissionContext (mode="plan", prePlanMode 보존)
    └─ Bq3 turn loop에서 mode 변화를 transition로 흘려보냄
        └─ iZ({permissionMode, mainLoopModel, exceeds200kTokens})   # 모델 선택
            └─ va()==="opusplan" && _==="plan" && !K → rk()         # opus47 / opus 환경변수
            └─ va()==="haiku"    && _==="plan" → ok()                # sonnet46 / sonnet 환경변수
```

write 도구 실행 시 (예: `Edit`의 `kVH(...)`, `Bash`/`PowerShell`의 `Y43(...)`):

```
tool.checkPermissions(input, ctx)
    └─ if (ctx.mode === "plan") return { behavior:"ask",
                                          message:"Cannot write to ${O} while in plan mode.",
                                          decisionReason:{type:"mode", mode:"plan"} }
        └─ AM (line 15449): T.behavior==="ask" && H9K(T.decisionReason)
            └─ tool.requiresUserInteraction() ? exit-plan-mode dialog : 동일 dialog
```

종료:

```
ExitPlanMode tool
    └─ checkPermissions → behavior:"ask", message:"Exit plan mode?"
    └─ call: ctx 변경 (mode → prePlanMode??"default")
            xB(true)  # plan mode session-exit flag
            Zo(true)
            E7H({from:"plan", to:M, trigger:"exit_plan_mode"})  # 텔레메트리
            agent context에서는 plan 파일에서 plan을 읽어 결과로 반환
```

200k 컨텍스트 분기:

```
Bq3 (line 14057)
    iZ({ permissionMode: jH,
         mainLoopModel: Z.options.mainLoopModel,
         exceeds200kTokens: jH==="plan" && Y_6(x) })
```

`Y_6(H)` (line 8506): assistant 메시지의 마지막 token count > 200000이면 true.

## 핵심 로직

### 모델 선택 (`iZ`)

```js
function iZ({permissionMode, mainLoopModel, exceeds200kTokens=false}) {
  if (va()==="opusplan" && permissionMode==="plan" && !exceeds200kTokens) return rk();  // opus47
  if (va()==="haiku"    && permissionMode==="plan") return ok();                          // sonnet46
  return mainLoopModel;
}
```

- `va()` — 활성 model alias 조회 (env / settings / CLI 인자 통합).
- `rk()` — `process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? Y$().opus47` (또는 `Y$()[ya]`).
- `ok()` — `process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? Y$().sonnet46` (또는 `Y$()[ha]`).
- 200k 초과 시 opusplan은 fallback (mainLoopModel 유지) — opus의 200k context 한계 회피로 **추정**.

### `Y_6` (200k 토큰 체크)

```js
function Y_6(H) {
  let q = H.findLast((O) => O.type === "assistant");
  if (!q) return false;
  let K = wYH(q);                       // usage 추출
  return K ? cz_(K) > 200000 : false;    // input+output+cache token 합
}
```

마지막 assistant 메시지의 누적 토큰만 본다. 매 턴 평가됨.

### `EnterPlanMode` (`EnterPlanMode`, line 13759)

- name: `eAH` (= `"EnterPlanMode"`)
- inputSchema: `y.strictObject({})` — 인자 없음
- outputSchema: `{ message: string }`
- `isReadOnly()` → `true`, `isConcurrencySafe()` → `true`, `shouldDefer:true`
- subagent context (`_.agentId`)에서는 사용 금지 — throw

```js
async call(H, _) {
  if (_.agentId) throw Error("EnterPlanMode tool cannot be used in agent contexts");
  Go(_.getToolPermissionContext().mode, "plan");
  _.setToolPermissionContext((q) => FT(gVH(q), {type:"setMode", mode:"plan", destination:"session"}));
  return { data: { message: "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach." } };
}
```

`gVH(q)`는 plan 진입 직전 mode를 `prePlanMode`로 보존하는 헬퍼로 **추정** (변경 후 ExitPlanMode가 복구).

### `ExitPlanMode` (`ExitPlanMode`, line 13694)

- name: `mR` (= `"ExitPlanMode"`)
- inputSchema (`Ul7`):
  ```
  { allowedPrompts?: Array<{tool: "Bash", prompt: string}> }
  ```
  + `normalizeToolInput` 단계에서 disk에서 `plan`, `planFilePath` 두 필드를 주입 (`H$A`).
- outputSchema (`dH3`):
  ```
  { plan: string|null, isAgent: boolean,
    filePath?: string, hasTaskTool?: boolean,
    planWasEdited?: boolean, awaitingLeaderApproval?: boolean,
    requestId?: string }
  ```
- `validateInput`: 현재 mode가 `plan`이 아니면 `tengu_exit_plan_mode_called_outside_plan` 텔레메트리 + 에러 반환.
- `checkPermissions`: 항상 `behavior:"ask", message:"Exit plan mode?"`. KO() (teammate context)면 silent allow.
- `call`:
  1. 입력 `plan`이 있으면 plan 파일에 fs/promises로 write.
  2. teammate context (`KO() && UK_()`)면 team-lead에게 `plan_approval_request` 메시지 큐잉 + return `awaitingLeaderApproval:true`.
  3. 일반: `prePlanMode`로 복귀. `auto`였으면 auto-mode gate 확인 후 fallback, 위험 권한 strip/restore.
  4. `agent` 컨텍스트 추적 (`isAgent`), `hasTaskTool` (Task/Agent 도구 enable 여부) 반환.

### plan mode 시 도구 차단 (`H9K` + `resolvePermissionDecision`)

`H9K` (line 15410): plan mode floor check 도우미.
```js
function H9K(H) { return H?.type==="mode" && H.mode==="plan"; }
```

`resolvePermissionDecision` (permission orchestrator, line 15449)에서:
```js
if (z.mode === "auto" || z.mode === "plan" && (e$3?.isAutoModeActive() ?? false)) {
  let Y = gQ(T.decisionReason, (G) => !G.classifierApprovable),
      w = T.decisionReason?.type === "sandboxOverride",
      j = DJ6(T.decisionReason),
      J = H.mcpInfo?.effectiveMaxPermission === "ask",
      D = H9K(T.decisionReason);
  if (Y || w || j || J || D) {
    if (z.shouldAvoidPermissionPrompts) return { behavior:"deny", ... };
    if (Y || j || J || D) d("tengu_auto_mode_fallback_to_ask", { reason: ..."plan_mode_floor"... }), return T;
  }
}
```

즉, plan 결정 사유는 auto-mode classifier로 우회할 수 없다 (`plan_mode_floor` 이름의 fallback).

각 write 도구의 `checkPermissions`가 mode==="plan"을 직접 체크하는 위치 (확인된 곳):
- `kVH` (Edit/Write, line 18728): write 경로 검증 후 `q.mode==="plan"`이면 `{behavior:"ask", decisionReason:{type:"mode", mode:"plan"}}` 반환.
- `Y43` (PowerShell cmd, line 14579): write/create operation + mode==="plan" → suggestions에 `setMode → acceptEdits` 포함.
- `Fj7` (Bash 변형, line 10691): 동일 패턴.
- `oZ_` (suggestions builder, line 10801): plan mode + 기본 prePlanMode면 suggestions에 `setMode → acceptEdits` 포함시켜 user가 한 번에 빠져나올 수 있게 함.

### read 계열 도구는 그대로

`mR8` (도구 enable 필터, line 12434):
```js
function mR8({tools, isBuiltIn, isAsync=false, permissionMode}) {
  return tools.filter((O) => {
    if (RG(O)) return true;                  // mcp 도구는 통과
    if (P1(O, mR) && permissionMode==="plan") return true;  // ExitPlanMode 자체
    if (KYH.has(O.name)) return false;       // 일부 도구 항상 disable
    if (!isBuiltIn && yz8.has(O.name)) return false;
    if (isAsync && !nH6.has(O.name)) {
      if (K7() && X0()) {
        if (P1(O, J7)) return true;          // Agent (Task)
        if (En9.has(O.name)) return true;
      }
      return false;
    }
    return true;
  });
}
```

즉 plan mode에서 도구 enable list 자체는 거의 변하지 않는다. 차단은 **권한 단계 (`checkPermissions`)**에서 도구가 스스로 처리. 결과적으로 통과되는 read-only 도구: Read, Glob, Grep, WebFetch, WebSearch, Bash(read-only command), Agent, Task 류, NotebookEdit의 read 경로 등.

쓰기/실행 도구 (Edit, Write, Bash write/exec, NotebookEdit write, MCP write tool 등)는 `checkPermissions`에서 ask로 떨어진다. user가 거절하면 deny, 승인하면 plan mode 해제하지 않고 1회만 실행되지 **않고** 표준 흐름상 plan mode가 권한을 통과시키는 일은 거의 없다 — Edit `kVH` 분기에서 `q.mode==="plan"`이 별도 가지로 분리되어 무조건 ask 처리.

## State / Schema

### `permissionModeEnum` permission mode enum (line 9615)

```js
y.enum(["default","acceptEdits","bypassPermissions","plan","dontAsk","auto"])
```

### `yjq.plan` mode config (line 3565)

```js
plan: {
  title: "Plan Mode",
  shortTitle: "Plan",
  symbol: FC_,         // "⏸" (⏸ pause)
  color: "planMode",
  external: "plan",
}
```

`FC_` 상수 정의 (line 3556): `FC_ = "⏸"`. UI에서 status bar 상단/하단 표시용.

### plan 파일 경로

- `mG(_.agentId)` — agent 별 plan 파일 경로. 확인 필요 (helper 별도 분석 안 함).
- `uG(_.agentId)` — plan 내용 읽기.
- 사용자는 `Ctrl+G`로 외부 에디터에서 plan 직접 편집 가능 (line 20034 `tengu_plan_external_editor_used`).

### `prePlanMode` 보존 필드

plan 진입 시 `toolPermissionContext.prePlanMode = 직전 mode` 저장 → ExitPlanMode에서 `mode = prePlanMode ?? "default"`로 복원, `prePlanMode = void 0`로 클리어. `auto` 모드였다면 gate 재확인 후 fallback.

### auto-mode와 plan mode 상호작용

- `auto` 모드에서 plan으로 진입하면 `prePlanMode = "auto"`로 저장.
- ExitPlanMode 시 `$?.isAutoModeGateEnabled() === false` (circuit breaker 등)이면 `default`로 fallback 후 notification 발송 (`auto-mode-gate-plan-exit-fallback`).
- 위험 권한(dangerous)은 plan 진입 시 strip된 적이 있으면 `strippedDangerousRules` flag 보존, exit 시 `restoreDangerousPermissions` 호출.

### MX8 prompt suggestion 게이트 (line 10766)

plan mode에서는 prompt 추천 disabled — `MX8`가 `"plan_mode"` 반환.

### telemetry events

- `tengu_plan_external_editor_used` — Ctrl+G로 plan 편집.
- `tengu_plan_exit` — Exit 시 결과 (`outcome:"yes"|"no"|"yes-accept-edits"|"yes-accept-edits-keep-context"`).
- `tengu_exit_plan_mode_called_outside_plan` — 잘못된 호출.
- `tengu_auto_mode_fallback_to_ask` (reason: `"plan_mode_floor"`) — plan 결정 사유가 auto-mode classifier를 거치지 않고 ask로 떨어짐.

## 차이점 (v0.2.8 대비)

- v0.2.8: plan mode는 4 mode 중 하나로 단순히 write tool을 차단. 별도 EnterPlanMode/ExitPlanMode 도구는 없었고 슬래시 명령으로만 전환.
- v2.1.143:
  - 도구화: `EnterPlanMode` / `ExitPlanMode`가 정식 도구로 등록 — 모델이 자율적으로 plan으로 진입/탈출.
  - `prePlanMode` 보존: 진입 직전 mode를 기억해 exit 시 복원. `auto` 모드와의 연동.
  - `opusplan`: opus 모델 + plan 모드 시 자동으로 opus47 swap (200k 미만일 때만). 큰 컨텍스트는 sonnet/mainLoop로 fallback.
  - plan 파일 디스크 영속: agent 별로 plan을 파일에 저장 → CCR web UI / `Ctrl+G` 외부 에디터 편집.
  - teammate plan approval 워크플로우: teammate가 ExitPlanMode 호출 → team-lead 에이전트에게 `plan_approval_request` 메시지 큐잉, 응답을 기다림.
  - `plan_mode_floor`: auto-mode classifier가 plan 결정 사유를 우회 못함 (별도 floor).
