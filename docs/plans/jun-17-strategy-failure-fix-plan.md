# SWE-bench STRATEGY 실패 교정 플랜 (2026-06-17)

> 상태: **supporting analysis note only**
> 이 문서는 light-tier subset의 오라클 대조 실패 분석이다.
> 구현 SSOT는 [jun-17-proof-driven-bench-closure/00-index.md](./jun-17-proof-driven-bench-closure/00-index.md)와
> [tickets/00-backlog.md](./jun-17-proof-driven-bench-closure/tickets/00-backlog.md)다.
> 본 문서는 ticket calibration에는 유효하지만 runtime policy나 preset policy authority는 아니다.

> 근거: light 티어 7개 실패 인스턴스의 오라클(골드패치) 대조 분석 + 4-앵글 설계
> (제안 → 적대어딧 → 객관어딧 → 합성, 13-에이전트 워크플로우). 모든 코드 seam 실파일 검증됨.
> 2026-06-20 정정: `sympy-18763`은 이후 quanta gpt-5.4 sidecar에서 official PASS(115t, 528B). 이 문서의 `sympy-18763` 언급은 active unresolved가 아니라 historical failure-mode/spec-fidelity calibration 사례로만 해석한다.

---

## 1. 실패 진단 (오라클 대조, 7/7)

7개 모두 **non-empty 오답 패치**(447~1028B, 27~55턴) — **전부 STRATEGY 실패, localization 실패 아님**.
거의 L0/L1(이슈가 파일·라인·repro 제공)이라 위치는 찾았고 **고치는 로직에서 틀림**.

| 인스턴스 | 골드 타겟 | 함정 | 축 |
|---|---|---|---|
| pylint-4970 | similar.py `run()` 2줄 early-return | `0=비활성화` sentinel 못 알아채고 비교연산을 고침 | S5/K-Domain |
| pylint-7277 | `modify_sys_path()` 3-멤버 술어 | 술어 너무 좁게(`cwd`만, `""`/`"."` 누락) | S2 |
| sympy-15976 | mathml.py `_print_Symbol` 4분기 refactor | under-fix, 분기 일부만 + 짝 hunk 누락 | S6 |
| sympy-18211 | relational.py `_eval_as_set` try/except fallback | fallback 반환값 형태 불일치(ConditionSet 정규형) | S2/K-Domain |
| sympy-18763 | latex.py `_print_Subs` 무조건 괄호 | 조건부 괄호로 over-engineering | S2/K-Domain |
| sympy-21930 | secondquant.py `_latex` **3곳** | 1곳만 고침, 결함클래스 미일반화 | S2/완전성 |
| sympy-23262 | lambdify.py `_recursive_to_string` 2줄 | 엉뚱한 파일(pycode.py) 발산 + 1원소 특수케이스 overfit + false-green | S2/K-Gen |

### 2개 능력 갭
- **(A) 결함클래스 미일반화 / 다중사이트 co-change 누락** — 한 패턴 찾으면 모든 동일 사이트를 쓸어야 하는데 보이는 한 줄만 고침. (sympy-21930, 15976)
- **(B) over-engineering / spec 불신** — 이슈가 기대출력을 적어줬는데 더 영리한 fix를 지어내 틀림. 최소 literal 수정을 신뢰 못 함. (pylint-4970, sympy-18763, 23262, 18211, 7277)

---

## 2. 4개 앵글 랭킹 (net value)

| 순위 | 앵글 | feas/roi/risk | 판정 |
|---|---|---|---|
| **1** | **spec-fidelity-steer** (gap B) | 3/2/3 | **GO (단일변수 A/B 조건부)** — 가장 큰 갭 정조준, ~3개 정확히 다룸 |
| 2 | multi-site-cochange (gap A) | 5/2/4 | 측정 게이트 후 격리 실험 — 상한 2/7, 빌드는 최저비용 |
| 3 | best-of-N + 실행투표 | 3/2/4 | **defer** — shared-prior 오류라 N seed 같은 오답 반복 |
| 4 | regression-selfcheck | 3/1/4 | **DROP** — 치명결함 2개, 7개에 ~0 fix |

---

## 3. Top-1 착륙 플랜 — spec-fidelity-steer

**핵심 정정**: "verify-guard 메시지 확장"은 틀림. 블록 텍스트는 `decideVerifyGuard`가 반환하는
하드코딩 모듈 상수(verify-guard.ts:37-48,104-110,170-191)라 텍스트 threading은 코어 시그니처
변경 + frozen agentless-v1 silent mutation 경로. **건드리지 말 것.**

- **Seam**: lsp-steer가 `LSP_GROUNDING_STEER`를 append하는 동일 bench-steer 주입점
  (`src/agent/localize-phase-guard.ts`)에 **별도 steer 텍스트 블록** 추가. driver.ts의 verifyGuard
  경로는 미접촉.
- **Knob**: `src/runner/knobs/knobs/spec-fidelity-steer.ts` 신규, **default-OFF** NOOP-bench knob.
  off일 때 시스템 프롬프트 byte-identical. agentless-v1/v2 보존.
- **텍스트 정책(임계값·패턴매칭 금지, 정책문만)**: "이슈에 명시된 expected output을 권위 spec으로
  취급 / 더 영리한 일반화보다 **최소 literal fix** 선호 / 패치 후 기존 관련 테스트 실행."
- **전환 대상**: sympy-18763, sympy-23262, pylint-4970 (강). sympy-18211, pylint-7277 (약).
  **능동적 위험 2개**: sympy-15976/21930 (minimality가 "더 많은 hunk"와 반대 방향).

### A/B (효과 주장 전 필수 통과)
- django/light 서브셋 + 7개 오라클, **concurrency-6 env**(jun-17 RCA 적용), repo-경로 dataset.
- **단일변수 강제**: lsp-steer가 `lsp:1`에 DEFAULT-ON(knobs-bench.ts:234)이므로 **양 arm 모두
  lsp-steer OFF 고정**(`agentless-v1-nosteer` 재사용). 안 그러면 anti-generalization nudge가
  live pro-generalization nudge 위에 스택돼 단일변수 아님.
- **Primary metric: resolved-count만.** hunk-count 변화 절대 proxy 금지(under-fix 보상).
- **회귀 가드**: co-change 인스턴스(sympy-15976/21930) resolved가 baseline 대비 하락 안 할 것 = fail 조건.
- **노이즈**: fired 인스턴스 2-3개라 light 노이즈 안 → N반복런으로 깔 것.

## 3b. Top-2 (multi-site-cochange) — 측정 게이트 후에만
- **Seam**: buildVerifyGuard/buildCloseoutGuard 미러 finish-guard(session-resources.ts:99/130).
  ToolChoiceSignals(tool-choice.ts:93/108)에 arming bit 1줄 ADR-게이트, `{kind:"any"}` arm.
- **필수 2가지**: (1) "recognizable defect pattern" 표현 삭제 — latent heuristic 금지.
  **pattern-free "임의 mutating edit 후 후속 sweep 없음"** 형태로만. (2) sweep 도구 **CALLED**로만
  게이트, references **RESULT로는 절대** 게이트 안 함(pyright over-report 무력화).
- 두 steer는 방향 반대(minimality vs more-hunks) → **동시 측정 절대 금지.**

---

## 4. 최대 측정-착시 함정 (단 하나)
**"forcing 메트릭 = 효과" 동어반복 false-green.** sweep-call 0%→N, hunk-count 감소 — 둘 다 가드/
프롬프트가 행동을 강제하니 자동달성, resolved-rate와 무관. **선례: jun-17 lsp-steer가 usage
0%→75% 올렸지만 resolved-Δ는 throttle/concurrency 교란 아래 깨끗이 착륙한 적 없음.**
유일한 정직 신호 = **fired된 인스턴스 서브셋의 resolved-count Δ.** surfacing/forcing 메트릭은
어떤 주장에도 쓰지 말 것.

---

## 5. 하지 말 것 (명시)
- **regression-selfcheck DROP.** ①`sourceOnlyDiff`가 test-file hunk 전부 drop → HEAD 샌드박스에
  new-behavior 테스트 **구조적 부재**(기존 테스트는 OLD 회귀만, clever-but-wrong 정의를 못 잡음)
  ②validator 신호가 에이전트 자작 cmd/reproPath(validator.ts:43-45) = sympy-23262서 gamed된 그것.
- **best-of-N 지금 안 함.** shared-prior 오류 → N seed 같은 오답 반복, 선택으로 복구 불가.
  N×비용 + single-deadline 공유로 jun-16 deadline-abort 병리 재도입. generation-rate 선측정 없이
  resolved@1 주장 금지.
- **verify-guard 메시지에 spec-fidelity 텍스트 thread 금지** (코어 시그니처 + v1 silent mutation).
- **두 steer 동시 측정 금지** (반대 방향, 교란).

---

## 6. 관련 파일
`src/agent/tool-choice.ts`, `src/agent/session-resources.ts`, `src/agent/verify-guard.ts`,
`src/agent/localize-phase-guard.ts`, `src/runner/knobs/presets.ts`, `src/runner/knobs/knobs-bench.ts`,
`src/runner/batch/eval/repair/{index.ts,validator.ts,types.ts}`

## 7. 데이터
- 실패 분류 근거: `docs/analysis/swe-bench-verified-analysis/` (7 인스턴스 md) + 골드패치
  (`_data/verified-full.jsonl`).
- 오라클 추출본: `/tmp/bench/oracle/<iid>.txt` (problem + gold + test).
