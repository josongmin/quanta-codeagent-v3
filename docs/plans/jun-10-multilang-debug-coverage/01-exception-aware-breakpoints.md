# T-01 — Exception-aware breakpoint (break-on-throw)

- **상태**: OPEN. 우선순위 1 (백로그 중 최고 SOTA).
- **충돌주의**: `src/tool/debug/inspect-driver.ts`(DAP) + `cdp-inspect.ts`(CDP)는 동시 세션이 silent-failure 어딧 중 → 그들 안정화 후 착수 or 사전 조율.

## 기능 / 왜 / ROI
- **(기능)** 실패가 **예외/패닉**일 때 line-bp 대신 **throw 지점에서 정지**하고 예외 type+message를 evidence에 담는다. DAP `setExceptionBreakpoints`+`exceptionInfo`, CDP `Debugger.setPauseOnExceptions`+paused(reason:"exception",data).
- **(왜)** 현재 runtime은 `failure.file && failure.line`이 **둘 다 있어야** 동작([runtime.ts](../../../src/tool/evidence/runtime.ts) `defaultRuntimePort` 가드). 예외가 헬퍼 깊은 곳에서 throw되면 test-runner가 주는 line(테스트 함수)은 **버그 지점이 아니다**. throw 지점 정지는 정밀 — 사람 디버거의 "break on exception"과 동일(검증된 기법).
- **(ROI)** 높음. 전 4언어 적용(특히 Python 강력). false-line localize 회피 + line 없는 실패도 runtime 포착(현재는 null degrade).

## 접근 (grounded)
1. **DAP**: `InspectSpec`에 `exceptionFilters?: string[]` 추가. config phase(setBreakpoints 옆)에서 `setExceptionBreakpoints({filters})` 호출. paused.reason==="exception"이면 `exceptionInfo({threadId})` → `Inspection`에 `exception?:{id,description}` 추가. 어댑터별 필터: debugpy `["uncaught","userUnhandled"]`, lldb/dlv는 지원 시도→실패 swallow(degrade).
2. **CDP**: `Debugger.setPauseOnExceptions({state:"uncaught"})`. paused.reason==="exception"이면 `data`(예외 RemoteObject)에서 type/description.
3. **types.ts**: `RuntimeEvidence.exception?:{type,message}`; `toRuntime`이 매핑(DAP/CDP 공통).
4. **runtime.ts**: line 없어도 exception-bp만으로 실행하는 경로(line-bp와 공존: 먼저 hit한 쪽 정지).
5. **debug_inspect 도구**: `exceptionBreakpoints?:boolean` 입력 추가(선택).

## 컴포넌트 DoD (§2 상속)
- 어댑터별 graceful degrade(미지원 어댑터서 setExceptionBreakpoints 실패→line-bp만, 크래시 없음).
- 헬게이트: scripted-fake(DAP+CDP) paused.reason="exception"+exceptionInfo → red-on-injection. REAL e2e: debugpy(예외 throw하는 py 테스트) + node(throw하는 js) 실 포착.
- NEVER-throws·abort-aware·timeout 유지.

## repo-green DoD (§4 상속)
- src tsc 0 / 건든 테스트 0 신규 / debug+evidence+testrun 스위트 0 fail.
