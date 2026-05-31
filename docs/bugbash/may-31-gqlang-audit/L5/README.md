# L5 Audit — Apps / Runner / Host / Kernel / SDK

**Date:** 2026-05-31
**Scope:** Lane L5 (~54k LOC, 362 non-test files) — `src/apps` + `src/runner` + `src/host` + `src/kernel` + `src/sdk`
**Lenses:** assembly·composition-root·배선(wiring), code quality, missing features, silent errors, error swallowing, 짜치는 코드, SOLID violations, race/cancellation
**Method:** 8 slices × 2-round parallel pipeline (Round 1 objective finder → Round 2 adversarial verifier that judges every R1 finding confirmed/refuted/overstated/understated **and** hunts for misses), then synthesis. 17 agents total. Top findings (all CRITICAL + Top-5 HIGH) were then **personally re-read against source** by Claude during this writeup — corrections from that pass are recorded inline.

## Result summary

| | count |
|---|---|
| Raw findings (R1 + R2, 8 slices) | ~40 |
| R1 findings rejected by adversarial verifier | 9 |
| R1 findings downgraded (overstated) | 3 |
| **Confirmed CRITICAL** | **1** |
| **Confirmed HIGH** | **8** |
| Medium | 14 |
| Low | 5 |

Findings per slice (confirmed C/H · M · L):

| slice | C/H | M | L |
|---|---|---|---|
| kernel-session | 1C + 1H | 2 | 1 |
| host-runtime | 1H | 3 | 1 |
| apps-agent | 1H | 3 | 1 |
| apps-eval-bench | 2H | 3 | 0 |
| runner-core | 0 | 2 | 1 |
| runner-assemble | 1H | 2 | 0 |
| sdk-runtime | 1H | 1 | 0 |
| apps-cli-surfaces | 1H | 1 | 1 |

## Verification status legend

- **[확인됨]** — verifier 통과 + 본 문서 작성 중 Claude 본인이 소스 직접 재확인 (file:line + 코드 인용)
- **[검증됨]** — objective finder 보고 → adversarial verifier가 confirmed/understated 판정 (Claude 개인 재확인 안 함 — **수정 착수 전 라인 재확인 권장**)
- **[정정됨]** — R1/R2가 보고했으나 Claude 재확인에서 framing·severity 보정함 (상세는 해당 항목 참조)

## Documents

- [01-critical-high.md](01-critical-high.md) — 1 CRITICAL + 8 HIGH, evidence/file:line/why/fix. **여기서 시작.**
- [02-medium-low.md](02-medium-low.md) — 14 medium + 5 low cleanups + cross-cutting themes.
- [03-false-positives.md](03-false-positives.md) — 9 rejected + 3 downgraded, 재제기 방지용 기록.

## Top-priority fix set (highest ROI — small fixes, real contract violations)

| # | severity | issue | file:line | 상태 |
|---|---|---|---|---|
| 1 | CRITICAL | `turn.cancel` reducer 핸들러가 완전 no-op → 취소 기능 전무 | [reducer.ts:197](../../../../src/kernel/session/reducer.ts#L197) | 확인됨 |
| 2 | HIGH | approval grant가 턴 경계 없이 살아남아 비-shell 도구 1회 무프롬프트 자동승인 | [context-binding.ts:632](../../../../src/host/runtime/internal/context-binding.ts#L632) | 확인됨(정정) |
| 3 | HIGH | 5개 모드(headless/batch/daemon/ide/ci-bot) SIGINT 무시 — throwaway AbortController | [headless.ts:67](../../../../src/apps/agent/mode-presets/headless.ts#L67) | 확인됨 |
| 4 | HIGH | SDK bridge error 핸들러 미배선 + dispatch rejection 무음 | [session.ts:47](../../../../src/sdk/runtime/session.ts#L47) | 확인됨 |
| 5 | HIGH | invalid `QUANTA_VECTOR_STORE`가 warn 한 줄 후 무음 비활성화 | [search-index-backend.ts:686](../../../../src/runner/assemble/search-index-backend.ts#L686) | 확인됨 |
| 6 | HIGH | pythonSwebench까지 AbortSignal 미전파 → 인스턴스 타임아웃이 하니스 평가 못 끊음 | [driver.ts:1235](../../../../src/runner/batch/eval/driver.ts#L1235) | 검증됨 |

## Cross-cutting themes (요약 — 상세는 02 문서)

세 개의 근본원인이 슬라이스를 가로지른다:

1. **취소 경로 미완 (AbortSignal not threaded end-to-end).** C-1(kernel no-op handler), H-2(5 presets dead signal), H-6(pythonSwebench), H-9(kernel dispatch가 signal.aborted 미검사), 그리고 SQLite open·setInterval·side-conv가 전부 동일 패턴. **AbortSignal을 일급으로 끝까지 스레드하는 단일 횡단 작업으로 묶어 처리 권장.**
2. **컴포지션 루트 teardown 자원정리 누락.** close/dispose가 teardown 훅에 미배선 — runtimeFacade·playbook watcher·SQLite handle·setInterval·MCP client. 비정상 종료 시 누수.
3. **무음 폴백/삼킴.** logger 미배선(bench/eval/driver) 또는 빈 catch, 그리고 "오류를 정상 빈-결과로 매핑"하는 fail-silent 폴백(invalid store, model catalog).
