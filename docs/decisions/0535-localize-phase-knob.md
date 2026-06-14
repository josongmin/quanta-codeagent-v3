# ADR-0535: localize-phase — bench knob for Agentless localize-first pre-pass

- **상태**: Accepted (registry 등록, bench-surface 게이트, resolveBenchKnobs 경유 apply)
- **날짜**: 2026-06-15
- **슬라이스**: `src/runner/knobs/knobs/localize-phase.ts`
- **출처**: Agentless 논문 §3.1 흡수 — localize-first retrieval pre-pass

## Context

SWE-bench-style 실행에서 전체 레포 탐색 대신 "localize" 단계(retrieval pre-pass)를 먼저 수행하면 repair agent가 더 좁은 컨텍스트로 작동한다. 이 동작을 default-OFF 벤치 knob으로 격리해야 A/B 측정 재현성을 보장할 수 있다.

## Decision

`QUANTA_BENCH_LOCALIZE_PHASE` 환경변수로 제어하는 bench-surface 전용 knob.

### 파서 (closed)

- 유효 도메인: 정수 N ∈ [1, 20] → `{ phase1Turns: N }`
- 비유효 → undefined (knob inactive): absent / empty / 0 / 음수 / 비정수 / NaN / Infinity / > 20
- `Number.isFinite` + `Number.isInteger` (parseInt 금지 — "1abc"를 1로 묵인하는 foot-gun 방지)

### Apply

- bench surface에서만 `cfg.localizePhase = { phase1Turns: N }` 변경
- 다른 surface(cli, ide 등) → cfg 변경 없음 = byte-identical

### 충돌 선언

`branch-search`와 conflicts: 두 knob이 동시에 탐색을 강화하면 A/B 측정값이 confounded.

### 측정 무결성 게이트

20 cap: maxTurns=30 기준으로 phase1Turns > 20이면 repair 단계가 고갈된다.

## 배선

```
QUANTA_BENCH_LOCALIZE_PHASE env
  → resolveBenchKnobs (runner/batch/eval/knobs-bench.ts)
    → localizePhaseKnob.parse()
      → BenchKnobState.values
        → applyBenchKnobs()
          → cfg.localizePhase = { phase1Turns: N }
            → driver.ts buildConfig 경유 에이전트 루프
```

## 테스트

- `tests/unit/runner/knobs/localize-phase.test.ts` — parse/apply/metadata 단위 테스트
- `tests/unit/runner/knobs/localize-phase-hellgate.test.ts` — resolveBenchKnobs 합성 경로 + gate-OFF + apply pipe + 적대 케이스

## 다음 (follow-up)

- branch-search 충돌 강제(KnobConflictError): 현재 선언만, validateKnobs에서 런타임 에러 방출 확인 테스트 추가 가능
