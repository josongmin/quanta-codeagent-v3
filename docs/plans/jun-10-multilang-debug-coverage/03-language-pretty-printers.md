# T-03 — 언어별 변수 pretty-printer + Go goroutine dump

- **상태**: OPEN. 우선순위 3.
- **충돌주의**: 없음(신규 매핑층, runtime.ts `toRuntime`/`toVar` 인접).

## 기능 / 왜 / ROI
- **(기능)** runtime 변수 렌더를 언어별로 가독화: Rust `Vec`/`HashMap`/`Arc`/`Option`, Go slice/map/struct, Python dataclass/`__repr__`. + Go **goroutine dump**(동시성 버그 evidence).
- **(왜)** 현재 중첩 펼침은 어댑터가 주는 raw value/description 그대로([runtime.ts](../../../src/tool/evidence/runtime.ts) `toVar`, [inspect-driver.ts](../../../src/tool/debug/inspect-driver.ts) `expandVariables`). lldb가 `Vec<T>`를 `{buf, len, cap}` 내부구조로 보여줘 노이즈; dlv가 goroutine을 안 덤프하면 deadlock/race 원인 안 보임.
- **(ROI)** 중. evidence 가독성↑(LLM이 자료구조 의미 파악). goroutine dump는 Go 동시성 버그에 큰 값.

## 접근 (grounded)
1. **lldb-dap**: launch에 `"initCommands":["command script import ..."]` or rust pretty-printer 활성(`settings set target.use-rust-formatters`류) → 어댑터가 이미 요약. 최소: type 기반 후처리(`Vec<...>` description 정규화).
2. **dlv**: `goroutines`/`stacktrace` 커스텀 request or `evaluate("runtime.NumGoroutine()")`; goroutine 목록을 `RuntimeEvidence`에 `goroutines?:[{id,fn,line}]` 추가(types.ts).
3. **공통 후처리층**: `toVar` 다음에 언어별 normalizer(pure, 테스트 용이). raw는 보존, 표시용만 정리.
4. bounded 유지(현 depth2/breadth16/total200) — pretty-print가 budget 폭발 금지.

## 컴포넌트 DoD (§2)
- normalizer pure-unit 테스트(raw lldb/dlv 샘플 → 정리된 출력, verbatim 핀).
- REAL e2e: rust `Vec<i32>` locals가 `[1,2,3]`류로, go goroutine dump 1개 이상.
- 미지원/실패 시 raw로 degrade(크래시 없음).

## repo-green DoD (§4)
- src tsc 0 / 건든 테스트 0 신규 / 스위트 0 fail.
