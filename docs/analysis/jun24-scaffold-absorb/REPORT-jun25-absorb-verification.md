# 흡수 검증 어딧 — 경쟁사 강점이 현재 quanta에 진짜 LANDED-REAL인가 (2026-06-25)

적대 검증 9에이전트. 후보8 각각 LANDED-REAL/PARTIAL/THEATER/ABSENT + matchesClaim + teeth test + 실패모드 도달 판정.

---

Both reader sites confirmed real with live branching. The verification payload is accurate. Assembling the final scorecard.

=== 최종 흡수 스코어카드 ===

## 1) 스코어카드 표

| 후보 | status | matchesClaim | hitsFailureMode | teeth test | 핵심근거 (file:line) |
|---|---|---|---|---|---|
| forward-localize | **LANDED-REAL** | ✅ | ✅ | ✅ real-rg IO | `apps/bench/eval/driver.ts:1499-1514` adaptiveNextPassOwners gated by `posture.forwardLocalize`; `forward-localize-trace.test.ts:95-121` |
| spec-fidelity-invariant | **LANDED-REAL** | ✅ | ✅ | ✅ mutation+red-on-inject | `apps/bench/eval/driver.ts:1151-1156` declaredExpectedPort ONLY when knob ON → `selection-gates.ts:343-353` clean-mode veto; `declared-expected-matcher.test.ts` 24 pass |
| paired-control | **ABSENT** | ❌ | ❌ | ❌ none | `repro-test/select.ts:245` reproduced-only filter, no control-PASS branch; `types.ts:108` outcome union has no control/happy/edge |
| consumer-list-owners-feedback | **LANDED-REAL** | ✅ | ✅ | ✅ sibling-escalate teeth | `apps/bench/eval/driver.ts:1499-1523` siblings→7th forwardLocalizeOwners arg; `adaptive-repair-escalation-owners.test.ts:79-139` |
| differential-f821-gate | **LANDED-REAL** | ✅ | ✅ | ✅ red-on-injection+real py3 | `patch-static-sanity.ts:269` `after - before` subtraction → `selection-gates.ts:283` admissible:false; `patch-static-sanity.test.ts:214` |
| cross-vendor-diversity | **ABSENT** | ❌ | ❌ | ❌ none | `selection-types.ts:104` generate port has NO model/vendor arg; diversity is fix-site/seed only; voters share one `port: opts.llm` |
| F0-empty-patch-extraction | **LANDED-REAL** | ✅ | ✅ | ✅ real-git lost-edits | `sandbox.ts:44` per-candidate fork + `snapshot.ts:229` same-tree capture; `capture-correctness.test.ts:35` |
| patch-vs-test-router+nl-rubric | **PARTIAL** | ❌ | ✅(부분) | ⚠️ repro-doubt만 | `dispatch.ts:236-241` repro-doubt steer (real); `selection-finalize.ts:195,438` rubricScore=null hardcoded; attribution router 부재 |

## 2) LANDED-REAL 5/8

**LANDED-REAL: 5** (forward-localize, spec-fidelity-invariant, consumer-list-owners-feedback, differential-f821-gate, F0-empty-patch-extraction)
**PARTIAL: 1, ABSENT: 2**

**PARTIAL — patch-vs-test-router+nl-rubric에서 빠진 것:**
- joy-1 attribution **router 전부 부재**: self-test-defect vs patch-defect를 가르는 classifier 없음(`patchVsTest`/`attributeFailure`/`blameTest` grep exit 1). `classifyOutcome`은 retry용 transient/real-fail enum이지 attribution 아님. `selection-repair-seed`의 repair-plan은 repro/MWE 오라클을 **무조건 authoritative**로 보고 절대 자기 테스트를 탓하지 않음.
- acoder-6 NL rubric judge **완전 부재**: `rubricScore`는 Phase-2 verifier **빈 슬롯**, 두 prod caller 모두 `null` 하드코딩, researchOnly라 clean-mode 랭킹서 제외. src에 rubric 텍스트 0.
- 실제로 동작하는 건 repro-doubt counter-steer **하나**(heuristic 1-shot, router 아님). 13033 진짜 레버는 NL rubric이 아니라 deterministic gold-free declared-expected matcher(다른 메커니즘).

**ABSENT 2건이 왜 ABSENT인가 (naming collision 함정):**
- **paired-control**: `capability-profiles.ts:31`의 "paired-control" 문자열은 knob-module **detach 속성**(필드 독립성) 설명이지 repro admission 게이트가 아님. joy-2가 요구한 "base에서 happy+edge control 2개 PASS AND symptom test FAIL일 때만 admit" 3단계 중 **하나도 없음**.
- **cross-vendor-diversity**: `family` 필드는 CandidateFamily(파일 co-change: override-family/producer-consumer)지 model vendor 아님. `modelCandidates`는 same-provider model-id swap(QUANTA_RETRY_MODELS, CLI 전용)이고 verify-select 경로에서 호출 안 됨(buildSeeds grep empty). judge panel은 single-vendor lens-label diversity.

## 3) 3대 실패모드 실제 닫혔나

- **13033 (self-generated repro PASS하지만 message-shape 발명/env-import false-red)**: **부분 닫힘 — wiring REAL, win 미측정.** spec-fidelity-invariant + declared-expected-matcher가 static competing literal을 clean-mode hard-veto. 단 (a) **default-OFF**, 어떤 shipped preset에도 미활성(env로만 열림), (b) frozen-slice A/B 미실행 → resolved-rate 효과 unproven, (c) matcher가 dynamic f-string/%-format/.format에는 abstain(fail-open)이라 동적 wrong-message는 못 잡음. **구조는 닫혔으나 효과는 측정 안 됨. claim이 attribute한 paired-control이 아니라 다른 메커니즘이 처리.**

- **14315 (rename으로 인한 net-new dangling consumer ref / forward-consumer 미탐)**: **닫힘 — 두 레버 모두 REAL.** differential-f821-gate가 net-new undefined name을 **default-ON** hard-veto(`patch-static-sanity.test.ts:231`이 정확히 14315-class rename dangling ref 테스트). forward-localize + consumer-list-owners가 prior diff symbol→consumer를 real rg로 surface. **단 resolved-rate Δ 미측정.** 14315 자체에 대한 e2e 미실행(13033 astropy shape만 exercise).

- **11138 (fork-worktree desync로 edit 유실 → empty/wrong-tree patch가 model-miss로 오인)**: **닫힘 — 구조적 fix가 진짜.** per-candidate `forkSandbox` cp-R + 동일 tree에서 capture로 wrong-tree-diff 경로 자체가 제거됨. lost-edits detector가 infra-fail→retry로 라우팅(model-miss로 laundering 안 됨), real-git teeth. **단 detector는 measurement-safety지 per-occurrence root-cause 확정은 못함(코드가 솔직히 인정).**

## 4) 한줄결론

솔직히: 8개 중 5개는 진짜 LANDED-REAL(real reader + 동작분기 + teeth)이고 wrong-tree-diff·F821·forward-localize 같은 **구조적 결함은 실제로 닫혔다** — 하지만 5개 전부 resolved-rate **win은 미측정**(default-OFF research lever거나 A/B 미실행)이라 "흡수=벤치 이득"은 아직 증명 안 됐고, 내가 주장한 8개 중 **3개는 theater/over-claim**이다: cross-vendor diversity와 paired-control은 naming-collision으로 **존재하지도 않으며**(diversity≈0 root cause 직격이라던 강점은 fix-site seed diversity일 뿐 vendor 축 0), acoder-6 NL rubric judge는 빈 슬롯에 null 하드코딩 — 즉 "다양성/판정패널/joy attribution" 계열 흡수는 거의 전부 theater다.
