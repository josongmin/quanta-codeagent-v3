# Ticket — Observation Providers (`<quanta_observations>` evidence kernel)

- **Date:** 2026-07-06
- **Status:** DESIGN LANDED (`docs/plans/jul-6-observation-providers/README.md`, 3R 적대어딧 + 외부리뷰 반영). Implementation NOT started.
- **Provenance:** 경쟁사 리뷰(SWE-agent/Agentless/ACI) → 갭 확인(엔진·LSP 있으나 structural evidence 미주입) → 3라운드 적대어딧 → 외부리뷰 5항 반영. 코드 대조로 anti-dup 확정.
- **Goal:** 정적엔진(semantica IR/CFG/DFG/callgraph)·LSP·외부신호를 **상황별로 골라 evidence로 주입**하고 **refute critic + enforcement SSOT**로 묶어, 프롬프트 설득이 아니라 계측된 evidence로 localization/patch 품질을 올린다. **전부 default-OFF, measure-gated.**
- **Design SSOT:** [docs/plans/jul-6-observation-providers/README.md](../plans/jul-6-observation-providers/README.md) — 스키마/critic/페이징/측정은 거기가 정본. 이 티켓은 실행 분해.

> **North-star 제약:** overtrust(HINT_OVERTRUST)가 이 방향의 유일한 킬러. 모든 스트림은 (a) default-OFF, (b) 주입 0인 것부터(critic/shadow), (c) `hint_follow_without_verify_rate` 무회귀를 게이트로.

---

## ALREADY DONE — 재구현 금지 (anti-duplication)

- **issue-hint 주입 seam**: [agentless-localize.ts](../../src/agent/issue-hint/agentless-localize.ts) `composeAgentlessHint`(file+한줄 이유) + [compose.ts](../../src/agent/issue-hint/compose.ts) `composeIssueHint`(symbols/expected-actual/codeFence/traceback — issue 텍스트 파싱). 주입 배선 = `localize-prep.ts#prepareIssueHint` → `attempt-context.ts#localizeCandidates`. **renderer는 이걸 승격, 재작성 금지.**
- **semantica 엔진 seam**: [repro-grounding.ts](../../src/runner/batch/eval/repro-grounding.ts) + selection-gates에 swap-seam 존재(jun-29 grounding). `static-owner`/`callgraph-impact` 백엔드는 **이 seam 재사용**.
- **LSP 도구**: `config-build.ts` `lspNavToolList`/`lspNavCheapToolList`(lsp_definition/references/document_symbol). `lsp-prefetch`는 loop-전 호출로 재사용, 도구 재정의 금지.
- **scope enforcement**: `QUANTA_BENCH_PROTECT_TESTS`(config-build.ts:308) 런타임 test-write reject. `scope-guard`는 **같은 규칙원 공유**(SSOT), 새 가드 신설 금지.
- **런타임 가드(별 트랙, 재구현 금지)**: stale-read-guard(read-before-edit)·HARD_DENY(bash)·admissibility-gate(mutating mode). 이 티켓은 evidence **주입**만.
- **replay/determinism seam**: spot-resume cassette(jun-27). observation fragment record/replay는 이 seam에 태움.

---

## 스트림 분해 (병렬 hellgate — 대부분 disjoint 모듈)

각 스트림 = default-OFF 노브 + hellgate 프로토콜(RED e2e → TDD+구조 → 적대어딧≥3R → 셀프어딧 → 구조TDD보완). **순수 leaf 우선, 배선은 단일 seam 1지점.**

### S1 — [P0] OwnerCritic (refute) — 주입 0, 최우선·최안전
- **What:** [design §5](../plans/jul-6-observation-providers/README.md). `OwnerCritic.refute(edited, ctx): RefuteResult` (`refuted|not_refuted|inconclusive` 3-way — not_refuted≠confirmed). semantica callgraph/def-use로 편집 owner 반증. 편집-전/patch-전 게이트.
- **Where:** 신규 `src/agent/observation/critic.ts`(port+타입) + semantica 어댑터. 배선 = repair/edit 게이트 1지점(observe-only 먼저).
- **Knob:** `QUANTA_OBS_CRITIC` default-OFF.
- **Done:** refute 3-way 순수 로직 + red-on-injection(도달불가 심볼 넣으면 refuted, dynamic dispatch면 inconclusive) + observe-only 배선(모델 행동 불변, `critic_saved_edit_rate`만 기록). byte-identical when off.
- **Dup-check:** critic 개념 부재(admissibility-gate는 mode 게이트지 owner 반증 아님) ⇒ 신규.

### S2 — [P1] static-owner SHADOW harness — 주입 0
- **What:** [design 페이징 P1](../plans/jul-6-observation-providers/README.md). static-owner(semantica def-use)가 실제 성공-patch owner를 맞히나 **오프라인 precision** 측정. 모델에 안 보여줌.
- **Where:** 신규 `src/agent/observation/providers/static-owner.ts`(produce) + eval-side shadow 수집(gold/success-patch touchedFiles vs provider owners). semantica seam 재사용.
- **Knob:** `QUANTA_OBS_STATIC_OWNER_SHADOW` default-OFF.
- **Done:** shadow precision/recall 리포트(주입 0, observe-only). precision 게이트 값은 측정 후 정함(no-heuristic — 임의 임계 금지).
- **Dup-check:** localizeCandidates는 Agentless LLM 산출이지 def-use 아님 ⇒ 신규.

### S3 — [P1b→P2] Observation port + Fragment 스키마 + renderer (구조 코어)
- **What:** [design §1-4](../plans/jul-6-observation-providers/README.md). `ObservationProvider` port, `ObservationFragment`(숫자 confidence 없음, `EvidenceStrength` 순서형), `renderObservations`(top-k + `anti_signals` 상시 + routing-hint 헤더). `composeIssueHint` seam 승격.
- **Where:** 신규 `src/agent/observation/{port.ts,fragment.ts,render.ts}`. 배선 = 기존 issue-hint 주입 seam 1지점.
- **Knob:** `QUANTA_OBS_RENDER` default-OFF. **off일 때 `## Issue Hints`와 byte-identical**(호환 모드).
- **Done:** renderer 순수(top-1 금지 테스트·anti_signals 상시 존재 테스트·strength 순서형·숫자 confidence 부재 가드) + agentless를 프로바이더로 이식해 off=byte-identical.
- **Dup-check:** compose.ts 승격이지 신규 조립 아님.

### S4 — [측정] usage/overtrust 계측 레일
- **What:** [design 실험설계](../plans/jul-6-observation-providers/README.md). `owner_edit_hit_rate`·`hint_read_rate`·`hint_verify_rate`·**`hint_follow_without_verify_rate`(overtrust 조기경보)**·`critic_saved_edit_rate`·`wrong_owner_edit_rate`. 실패 taxonomy.
- **Where:** eval observe/trajectory 이벤트에 attribution 태그 + 집계기. trajectory seam 재사용(redact 주의).
- **Knob:** 계측은 observe-only(항상 안전), 게이트 아님.
- **Done:** 각 metric이 trajectory 이벤트에서 결정적으로 유도됨(합성 fixture로 red-on-injection) + stratified slice 태깅(misleading-hint/dynamic-dispatch/one-file/multi-file/lockfile-trap).
- **Dup-check:** 기존 leaderboard 지표는 resolved만 — usage/verify 지표 부재 ⇒ 신규.

### S5 — [P3+] impact/scope/lsp-prefetch (S3 이후, 조건부)
- **What:** `callgraph-impact`(impact_surface, 필드별 A/B) + `scope-guard`(protect-tests SSOT 커플) + `lsp-prefetch`(턴절약). **S3 port 위에**, P0·P1b 신호 확인 후.
- **Gate:** S3 완료 + P0/P1b heldout net-positive 전엔 착수 금지.
- **Done:** 각 provider 순수 + 노브 + off byte-identical. scope-guard는 `QUANTA_BENCH_PROTECT_TESTS`와 규칙원 공유(SSOT 테스트).

---

## 병렬 실행 계획 (hellgate, 이번 스프린트)

- **동시 착수 가능(disjoint):** S1(critic) · S2(shadow) · S4(계측 레일) — 서로 파일 안 겹침, 전부 주입 0/observe-only라 제일 안전.
- **S3(port/renderer)** 은 S1·S2 타입을 소비하므로 **인터페이스 먼저 합의**(port.ts/fragment.ts 스텁 선착) 후 병렬.
- **S5는 게이트드** — S3 랜딩 + P0/P1b 측정 후. 이번 병렬 스프린트 **제외**.
- **worktree 규칙**(feedback-worktree-*): HEAD vs main ff 강제, port shape verbatim 공유, hot 공유모듈(runtime-config/knob-registry) 편집은 순차. dead worktree retry 금지.
- **각 스트림 hellgate 산출물:** RED e2e 셋업 커밋 → TDD 구현 → 적대어딧 ≥3R(overtrust/누출/vacuous 축) → 셀프어딧 → 구조TDD. 전부 tsc/biome/leaf-unit green.

## 측정 게이트 (활성화 조건 — no-heuristic)

각 페이즈는 앞이 **stratified heldout net-positive + `hint_follow_without_verify_rate` 무회귀** 증명해야 default 승격. 안 나오면 삭제. picks-3는 smoke, 효능 아님. Verified 오염 → net-gain은 heldout/Pro 기준.

## 비목표

- 런타임 enforcement 신규(이미 있음). · 23KB 프롬프트 손rewrite. · picks-3로 효능 판정. · 임의 precision/confidence 임계.
