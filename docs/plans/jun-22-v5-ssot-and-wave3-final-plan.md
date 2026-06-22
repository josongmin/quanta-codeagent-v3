# jun-22 v5 — SSOT 통합 + Wave-3 배선 최종 구조 플랜 (SOTA++, breaking-change OK)

> 전제: ROI 무관, 업계 SOTA++ 방향, breaking change 허용. 정본 아키텍처로 재구조화.
> 적대 어딧 결과 "커밋 코드엔 중복 0"이지만, (a) 라우터-입력 SSOT가 두 agent 사이
> 충돌 코스, (b) posture 합성이 이중소스, (c) Wave-3 미배선 — 이 셋을 구조적으로 종결.

## 목표 아키텍처 (SSOT 레이어링)

```
              ┌─ LlmEvidencePacket  ← 단일 ORIGIN (blindness-audited, 6섹션)
 evidence ────┤
              └─ projectRouterEvidence(packet) → RouterEvidence  ← CQRS read-model
                     ├ facts: EvidenceFacts   (lean 불리언 = gap/citable 구동)
                     ├ rendered: string       (renderLlmEvidencePacket, 모델이 읽는 본문)
                     └ origin: {revision, hash}

 posture  ──── KnobModule 카탈로그  ← 단일 SSOT
                     ├ expandModules([...]) → preset 리터럴 (빌드타임, 정적 preset)
                     └ derivePhasePosture(base, PHASE_MODULES[action]) → 런타임 phase posture

 control ──── decision-schema (닫힌 enum + fail-closed parser)
              transitions (bounded 상태기)
              controller runAdaptiveEscalation<RouterEvidence> (router/executor 주입포트)

 wiring  ──── prepareAttemptContext(posture 주입) ← runInstanceOnce(adaptive-escalate 게이트)
              router port = LLM structured-output (llm-risk-gate 패턴 재사용)
              executor port = derivePhasePosture → phase 실행 → fresh packet → project
              report 단일소스 (BenchKnobState 1개가 report+knobs_applied+config 구동)
```

핵심 원칙: **evidence는 packet 1개 origin + projection, posture는 module 1개 SSOT + 정적/런타임 두 폴드, control은 그대로, wiring은 주입식.** 두 곳의 "이중 소스"가 각각 "1 origin + 파생"으로 붕괴.

---

## 결의 1 — posture 합성 SSOT (module 정본, preset 파생)

**문제**: capability 번들이 `presets.ts`(KNOB_PRESETS 리터럴)와 `capability-profiles.ts`(composites) 두 곳. equivalence 테스트로만 동기화.

**해결**: KnobModule 카탈로그를 SSOT로. preset은 `expandModules([base, ...modules])`로 **계산**. 프리셋 25개 분류:
- **frozen 리터럴 8개** (verbatim 유지): `baseline`, `agentless-v1`(freeze), `agentless-v2`(frozen arm), `agentless-v2-safe`(진짜 subtraction), 3 base(`v1`/`v3-thin`/`v3-thin-strict`는 자기 base 리터럴), legacy 3(`agentless-full`/`hint-only`/`everything`)
- **composable 9개**: 기존 composites + base-self → `expandModules` 전환
- **research arm 8개**: 신규 모듈 11개 추가하면 전부 module 파생 (counterfactual/llm-risk-gate/repro-vote/repro-doubt/closure-repair/multi-agent/steer-off 등)

**신규 모듈** (capability-profiles.ts): `STEER_OFF, NOEXEC, ROUND0_MINIMAL, PATCH_HYGIENE, MULTI_AGENT, COUNTERFACTUAL, LLM_RISK_GATE(mode), REGRESSION(mode), REPRO_VOTE, REPRO_DOUBT(n), CLOSURE_REPAIR(n)` + 3 base 상수(`LOCALIZATION_CORE`/`THIN_BASE`/`THIN_STRICT_BASE`) + `expandModules(mods)` 빌드타임 폴드.

**구조 개선**: `SELECT_N(n)`이 지금 `verify-select-regression:discovered`를 번들 → **분리**(SELECT_N은 verify-select만, `REGRESSION(mode)` 별도) = "1 모듈 = 1 capability" (DETACH paired-control 불변식 유지).

**drift 불가 by construction**: composites 배열을 capability-profiles.ts에서 export → `presets.ts`(expandModules)와 `PHASE_MODULES` **둘 다 같은 배열 참조**. 두 소스가 한 배열이 됨 = 테스트 핀이 아니라 구조로 동치.

**하드 불변식**: 모든 preset 이름이 `resolveBenchKnobs`에서 **byte-identical knob map** 산출(전후 동일). 리포트는 preset 이름만 저장(presetHash 없음 — grep 0) → 이름→동일knob 재현이면 모든 기존 `preset:<name>` 결과 재현됨.

---

## 결의 2 — 라우터-입력 SSOT (CQRS read-projection)

**문제**: lean `EvidenceFacts`(내 것) vs `LlmEvidencePacket` 직접(타 agent 미커밋) — 둘 다 라우터 입력일 수 없음.

**해결**: `LlmEvidencePacket`을 **단일 origin**, `RouterEvidence`를 거기서 파생한 read-model.
```ts
interface RouterEvidence {
  facts: EvidenceFacts      // lean 불리언 (deriveEvidenceGaps + evidenceIdsOf 구동)
  rendered: string          // renderLlmEvidencePacket(packet) = 모델이 읽는 blindness-audited 본문
  origin: { evidenceRevision: string; instanceIdHash: string }
}
projectRouterEvidence(packet) → RouterEvidence
deriveEvidenceFactsFromPacket(packet) → EvidenceFacts  // 유일한 신규 파생 로직
```
- controller P = `RouterEvidence`, `citableIds = evidenceIdsOf(re.facts)`, 프롬프트 = `buildRouterPrompt(re.rendered)`
- **두 접근 모두 흡수**: lean facts = `re.facts`(packet-populated), packet-direct = `re.rendered`. 타 agent의 `citableEvidenceIds`/`buildAdaptiveRouterPrompt`는 **삭제**(중복).
- **evidence-facts.ts 유지**(적대 어딧 권고대로) — 단 producer(`deriveEvidenceFactsFromPacket`)가 생겨 packet 단일 origin 확보. 더는 orphan 아님.
- blindness 보존: 모델은 `re.rendered`만 봄 = `renderLlmEvidencePacket`(cleanPacket+assertPacketBlind) 거친 바이트.

---

## 결의 3 — Wave-3 production 배선

1. **posture 주입 seam (breaking)**: `prepareAttemptContext(instance, sandbox, deps, signal, posture)` — 내부 `benchOptIns()` 삭제, posture를 인자로. body는 이미 posture를 data로만 씀(최소 침습). `runInstanceOnce`가 `baseState = resolveBenchKnobs(env)` 한 번 → `basePosture` 주입. `RunInstanceDeps.benchState?: BenchKnobState`(SSOT) 추가.
2. **router port** = 기존 `llm-risk-gate.ts`(`evaluateLlmPatchRisk`) 패턴 1:1 재사용: `llm.stream({system: buildRouterInstruction(), user: buildRouterPrompt(re.rendered), responseFormat: ADAPTIVE_DECISION_JSON_SCHEMA})` → raw 반환 → controller가 `parseAdaptiveDecision`로 fail-closed 검증(responseFormat은 best-effort, 진짜 게이트는 parser+citableIds).
3. **executor port** = `derivePhasePosture(baseState, modules) → prepareAttemptContext(phasePosture) → runMainPhase → buildPostPhaseLlmEvidencePacket → projectRouterEvidence`. fresh packet이 새 proof/repro 상태 반영 = 루프가 adaptive(run_public_repro → baseRepro 확립 → 다음 route가 run_proof_clean 가능).
4. **report 단일소스 (obligation-2, breaking)**: 현재 `resolveBenchKnobs(env)` **3중 독립 호출**(`collectBenchKnobsTelemetry` core.ts:173, `emitKnobsApplied` driver.ts:1898, `buildConfig` driver.ts:1698) → 전부 주입된 `BenchKnobState` 1개로. adaptive면 phase별 `knobs_applied` + 실행 posture 시퀀스 기록 = report≠applied split-brain 봉인. **report-fidelity 테스트 추가**(equivalence hellgate의 behavioral() strip이 안 덮는 경로).
5. **default-OFF 게이트**: 신규 knob `adaptive-escalate`(`QUANTA_BENCH_ADAPTIVE_ESCALATE`), `benchPostureFromState`에 `adaptiveEscalate:boolean`(unset⇒false⇒byte-identical 오늘). 어떤 preset도 아직 참조 안 함 — **promotion은 oracle 측정 A/B 후로 deferred**(n=1 금지).

---

## Breaking changes (전수)

| # | 위치 | 변경 |
|---|---|---|
| 1 | `prepareAttemptContext` (driver.ts:3433) | `posture: BenchPosture` 인자 추가, 내부 benchOptIns() 삭제 |
| 2 | `emitKnobsApplied` (driver.ts:1898) | `(stream, state: BenchKnobState)` |
| 3 | `buildConfig` (driver.ts:1698) | 주입 benchState/active posture 읽기 |
| 4 | `collectBenchKnobsTelemetry` (core.ts:173) | `state?: BenchKnobState` |
| 5 | `runInstanceOnce` (apps/bench driver.ts:1061) | baseState 1회 resolve + 주입 + adaptive 분기 |
| 6 | `RunInstanceDeps` | `benchState?` (+optional activePosture) 추가 |
| 7 | `presets.ts` | composable 17개 → `expandModules([...])`, frozen 8개 리터럴 유지 |
| 8 | `.js` 미러 | 편집한 .ts 전부 재생성 (stale .js shadow 주의) |
| 신규 | router-evidence.ts / router-port.ts / executor-port.ts / adaptive-escalate.ts / buildPostPhaseLlmEvidencePacket | 추가 |
| 삭제 | 타 agent 미커밋 `citableEvidenceIds`/`buildAdaptiveRouterPrompt` | projection으로 대체 |

---

## 단계별 migration (각 단계 green 유지, byte-identical 불변식)

- **P0 — golden snapshot 안전망**: 손대기 전, 모든 preset 이름의 `resolveBenchKnobs().values`를 inline fixture로 동결. 이후 모든 단계 통과해야 함. (재현성 오라클)
- **P1 — module 카탈로그**: 신규 11모듈 + 3 base + `expandModules`, `SELECT_N`/`REGRESSION` 분리, 기존 composites에 `REGRESSION("discovered")` 명시. posture hellgate EQUIV green 확인.
- **P2 — composable preset 전환**: (C) 9개 → expandModules, base-self 먼저(base 리터럴 1곳). 각 전환 후 P0 snapshot.
- **P3 — research arm 전환**: (R) 8개 → expandModules(신규 R-모듈). 각 후 snapshot.
- **P4 — PHASE_MODULES 공유 배선**: presets.ts와 PHASE_MODULES가 같은 export 배열 참조 → SSOT 루프 닫힘.
- **P5 — evidence projection**: router-evidence.ts(RouterEvidence + projectRouterEvidence + deriveEvidenceFactsFromPacket) + 헬게이트(packet→facts paired-control, blindness 보존).
- **P6 — Wave-3 배선**: 주입 seam + router/executor port + buildPostPhaseLlmEvidencePacket + report 단일소스 + adaptive-escalate 게이트. default-OFF byte-identical 확인 + report-fidelity 테스트.
- **P7 — 테스트 정리 + .js 미러**: 자명해진 EQUIV drop, golden-snapshot/base-additivity ratchet 영구화, 미러 재생성.

**각 단계 게이트**: `bun test` (presets/posture/evidence/wiring 헬게이트 + golden snapshot) + 편집 파일 tsc.

---

## 유일하게 deferred (코드 아닌 측정)

`adaptive-escalate` promotion(= 어느 preset에 켤지)은 **oracle 측정 A/B** 후. 코드는 default-OFF로 다 빌드하되, "측정 안 된 oracle 위 promote 금지"(plan 불변)는 지킴. SOTA 숫자 주장도 유료 런 필요 → 측정은 사용자/벤치 몫.

---

## 동시성 현실 (실행 주의)

15개 세션이 `adaptive-escalation/`·`posture/`·`driver.ts`를 churn 중. 이 플랜은 **타깃 아키텍처**고, 실행은 **직렬화 필수**: 단일 owner가 브랜치에서 P0→P7 순차, 단계마다 머지. `git add -A` 금지(내 경로만). hot-file(driver.ts)는 settle 확인 후 진입. 두 agent의 라우터-입력(lean vs packet-direct)은 **projection으로 수렴**(결의 2)이 합의점 — 양쪽 다 그 전까지 라우터-입력 코드 추가 정지.
