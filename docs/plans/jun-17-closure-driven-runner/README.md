# Closure-Driven Runner (jun-17)

> **SSOT for this workstream.** 티켓은 이후 `./tickets/` 아래로 분리한다.
> 선행 분석: [../jun-17-strategy-failure-fix-plan.md] (gap-A/B 진단, 4앵글),
> [../jun-17-execution-trace-localization-plan.md] (wrong-surface). 본 문서가 그
> 둘을 흡수해 **실행 아키텍처**로 승격한 정본이다.

---

## 0. 한 줄

agentless-v2를 "똑똑한 프롬프트"가 아니라 **ClosureBundle 기반 실행기**로 만든다.
한 번 만든 closure artifact를 **prompt / gate / repair / diagnostics**가 같이 쓴다.
강제는 프롬프트가 아니라 **validator + gate**가 한다. 프롬프트는 보조다.

## 1. 왜 (측정 근거)

- prompt-only steer는 측정상 효과 미미: spec-fidelity fire-rate 2/7, jun-17 lsp-steer는
  usage 0%→75%인데 resolved-Δ가 throttle/concurrency 교란 아래 깨끗이 착륙한 적 없음.
- 진짜 실패는 strategy(over-eng/under-fix/co-change)·localization(wrong-surface)이라
  프롬프트 nudge로 거의 안 움직인다. → **런타임 강제(validator/gate)로 전환.**
- spec-fidelity-steer는 **이 실행기 위의 한 실험**이지 중심축이 아니다.

## 2. 능력 흐름 (control loop)

```
Localize → FaultEvidencePacket → OwnerAdmission → VerificationPlan → GateDecision
  → Agent edit → Predicate-aware primary rail(validator) → PatchHygiene
  → Escalate ONLY if explicit multi-owner
```

역할 분리:
- **evidence**: 뭘 봐야 하는지
- **owner**: 지금 single-site인지 owner-family인지
- **plan**: 어떤 proof가 required인지 (typed successPredicate)
- **gate**: 지금 commit-fast인지 verify-first인지
- **validator**: required proof가 실제로 충족됐는지 (← 지금 제일 큰 구멍)
- **repair**: validator failure만 보고 다음 라운드로

## 3. 아키텍처 — 하나의 Closure Engine + 두 운용 프로필

**벤치 전용은 카테고리 오류다** (capability ≠ surface; cf. memory `surface-model`,
thin-surface ADR-0303). closure controller = 자율주행 본체(어떤 문제든 수정하고 닫는 방식),
벤치 = SWE-bench 입력을 먹이고 점수/진단을 뽑는 **시뮬레이터 어댑터**.

그리고 **합치되 한 덩어리로 뭉개지 않는다.** "어떻게 올바르게 닫느냐"는 공통,
"혼자 달리냐 / 나랑 티키타카하냐"는 **모드 차이**다.

```
Closure Engine (공통)              Mode Profile (분리)
  evidence                          누가 initiative
  owner                             언제 사용자에게 물을지
  plan                              repair budget / stop 신호
  gate                              commit-fast 허용 여부
  validator                         risky edit ack 요구
  hygiene                           프롬프트 톤·렌더
  escalate                          approval / handoff / reporting
```

```ts
type RunMode = "autonomous" | "collaborative"
type ModeProfile = {
  mode: RunMode
  repairBudget: number
  askUserOnAmbiguousOwner: boolean
  askUserOnWidePatch: boolean
  allowCommitFast: boolean
  requireExplicitUserAckForRiskyEdit: boolean
  promptStyle: "minimal" | "dialogic"
}
```

**루프는 하나만 둔다** (`src/agent/runner.ts`):
```
observe → build closure bundle → choose next action → edit / verify / ask-user / finish → repeat
```
엔진은 동일, 차이는 `choose next action`에서 profile이 먹는다.
- **autonomous**: ambiguous owner여도 threshold까지 혼자 탐색, repair 길게, verify-first 강함,
  사용자는 마지막에만 결과.
- **collaborative**: ambiguous owner면 빨리 질문, wide/multi-owner면 설명 후 확인, 중간
  reasoning/선택지 짧게, repair 짧고 잦은 handoff.

🔴 **금지: 벤치용·자율주행용·티키타카용 로직을 따로** (각각 prompt/gate/repair가 미묘하게
달라져 같은 버그를 세 번 고친다). 같은 closure 엔진 위에서 mode profile로만 갈린다.

> **collaborative primitive는 이미 일부 존재** — agent 티키타카(co-control follower verb),
> HITL inline approval(4-verb/session-grant), inbound weave 모드. mode-profile은 이걸
> **소비/통합**하지 재발명하지 않는다. (cf. memory `jun-13-t02-thread-follower-cocontrol`,
> `jun-10-hitl-inline-approval-restructure`, `jun-07-inbound-mode-3way`.)

### 목표 디렉토리
```
src/agent/closure/*         # 공통 엔진 (evidence/owner/plan/gate/validator/hygiene/escalate)
src/agent/mode-profile.ts   # autonomous / collaborative 차이
src/agent/runner.ts         # 공통 루프
src/apps/bench/*            # 벤치 어댑터 (입력 조립 + 측정 + knob)
src/apps/chat/*            # 대화형 어댑터 (handoff/approval/reporting)
```

### 코어 / 벤치 / 반쯤-분리 (정본 파일 표)

**코어로 승격 (closure 엔진)** — 처음엔 물리이동 말고 `closure/index.ts`에서 re-export:
| 파일 | 비고 |
|---|---|
| `src/agent/owner-admission/index.ts` | 이미 코어 성격 |
| `src/agent/verification-plan/{index,build,types,extract-issue-declared-expected}.ts` | 이미 코어 |
| `src/agent/gate-decision.ts` | decideGate, 순수 정책 |
| `src/agent/primary-rail/index.ts` | PrimaryRail |
| `src/agent/fault-evidence/{build,types}.ts` | 순수 evidence build |
| 신규 `src/agent/closure/{index,types,bundle,render,evaluate-success-predicate,patch-hygiene}.ts` | 엔진 본체 |

**`src/runner/batch/eval/patch-hygiene.ts` → 코어 승격** (stray-file/patch-width/owner-outside는
벤치만의 문제 아님).

**벤치에 잔류 (어댑터)**:
| 파일 | 이유 |
|---|---|
| `src/runner/batch/eval/driver.ts`, `src/apps/bench/eval/driver.ts` | 조립·실험 only |
| `src/runner/batch/eval/fault-evidence.ts` | stage1 ranked files/issue names/repro를 코어 evidence 타입으로 바꾸는 어댑터 |
| `src/runner/batch/eval/repair/context.ts` | bench repair seed builder |
| `src/runner/batch/eval/closure-diagnostics.ts` | 측정 |
| `src/runner/knobs/knobs/{primary-rail,spec-fidelity-steer}.ts` + 나머지 bench knob | 실험 게이트 |
| report / x86 harness wiring | 인프라 |

**반쯤 분리 (쪼갠다 — 지금 제일 먼저 쪼갤 파일 = validator.ts + patch-hygiene.ts)**:
| 파일 | 코어 | 벤치 |
|---|---|---|
| `repair/validator.ts` | successPredicate 평가 | exec 결과→관측치 생성(I/O) |
| `repair/types.ts` | PrimaryRailStep / SuccessPredicate / PredicateResult | repair-round bookkeeping |
| `repair/index.ts` | (당장 벤치) 나중에 generic repair orchestrator로 뽑을지 결정 | repair 상태머신 |

**선 긋는 규칙**: *given inputs → decision = 코어 / inputs 어디서 오나 = 어댑터. exec I/O = 어댑터, verdict = 코어.*

### 마이그레이션 (barrel-first, 물리이동 나중)
1. `src/agent/closure/` 생성.
2. 기존 코어성 파일은 **안 옮기고** `closure/index.ts`에서 re-export.
3. 새 코드는 전부 `@/agent/closure`만 보게.
4. bench driver는 ClosureBundle만 조립해 코어에 넘김(thin adapter).
5. 안정화 후 물리적 이동.

### 🔴 코어 코드 ≠ 코어 활성화 (캐비엇)
능력은 아직 **미검증**이다. 코어 모듈로 올리되 **라이브 루프 default-ON은 벤치 측정 통과 후.**
검증 안 된 gate가 일반 repo서 false-RED로 사용자 패치를 막는다. → 코드는 코어 배치,
**활성화는 어디서나 gated(byte-identical default-OFF)**, 벤치가 먼저 measure → promote.
능력 강도는 input-의존(벤치 최강: repro·curated stage1; 일반 repo는 약하나 fail-open degrade).

## 4. 🔴 P0의 치명 함정 — predicate hard-gate의 false-RED

지금까지 "extracted value는 프롬프트 미주입이라 cosmetic"이었는데, 이 플랜선 그 value가
validator가 집행하는 predicate가 되어 **load-bearing으로 뒤집힌다.** issue-extractor는
2/7 발화에 값도 불완전 → fragile predicate로 hard-gate하면 **맞는 패치를 predicate
불일치로 reject → resolved 하락**(false-green을 false-RED와 맞바꿈, 더 나쁨).

**필수 규칙:**
- **fail-OPEN**: predicate 신뢰 못하면(파서가 observed 추출 실패 OR 저신뢰 extraction)
  → exit-code로 degrade(오늘 동작), hard-fail 금지.
- **hard-gate는 execution-grounded predicate만**: `test_exit_zero`, `selected_test_passes`,
  RED-validated repro의 `stdout_exact_empty`.
- **issue-declared exact-string/symbolic(`latex_or_string_exact`, `symbolic_repr_equals`)은
  advisory(repair seed pressure)로만**, 측정 전엔 gate 금지.

## 5. 시퀀싱 — observe-first

gate 켜기 전에 ClosureBundle+evaluator를 **OBSERVE-ONLY로 먼저** 돌려 슬라이스서
`primary_rail_present_rate` / `predicate_evaluability` / `owner_recall@1`을 측정 →
**measure-safe한 predicate만 hard-gate 전환.** resolved 폭망 gate를 미리 막음.

병목 경고: primary rail은 baseValidatedRed(repro가 base서 RED)일 때만 hard-gate.
7개 슬라이스 RED-repro 수가 적으면 rail이 대부분 null → P0가 spec-fidelity와 같은
thin-coverage로 자리만 옮긴 꼴. **repro-install rate부터 재라.**

## 6. 구현 순서 (→ 티켓 T-1..T-7)

1. **T-1 evaluate-success-predicate (core, pure)** + observe-only validator 통합.
   execution 계열 먼저 실집행; structure/exact-diff는 파서-제한 + advisory.
2. **T-2 PrimaryRailStep** 승격(`primaryRailCmd:string` → `primaryRailStep{cmd,authority,
   successPredicate}`); repair/types·index·validator shape 변경.
3. **T-3 ClosureBundle (core)** + driver 조립부 일원화 + closure-diagnostics 실값 채우기
   → **여기서 슬라이스 측정**(present_rate/evaluability/owner_recall).
4. **T-4 GateDecision wiring** — 측정 보고 measure-safe predicate만 hard-gate.
5. **T-5 OwnerAdmission→prompt/gate linkage** — owner_recall 측정 후. single-site면 1줄
   first-edit hint, owner-family/cross-owner면 commit-fast 금지 + repair 보수적 종료.
6. **T-6 PatchHygiene→verify linkage** — stray added file hard-fail, owner-outside/file-count는
   GateSignals.stakes 입력(verify pressure).
7. **T-7 Escalation** — primary rail 계속 red AND corroborated strong owners≥2 OR
   owner-family/cross-owner 일 때만 branch-search/subagent.
8. 그 **다음에만** spec-fidelity-steer A/B.

**Phase 경계**: T-1..T-7 + spec-fidelity A/B = **Phase 1 (closure 엔진을 벤치서 검증)**.
`ModeProfile` + `src/agent/runner.ts` 공통 루프 + `src/apps/chat/*` 대화형 어댑터 추출은
**Phase 2 (벤치 검증 통과 후 일반화)**. Phase 1에선 closure 엔진을 코어에 배치하되 벤치
어댑터를 통해서만 구동한다(autonomous 프로필 1개로 고정; collaborative는 Phase 2).

## 7. 프롬프트 정책 (통합 seam = bench buildConfig, NOT core prompt.ts)

통합 지점: `src/runner/batch/eval/driver.ts` `buildConfig`의 hint-composition seam
(issue/agentless/repro/spec steer가 이미 합쳐지는 곳). 코어 `prompt.ts` `buildSystemPrompt`는
미접촉. 렌더 규칙은 신규 `src/runner/batch/eval/prompt-augment.ts`로 분리
(renderIssueHint/renderClosurePrompt/renderReproHint/renderRepairSeed), buildConfig는 섹션 합치기만.

- 상시 blob 주입 금지.
- 항상: issue + swebench directive.
- 조건부: `owner.admit=true`일 때만 1줄 owner hint.
- repair round만: failing rail 요약 + current diff 요약 (`repair/context.ts` seed).
- successPredicate/patchHygiene/gate 전문은 **프롬프트 아니라 런타임에서** 사용.
- knob off ⇒ byte-identical (PRESET-8 frozen ratchet green 유지).

## 8. 성공 판정 (resolved보다 먼저 — leading indicators)

슬롯 이미 `src/runner/batch/eval/closure-diagnostics.ts`에 존재; 드라이버가 실값 채우게.

- `owner_recall@1` ↑
- `first_edit_owner_match` ↑
- `primary_rail_present_rate` ↑
- `required_verification_coverage` ↑
- `primary_false_green_rate` ↓
- `no_patch_exhausted_rate` ↓
- **신규 `primary_false_RED_rate`**(resolved됐는데 predicate gate가 막았을 패치) ↓
  — §4 함정을 못 보면 gate가 해치는 걸 못 잡는다.
- (debug-only, 주장 근거 금지) `spec_detected` / `steer_fired` — forcing metric.

## 9. 이번 라운드에 안 할 것

- spec-fidelity-steer를 플랫폼 중심축으로 올리기
- raw source를 힌트로 계속 붙이기
- branch-search/subagent default-on
- hidden/gold 기반 routing
- "프롬프트를 더 길게 써서" 해결
- 검증 전 라이브(CLI/web) default-ON 활성화
- Phase 2를 Phase 1과 섞기 — `apps/chat`/collaborative 프로필/공통 `runner.ts` 추출은
  closure 엔진이 벤치서 검증된 **다음**. 지금은 autonomous 프로필 1개·벤치 어댑터만.

## 10. 테스트 (티켓별 헬게이트)

- `tests/unit/closure/evaluate-success-predicate.test.ts` — predicate별 pass/fail; exit0인데
  exact-string mismatch=fail; stdout-empty 위반=fail; **저신뢰→fail-open(degrade) 증명**.
- `tests/unit/closure/closure-bundle.test.ts` — same input→same bundle; no repro→owner/smoke
  fallback; ambiguous owner→no commit-fast.
- `tests/unit/repair-primary-rail-hellgate.test.ts` 수정 — primaryRailStep 기준.
- `tests/integration/bench-closure-bundle.test.ts` — owner hint 조건부 주입; repair seed에
  predicate mismatch summary; **non-primary green이어도 primary rail mismatch면 종료 불가**;
  knob off ⇒ byte-identical.
- frozen-preset ratchet(PRESET-8) 불변; knob-inventory readSite/completeness green.

## 11. 핵심 파일

core(승격대상): `src/agent/owner-admission/`, `src/agent/verification-plan/`,
신규 `src/agent/closure/{closure-bundle,evaluate-success-predicate,render-closure-prompt}.ts`,
`src/agent/closure/gate/`(decideGate 승격).
bench(어댑터): `src/runner/batch/eval/driver.ts`(:1488 조립 / :897 buildConfig / :983 hint),
`src/apps/bench/eval/driver.ts`(plumbing only), `src/runner/batch/eval/repair/{types,index,
validator,context}.ts`, `src/runner/batch/eval/patch-hygiene.ts`,
`src/runner/batch/eval/closure-diagnostics.ts`(:148 메트릭 슬롯), 신규 `prompt-augment.ts`.
