# ADR-0534: session_config — agent self-visibility tool (effort tier / identity mode / tool profile / model)

- **상태**: Accepted (fully wired; CLI composition root, dispatch seam, BASE_TOOL_NAMES)
- **날짜**: 2026-06-15
- **슬라이스**: `src/tool/session_config.ts`
- **출처**: RFC §3.1 — agent self-visibility gap ("지금 thinking 모드 몇이고?")

## Context

에이전트가 자신의 현재 SDK posture를 알 방법이 없었다. 사용자가 "/effort high로 했는데 실제로 high 맞아?"를 물어도 에이전트는 답할 수 없었고, effort 조정도 슬래시 커맨드(/effort)가 유일한 경로였다.

## Decision

`session_config` 도구를 BASE_TOOL_NAMES에 등록(항상 사용 가능). 두 개의 op로 구성:

- **`op:get`** — effort tier(+ token budget), identity mode, tool profile, model id, provider를 plain-text 스냅샷으로 반환. 읽기 전용.
- **`op:set_effort`** — effort tier를 변경. `/effort` 슬래시 커맨드와 동일한 EffortStore 경유. 다음 턴부터 적용.

### 슬라이스 격리

`@/tool` 슬라이스 fence: zod + `./types` + `@/shared/errMessage`만 임포트. `@/agent` 임포트 없음. EffortLevel 리터럴을 closed zod enum으로 복제(cross-import 방지, 리터럴 안정성은 parity-test가 강제).

### 시맨틱

- **no-throw 보장**: 모든 실패(seam 미배선 / 읽기 오류 / 쓰기 오류 / abort)는 `ok:false` + typed reason으로 반환. 절대 throw하지 않음.
- **not_wired 경로**: 호스트가 `sessionConfigPort`를 배선하지 않으면 모든 op가 `ok:false, reason:"not_wired"` — 기존 동작과 byte-identical.
- **MUTATING 선언**: plan-mode에서 dispatch가 `set_effort`를 차단(plan-posture에서는 `/effort` 사용).

### 배선

```
AgentConfig.sessionConfigPort
  → buildToolContext (agent/dispatch.ts)
    → ToolContext.sessionConfig
      → session_config.ts execute()
```

호스트(CLI bootstrap-session.ts)가 effortStore + identityModeState + toolProfileState + model/provider로 port를 구성.

## 테스트

- `tests/unit/tool/session-config.test.ts` — 도구 팩토리 직접 단위 테스트
- `tests/unit/tool/session-config-dispatch.integration.test.ts` — 실 dispatch 경로 통합 테스트
- `tests/unit/tool/session-config-tool-hellgate.test.ts` — 합성 경로 + gate-OFF + 적대 케이스

## 다음 (follow-up)

- web 호스트 sessionConfigPort 배선 (현재 duck-typed seam, port-absent = typed not_wired)
