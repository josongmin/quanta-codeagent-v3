# SOTA++ 흡수 갭 클로저 계획 (2026-06-25)

전제: [흡수 검증 어딧](../analysis/jun24-scaffold-absorb/REPORT-jun25-absorb-verification.md) = 8후보 중 LANDED-REAL 5 / PARTIAL 1 / ABSENT 2.
**가장 큰 진실: 구조는 닫혔는데 벤치 이득은 0개 증명됨** (5개 다 default-OFF research lever거나 A/B 미실행).
규칙(엄수): no-heuristics(검증된 기법만), measure-first(n=1 루프변경 금지), 답안지(gold/PR/issue·gold-regex) 금지, theater 가드(wired≠engages), hellgate TDD(RED 먼저), claim-100=적대어딧≥3R.

핵심 시퀀싱 원칙: **MEASURE before BUILD.** 이미 LANDED된 5개가 default-OFF라, 새 갭(cross-vendor/paired-control/router) 빌드 前에 **켜서 측정**부터. 켠 5개가 3케이스를 이미 닫으면 ABSENT 갭 우선순위가 내려간다(불필요한 theater-risk 빌드 회피).

---

## PHASE 0 — 이미 LANDED된 5개를 켜고 측정 (최우선·저비용·언블로커)

목표: "구조 닫힘"→"벤치 이득 증명/반증". 신규 코드 거의 0, 측정이 본체.

### P0.1 측정 preset 구성
- 새 A/B arm preset `agentless-v4-proof-clean-absorb` = (현 shipped base) + 다음 default-OFF 레버 ON:
  - `spec-fidelity-invariant: "1"` (13033 declared-expected matcher; 현 어떤 preset에도 없음 — presets.ts grep 확인)
  - `deeper_localize` phase posture 활성 → `forward-localize`(DEEPER_LOCALIZE_MODULES, capability-profiles.ts:331) 켜짐 (14315)
  - F821 staticSanity·F0 fork-capture는 이미 default-ON → 대조군에도 켜져 있어야 함(arm 격리 확인)
- seam: `src/runner/knobs/presets.ts`(arm 추가), `compose-preset.ts` 등록, `bench-preset-drives-config-hellgate.test.ts`에 arm 동치 테스트.

### P0.2 frozen-slice A/B
- arm: baseline(현 shipped) vs absorb(P0.1). **SERIAL 채점**(메모리: 동시채점=false-neg).
- slice: 3 confirmed-fail(11138/14315/13033) + our-only-misses 10 + 회귀 가드용 easy-django 슬라이스.
- readout(메모리 feedback-record-winning-config): official resolved↑ / regression flat·down / proof_required_missing↓ / **empty_patch 0**(11138 F0 검증) / failToPassFailed 분포(다회).
- 가드: 유저 박스 live면 강제 금지(CONCURRENCY=3, 단일박스락). gold-as-ours 추출함정 회피(model_patch만 신뢰).

### P0.3 per-lever 귀속
- arm을 레버별로 분해(spec-only / forward-only / both)해 어느 게 어느 케이스를 닫는지 귀속. n=1 귀속 금지 → 교차런·다회.
- **DoD**: 11138 empty_patch=0 재현(F0), 14315 base/client.py 패치 포함(forward+owners), 13033 메시지 정합(spec-invariant). 각각 resolved flip 측정.

**Phase 0가 끝나야 Phase 1 우선순위가 정해진다.** 켠 5개가 3케이스 다 닫으면 → Phase 1은 "synthesis 74% 일반 갭"만 남고 cross-vendor로 직행. 안 닫으면 → 닫힌 거 빼고 잔여 갭 타겟.

---

## PHASE 1 — REAL 갭 구현 (검증 어딧이 ABSENT 확정한 net-new)

각 갭: 메커니즘 / seam / hellgate(RED) / theater 가드 / measure / default-OFF until proven.

### G1 — cross-vendor 모델 다양성 〔synthesis 74% / diversity≈0 직격〕 ★최고 ROI 후보
- **현 갭(확정)**: `selection-types.ts`의 `CandidateFamily`=파일 co-change family지 model vendor 아님. voter들 single `port: opts.llm` 공유. generate port에 model/vendor 인자 0.
- **메커니즘**: (a) 후보생성을 distinct vendor family(우리 dual-LLM-provider seam)에서 라운드로빈; (b) judge/voter panel도 이종 vendor. 같은 모델 N병렬(현 verify-select-concurrency)은 상관높아 74% 다같이틀림 → 패밀리 탈상관으로 정답이 풀에 등장할 확률↑ + selection bias 탈상관.
- **seam**: `selection-executor.ts` generate 루프에 vendor-rotation port 주입; `selection-types.ts` generate/voter 시그니처에 `modelLane` 추가; dual-provider 어댑터 재사용(신규 transport 금지).
- **hellgate**: RED = 단일벤더 N샘플의 distinct-patch rate가 floor 미만(diversity=0 재현) → vendor-rotation ON시 distinct rate↑ 증명(wiring-proof, replay LLM seam).
- **theater 가드**: "field 추가"로 끝내지 말 것 — **pool diversity(distinct-patch/distinct-fix-site rate)와 corpus resolved uplift 둘 다 측정**. uplift 없으면 net-neg 선언(메모리: verify-select 5×레버 over-claim 철회 전례).
- default-OFF until A/B win. 비용: generation budget↑(이종벤더 호출) → ROI는 uplift/비용으로.

### G2 — paired-control admission 게이트 〔13033 env/import false-red 제거〕
- **현 갭(확정)**: `repro-test/select.ts:245` reproduced-only. base-control PASS 단계 0.
- **메커니즘(joy-2)**: self-test가 base서 FAIL **AND** gold-free happy/edge control 2개가 base서 PASS일 때만 admit. env/import 깨짐으로 인한 false-red(우리가 자작 메시지 만든 한 원인) 제거 + edge=gold-free regression sentinel.
- **seam**: `repro-test/select.ts` outcome union(`types.ts:108`)에 control 결과 추가; admission predicate를 `reproduced && controlsGreen`로. control 테스트 생성은 기존 repro-gen 재사용(gold 안 봄).
- **hellgate**: RED = env-broken base(import 깨짐)서 symptom test가 FAIL→현재 admit됨 재현 → 게이트 ON시 control-FAIL로 reject 증명. paired-control(red-on-injection).
- **theater 가드**: **base서 control-PASS rate 먼저 측정** — control도 같은 env로 false면 게이트 무효(joy-2 caveat). control-PASS rate가 충분히 높을 때만 의미.
- default-OFF until measured.

### G3 — PATCH-vs-TEST attribution router 〔13033, retry 재타겟〕 ⚠️theater-risk
- **현 갭(확정)**: `attributeFailure/blameTest` 0. `retry-policy.ts` DEFAULT_POLICY는 real-fail을 attribution 0으로 종료. repro-doubt는 one-shot threshold steer지 per-failure 분류기 아님.
- **메커니즘(joy-1)**: 실패가 (i)자작테스트 결함이냐 (ii)패치 결함이냐 분류 → (i)면 오라클 재생성, (ii)면 source 재편집 seed.
- **seam**: `retry-policy.ts` validation-fail 버킷에 attribution 분기; `selection-repair-seed` 경로 분기.
- **theater 가드(强)**: LLM-router=메모리가 기록한 theater 재발 클래스. **wiring-proof + A/B로 TEST-fault routing이 실제 false-red를 flip하는지 측정 전엔 win 금지.** classifier가 무작위/항상-patch-fault면 무효 → 분류 정확도 별도 측정.
- 우선순위: G1/G2 뒤. paired-control(G2)이 false-red를 입구에서 막으면 이 router의 (i)분기 필요성이 줄어 — **G2 측정 후 잔여 false-red 있을 때만 G3.**

### G4 — NL rubric judge (Correctness/Safety/Simplicity) 〔13033 보조〕 ⚠️theater-risk·최후순위
- **현 갭(확정)**: `selection-finalize.ts:195,438` `rubricScore:null` 하드코딩 빈슬롯. src에 rubric 텍스트 0.
- **메커니즘(acoder-6)**: NL 3축 rubric로 후보별 독립 binary vote. inference rubric은 gold 안 읽음(offline trait-tuning만 gold-free fence).
- **theater 가드(强)**: unanchored self-grade=메모리 theater. **executed oracle(repro/regression) 통과한 후보에만** rubric 적용(판정 뒤단). rubric 단독 랭킹 금지.
- 우선순위: 최후. G1(cross-vendor judge panel)이 랜딩되면 그 panel 위에 rubric을 얹는 게 자연스러움 → G1 종속.

---

## PHASE 2 — PARTIAL/약점 하드닝

### H1 — spec-fidelity-invariant 동적메시지 커버 〔13033 잔여 갭〕
- **현 약점**: declared-expected matcher가 동적 f-string/%-format/`.format`엔 abstain(fail-open). 동적 wrong-message 못 잡음.
- **메커니즘**: AST 기반 기대-문자열 추출(format 호출의 리터럴 골격 비교)로 abstain 영역 축소. gold 안 봄(이슈텍스트·코드 AST만).
- 우선순위: P0에서 spec-invariant가 win 내면 그 다음. win 없으면 메커니즘 자체 재검토.

---

## 시퀀싱 요약 (SOTA++)
1. **P0(측정)** — 켜고 frozen-slice A/B. 신규코드 최소. "닫힘"→"증명". ★언블로커.
2. **G1 cross-vendor** — REAL·최고 ROI(synthesis 74% 직격)·theater 가드는 diversity+uplift 이중측정.
3. **G2 paired-control** — REAL·13033 입구방어·control-PASS rate 선측정.
4. **H1 동적메시지** — spec-invariant가 P0서 win냈을 때.
5. **G3 router / G4 rubric** — theater-risk·종속성(G2/G1 뒤)·측정 전 win 금지. 잔여 false-red 있을 때만.

각 단계 DoD = official resolved↑ + regression flat/down + 해당 케이스 flip 측정(다회). 측정 전 "흡수 완료" 선언 금지.

## 즉시 차단해야 할 재발 함정(메모리)
- wired≠engages: 모든 신규 게이트에 red-on-injection teeth.
- n=1 귀속 금지: 교차런·failToPassFailed 분포.
- gold-as-ours: model_patch만 신뢰, .tmp dataset patch폴백 금지.
- 동시채점=false-neg: SERIAL only, 유저 박스 live면 금지.
- over-claim 철회 전례: diversity/판정패널은 uplift 측정 전 win 금지.
