# Execution-trace grounded localization 플랜 (2026-06-17)

> 목표: wrong-surface localization 결함 해결 (sympy-23262류). 텍스트(이슈 단어)로
> localize → 인과적으로 죽은 코드에 패치하는 실패를, **실행 트레이스로 후보를 제약**해
> 구조적으로 차단. 휴리스틱 아님 — dynamic slicing / spectrum-based FL (validated APR).
> 관련: [docs/plans/jun-17-strategy-failure-fix-plan.md] (이 플랜은 그 plan의 gap-A 인접
> 신규 축; strategy plan의 Top-1=spec-fidelity와 별개 레버).

---

## 1. 문제 (확정, n=2 재현)
sympy-23262: 이슈 "Python code printer..." → quanta가 **printer 파일**(pycode.py)에 박음.
진짜 버그=`lambdify._recursive_to_string`. 트레이스 실증: repro 실행 시 `_recursive_to_string`
실행됨=True, `_print_Tuple` 실행됨=**False**(quanta가 돌지도 않는 코드 패치). 2회 연속 동일.
실험자료=`~/Library/quanta-codeagent-v3/sympy-23262-localization-experiment/` (32턴 cassette 포함).

## 2. 해결 레버 = execution-trace grounded localization
repro를 트레이스 하에 실행 → 잘못된 출력을 만드는 동안 **실제 실행된 (파일,라인) 집합**을
캡처 → localize-phase에 **causal candidate region**으로 주입. 실행 안 된 표면(printer)은
구조적 배제. 단어매칭 못하는 걸 인과(실행)가 가름.
- **휴리스틱 아닌 근거**: 임계값·패턴·vocabulary 0. 실행된 라인집합 = 코드 돌려 나온 사실.
  spectrum-based FL / dynamic slicing은 APR 정석(GZoltar/Angelix/Prophet).
- **강화형(후속)**: dynamic slice — 잘못된 *값*에 데이터 의존하는 라인만(실행집합의 부분집합).

## 3. 측정 먼저 (claim/build 전 필수 — no-heuristics 규칙)

### 3a. wrong-surface 비율부터 측정 (ROI 게이트)
우리 패치 7개 다 캡처돼 있음(quanta-patch). **각 패치의 건드린 파일 vs 골드 파일 대조 +
각 인스턴스 repro 트레이스 실행집합과 교집합** → "causally-dead 표면에 패치한" 비율 측정.
- sympy-23262=확정 1건. **나머지 6 중 몇이 같은 패턴인지가 ROI를 정함.**
- 1/7뿐이면 → 이 레버 단독 ROI 낮음(strategy plan Top-1 우선). 3+/7이면 → 정당화.
- **이 측정 없이 레버 빌드 금지.**

### 3b. cassette 분기-재생으로 싸게 검증 (n=1)
`~/Library/.../sympy-23262-.../trajectory.jsonl` 32턴을 `replayLlmPort`로 재생 →
printer 처음 박는 턴 직전 분기 → causal set(트레이스) 주입 → `_recursive_to_string`
찾는지 관측. **전체 재실행 없이** 레버가 이 케이스 가르는지 증명.

## 4. 빌드 (3a/3b가 정당화하면)
- **트레이스 수집**: repair 루프가 이미 python repro 실행(`buildRepairContext`/`runRepairRounds`,
  `src/runner/batch/eval/repair/`). 그 실행을 `python -m trace` / `sys.settrace` 래퍼로 감싸
  실행된 (파일,라인) 집합 캡처. fail-open(트레이스 실패/빈결과=무제약).
- **주입**: 캡처집합을 localize-phase(`src/agent/localize-phase-guard.ts`)에 causal candidate
  region steer로. **실행 안 된 표면 편집 시 경고/배제**(hard-gate 아님 — 동적언어 오탐 회피,
  pyright 교훈과 동형). steer 텍스트만, 임계값 없음.
- **default-OFF knob**: `QUANTA_BENCH_TRACE_LOCALIZE`(NOOP-bench, off=byte-identical).
- 언어 한정: 우선 Python(settrace). 일반화는 후속.

## 5. A/B (효과 주장 전)
- wrong-surface 서브셋(3a서 식별) + concurrency-6 env + repo-경로 dataset.
- **Primary metric: resolved-count Δ만.** "trace 주입됨"/"causal-set 크기"는 forcing-metric
  동어반복 false-green → 어떤 주장에도 쓰지 말 것(jun-17 lsp-steer 선례: usage 0→75%인데
  resolved-Δ 미착륙).
- 회귀 가드: 비-wrong-surface 인스턴스 resolved 하락 금지.

## 6. 정직한 한계
- **repro 품질 의존**: 에이전트 repro가 증상을 실제 트리거 못하면 트레이스가 틀림.
  (sympy-23262 골드 테스트는 `tuple([1])`; 에이전트가 약한 repro 쓰면 다른 경로 탈 수 있음.)
- **실행집합 = reachability지 pinpoint 아님**: 후보 제약일 뿐, 정확한 fix 라인은 여전히 추론.
  dynamic slice가 더 좁히나 무거움.
- n=2 케이스. **3a 비율 측정이 진짜 ROI 판정.** 1건이면 이 플랜 보류하고 strategy Top-1만.

## 7. 순서
3a(비율 측정, 우리 패치 7개 이미 있음) → 3b(cassette n=1 검증) → [정당화시] 4(빌드) →
5(A/B). 3a가 1/7이면 4 보류.

## 8. 핵심 파일
`src/runner/batch/eval/repair/{index.ts,context.ts}` (repro 실행 훅),
`src/agent/localize-phase-guard.ts` (causal region 주입), `src/apps/bench/index.ts`
(QUANTA_BENCH_RECORD_TRAJECTORY 녹화 — 이미 land), `src/runner/knobs/` (신규 knob).
실험자료=`~/Library/quanta-codeagent-v3/sympy-23262-localization-experiment/`.
