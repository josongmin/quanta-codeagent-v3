# jun-22 evidence/signal injection — 최종 통합 플랜 (2-어딧 종합)

> 상위 전략 문서. 실행 디테일은 자매 문서
> [jun-22-repro-oracle-campaign/PLAN.md](./jun-22-repro-oracle-campaign/PLAN.md)
> (Phase 0~4)와 cross-ref. 이 문서는 그 캠페인을 **ROI 순으로 재배치**하고, 5-축
> 병렬 어딧 + 적대/객관 2차 어딧이 추가한 **정정·갭·측정위생**을 얹는다.

## TL;DR
quanta는 업계 SOTA 증거/신호 기법의 **superset을 이미 다 빌드**했지만, 실제 점수가
나오는 default preset(`agentless-v3-thin-strict`)에서 그 신호들이 **거의 다 inert**.
못 푼 문제의 두 큰 덩어리는 (1) repro 오라클이 **아예 안 생김**(~45%), (2) 위치는
맞는데 합성이 틀림. 결론: **무기를 더 만들지 말고, 오라클을 *생성*시키고 그걸
0토큰으로 측정할 하네스부터.** 프롬프트에 증거 더 넣기(intake 배선 등)는 매력적이지만
이 모델에 prompt 추가는 net-neg 전적이 있어 **측정 없이 켜면 역효과**.

## 어딧이 확정/폐기한 사실관계 (이 플랜의 전제)

### 살아남음 (MEASURED 또는 강한 code-trace)
- **intake 증거패킷이 프롬프트에 안 배선됨.** `buildIntakeLlmEvidencePacket`의 단일
  소비처가 리포트 sidecar뿐 ([driver.ts:3744](../../src/runner/batch/eval/driver.ts#L3744)).
  evidence 패킷이 candidate prompt(`seed`)로 렌더되는 유일 경로는
  `verifySelectProofRequired && selectorMode==="clean"`(proof-clean 전용)뿐.
  *(code-trace, INFERRED-strong)*
- **default `agentless-v3-thin-strict`가 repro/repair/selection 신호를 inert로 둠**
  ([preset.ts:4](../../src/apps/bench/preset.ts#L4),
  [presets.ts:244](../../src/runner/knobs/presets.ts#L244)). 그리고 이 default가
  실제 resolved pass의 **67%(24/36)** 를 만드는 posture — "default라 무관"은 반박됨.
  *(verified)*
- **repro 오라클 생성 45% 실패** (exec_failed 24% + no_reproduced 22%, n=295).
  코퍼스 최강 측정치. *(MEASURED)*
- **못고침 vs regression = 74%/26%** (n=157). *(MEASURED)*
- **옛 0.75 false-neg-oracle 주장은 철회.** 계측 FN≈0%. *(MEASURED)*
- **proofRequired 게이트는 어느 default에서도 안 켜짐** → 신호 lattice fail-open.
  `verify-select-proof-required:1`은 `agentless-v4-proof-clean` 한 곳뿐. *(verified)*

### 폐기/하향 (1차 어딧에서 과장됐던 것 — 재발 방지용으로 명시)
- ❌ **"실패의 74%가 합성 오류" = 숫자 conflation.** 실제 n=31 모집단에선
  **17/31=55%** wrong-fix. 74%는 *별개 통계*(못고침-vs-regression, n=157)를
  갖다붙인 것. **방향은 맞지만 헤드라인 숫자 폐기.** E-tier per-instance 진단은 **n=12**.
- ❌ **"intake 배선은 공짜/안전" 틀림.** prompt 컨텍스트 추가는 net-neg 전적
  (Lever-A sibling-steer 0/6 ×2, lean-prompt가 오히려 도움). dilution/anchoring 위험.
- ❌ **"fault-evidence:2가 최고 ROI" = 미구현 추측.** `fault-evidence`는 boolean knob,
  `:2`는 존재 안 함(제안된 신규 knob). 측정증거 0. RCA가 M2/M4 강등.
- ⚠️ **"신호 재주입 전부 dead end" 과일반화.** repro-doubt net-1(n=6)은 "빨리
  포기시키기" 방향만 깨진 것. 모든 재주입 부정 못 함.

## 가드레일 (durable, 위반 금지)
1. **measure-first.** 아래 STEP-0 하네스 없이는 어떤 fix도 랜딩 금지. n≥50 아니면
   노이즈(교훈 4회 반복). astropy 빌드실패만 deterministic-n=1 예외.
2. **confound-discount.** 실패 숫자는 throttle-swallow 버그 / concurrency clobber /
   `__repro_*` leak(owner_recall 0.92→0.27 가짜였음) / grader-invalid와 *같은
   캠페인*에서 나옴. throttle-fix(`83663bc6`) 이후 재측정 안 된 숫자는 stale로 취급.
3. **answer-key 금지.** build-env fix는 공식 swebench spec 미러만, hand-map 금지.
4. **prompt-injection은 OFF-arm A/B(n≥50)로만.** 단독 랜딩 금지.
5. **framing.** 목표는 "신호 더 주입"이 아니라 **"오라클 생성 + executable signal로
   select"**. 코퍼스 자체 결론(병목=fix-생성 품질+resolved 오라클)과 정렬.
6. ≥3 적대 어딧 후에야 "campaign done" 선언.

## 실행 단계 (ROI 순, 각 단계는 측정 readout에 게이팅)

### STEP 0 — 무토큰 측정 하네스 (게이트, 모든 fix의 전제) — HIGHEST ROI
record-once / replay-many cassette + offline rescore. 기존 인프라 확인됨:
`QUANTA_BENCH_RECORD_TRAJECTORY=1` 녹화 / `QUANTA_BENCH_REPLAY_TRAJECTORY` 재생
([index.ts](../../src/apps/bench/index.ts)), repro executor는 port-injected라 offline 가능.
→ 자매 PLAN Phase 1과 동일. 산출물:
- [ ] **ALL K 영속화**(observe-only, off일 때 byte-identical): repro script 소스 전수
  + candidate diff 전수(winner뿐 아님). 현재 telemetry는 full patch를 의도적으로 drop.
- [ ] **offline rescore 커맨드** (`evaluate-repro`/`rescore-oracle`, `grade`와 분리):
  캐시된 후보+스크립트를 현재 오라클 코드로 재채점, LLM 0.
- [ ] **byte-identical round-trip e2e (RED-first 헬게이트)**: oracle fix *전에*
  캐시 재채점이 녹화 결과를 byte 단위로 재현 = 하네스 정합성 증명.

**왜 #1:** 이게 있어야 STEP 1~3 결정론 fix가 0토큰으로 반복 검증됨. 없으면 매 fix마다
풀 rollout+EC2 재지불.

### STEP 1 — repro 오라클 *생성* (deterministic, cassette로 무료 반복)
신호를 더 주입하는 게 아니라 **45% 인스턴스엔 신호가 아예 없는 걸** 고침.
- [ ] **astropy exec_failed**: `project-env.ts`에 이미 `extension_helpers`+
  `--no-build-isolation` 존재 → 진짜 원인은 **proof exec path가 그 builder를
  안 거치는 것**. 우회 seam을 trace해서 `buildProjectEnvUvRunArgv`로 라우팅.
  readout: astropy `synth_repro_base_red` 0→1.
- [ ] **py-version fix 효과 재측정**: `pythonForRepoVersion`/`repo-version-python.ts`
  랜딩됨, 근데 45%→? 미측정. cassette로 reproTest success rate 재측정부터.
- [ ] **django no_reproduced**: 이슈 텍스트에서 public MWE seed 추출(결정론) →
  LLM 스크립트 없이 base-red 오라클. readout: `primary_rail_present` 0→1,
  `no_public_issue_mwe_seed` 소거.
- [ ] **django base-env**: `base_not_green`(regression baseline 불안정) 별도 audit.

### STEP 2 — confound 청소 후 baseline 재측정
- [ ] throttle-fix 이후 default posture로 깨끗한 n≥50 baseline 1회. STEP 1 전후
  비교의 기준선. 이거 없으면 STEP 1 효과가 confound와 안 갈림.
- [ ] `__repro_*` leak / grader-invalid 잔존 여부 확인 후 측정에서 제외.

### STEP 3 — executable selection 줄기 (현재 uncommitted tree가 이미 이 방향)
working tree의 `ownerNearTests` / `selection-gates.ts` /
`verificationOwnerCandidatesOf`가 정확히 **"오라클 만들고 executable로 select"** 줄기.
- [ ] 이 변경을 STEP 0 하네스로 byte-identical 검증 후 정리/커밋.
- [ ] `impacted-test-discovery.ts` + `repo-regression-discovery-adapter.ts` 기반
  executable-regression-gated selection을 default posture에 **A/B로** 평가
  (코퍼스가 지목한 실제 #1 레버).

### STEP 4 — prompt/evidence 주입류 (후순위, OFF-arm A/B로만)
오라클이 *있는데도* django가 틀리는 "right place wrong answer"가 STEP 1~3 후에도
남을 때만. 단독 랜딩 금지.
- [ ] **intake 패킷 프롬프트 배선** — cheap(S)지만 EV 최저, dilution/anchoring 위험.
  반드시 OFF-arm A/B(n≥50). 측정 없이 default-on 금지.
- [ ] **fault-evidence 본문/sibling/donor 주입** — 미구현, n=12 표적, 위험 중-상.
  STEP 3 executable selection이 합성 갭을 못 메울 때만, 측정 후 착수.

## 단계별 측정 readout (closure-diag 기반, LLM-free)
| step | readout (0→목표) |
|---|---|
| 0 | round-trip byte-identical = true |
| 1 | `synth_repro_base_red_rate`, `primary_rail_present_rate`, `required_verification_coverage` ↑ from 0 |
| 2 | clean baseline resolved% (n≥50, post-throttle-fix) |
| 3 | executable-gated selection A/B Δresolved (OFF-arm 대비) |
| 4 | intake/fault-evidence A/B Δresolved (OFF-arm 대비, n≥50) |

## 의도적으로 *안* 하는 것 (net-neg/미측정 전적)
- repro-doubt류 "빨리 포기시키기" 재주입 (net-1, shelved).
- closure-repair 루프 default-on (측정 net-neg, presets.ts:117).
- n=1 / single-run으로 generation·loop 결론.
- answer-key 기반 hand-map build-deps.
