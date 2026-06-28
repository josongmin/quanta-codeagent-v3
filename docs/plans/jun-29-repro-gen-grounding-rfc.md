# jun-29 — 재현 테스트 생성 GROUNDING RFC (인풋 부족 → exemplar 주입)

> 날짜: 2026-06-29
> 상태: RFC (3-round 적대어딧 반영 후). 구현 전.
> 스코프: `src/agent/repro-test/generate.ts`(프롬프트), 신규 exemplar-retrieval seam, driver 주입.
> 근거 데이터: A1 per-candidate artifacts(`/tmp/observe-cluster/.../repro/`, 프로덕션 sphinx 캠페인)

## 0. 데이터 근거 (추측 아님)

A1 persistence가 프로덕션서 캡처한 후보별 outcome (sphinx 4인스턴스 × 5후보):
- **exec_failed 8/20(40%)**, reproduced 12/20. execFailure=`test_errored`(pytest 돌았으나 테스트 본문 에러).
- per-instance: 9658·9711 = **5/5 reproduced**(clean), **8595·8265 = 1/5 reproduced**(4/5 크래시).
- 까본 실물: 생성 테스트가 **풀 Sphinx 빌드를 손수 셋업**(tmp srcdir/conf/`Sphinx()`/`build()`). exec_failed든 reproduced든 같은 hand-roll — 셋업 디테일 맞췄냐 틀렸냐 차이.

**진단**: sphinx 실제 테스트는 `@pytest.mark.sphinx`+conftest `app` fixture가 빌드를 다 처리. LLM은 **그 기존 테스트(fixture)를 못 봐서** 빌드를 밑바닥부터 재발명 → fragile → 40% 에러. 8595·8265는 K=5가 겨우 1개 건져 오라클 유지(그 1개도 삐끗했으면 오라클 0). **= 인풋 부족(이슈 텍스트만, repo 테스트/API 컨텍스트 0).**

## 1. 처방 (한 줄)

repro-gen 프롬프트에 **관련 기존 테스트의 SETUP SKELETON + 이슈 심볼 시그니처**를 주입 → LLM이 빌드를 손수 짜는 대신 **repo의 실제 fixture 패턴을 복사**. (Agentless "retrieve existing test to guide gen" + SWE-RL "top-K".)

## 2. 가진 부품 (재발명 금지)

- `repo-regression-discovery-adapter.ts`: `listTrackedPythonFiles`, `readRepoTestFiles`
- `impacted-test-discovery.ts`: `discoverImpactedTestCandidates`(이슈/패치 → 관련 테스트 후보)
- localize(파일 랭킹) + LSP nav(시그니처) + issue symbols(`extractIssueHint`)
- repro-gen `generate.ts`엔 현재 grounding 주입점 0 — 추가 필요.

---

## 3. 3-ROUND 적대어딧 (각 라운드 약점 적출 → 보강)

### R1 — NO-LEAK (최대 리스크: exemplar가 답안지 누설?)
**공격**: 기존 테스트 파일 주입이 gold(FAIL_TO_PASS) 테스트를 노출하면 = answer-key 누수 = leaderboard-gaming.
**적출**:
- SWE-bench는 FAIL_TO_PASS가 대개 `test_patch`로 **추가**됨 → base repo엔 없음(주입 안전). 단 일부는 기존 테스트 **수정** → base 파일에 존재 → 누수 위험 비제로.
- 테스트 **본문(assertion)** 통째 주입 = LLM이 정답 로직 복붙 가능 = 강한 누수.
**보강(설계 확정)**:
1. **SKELETON-ONLY 주입** — 기존 테스트 파일에서 **import + fixture 데코레이터/사용 + 클래스 스캐폴드 + 첫 테스트 `def` 시그니처**만. **assertion 본문 전부 strip**. fixture 패턴(가치)은 살고 정답 로직(누수)은 죽음.
2. **no-leak fence 테스트**(헬게이트): 주입 블록에 `assert`/`FAIL_TO_PASS`/gold 토큰 0, 본문 라인 0 강제(red-on-injection).
3. exemplar는 **이슈-관련 기존 테스트**(impacted-test-discovery) — 정답 검증 테스트가 아니라 **같은 모듈의 다른 테스트**(fixture 공유). 답안 테스트명 derivable하면 제외.
4. base 트리(test_patch 미적용)서만 읽음 — 기존 no-leak fence 재사용.
→ **R1 결과**: skeleton-only + fence로 누수 차단. "full body 주입" 폐기.

### R2 — EFFICACY/SCOPE (진짜 exec_failed 줄이나? 다른 실패모드는?)
**공격**: exemplar 주입이 정말 exec_failed 낮추나? no_reproduced(22%)/over-narrow false-green(74%)도 고치나?
**적출**:
- exec_failed(40%, hand-rolled 셋업 틀림) → fixture skeleton이 **직격**. 8595·8265의 4/5 크래시 타깃.
- no_reproduced(22%, base서 안 깨짐=버그 이해 실패) → 셋업 exemplar로 **안 고쳐짐**(버그 이해 문제). 단 일부는 **wrong-API-guess**(import 맞고 호출 틀림) → **시그니처 주입**이 도움.
- over-narrow false-green(reproduced의 ~74%) → **전혀 안 고쳐짐**(오라클 적합성=별개 레버, hardening-repro/strong-oracle 담당).
**보강(스코프 정직화)**:
- 이 RFC는 **exec_failed floor**를 들어올리는 것 — 가장 기계적+단일 최대 덩어리. **oracle-adequacy ceiling은 비스코프**(별도).
- exemplar(셋업) + **시그니처 주입**(wrong-API subset) 둘 다 — exec_failed + no_reproduced의 API-guess 부분 커버.
- 정직 readout: "exec_failed율 ↓" 측정만 주장. resolved↑는 2차(오라클 모수 좋아지면 acceptance/reproVote가 더 잘 픽).
→ **R2 결과**: 스코프 = exec_failed(+API-guess no_reproduced). over-narrow은 명시적 제외. "resolved 직접 상승" 과장 금지.

### R3 — STRUCTURE/COST/MEASURE (토큰? exemplar 선택 틀리면? 측정?)
**공격**: 테스트 파일 큼(토큰 폭발). 엉뚱한 exemplar 주면 무용/유해. 효능 어떻게 측정?
**적출**:
- 테스트 파일 수천 줄 → 통째 주입 불가. skeleton-only가 이미 대부분 해결하나 **여전히 bound 필요**(N 테스트 스켈레톤 / M 토큰 cap).
- exemplar 선택 틀림(무관 모듈) → fixture 패턴 안 맞음 → 무용. **선택 품질이 관건**.
- 측정: A1 artifacts가 **exec_failed율을 이미 캡처**(공짜 readout!).
**보강**:
- **bound**: top-K(기본 1~2) 테스트 파일, skeleton 후 ≤M토큰(기본 ~1500), 초과시 head-truncate.
- **선택**: `discoverImpactedTestCandidates`(이슈 심볼/localize → 관련 테스트) 1순위, 없으면 같은 디렉토리 테스트.
- **측정-first**: default-OFF knob(`QUANTA_BENCH_REPRO_GROUNDING`). A/B = **A1 outcome.json의 exec_failed율** on/off (per-candidate, 공짜). 회귀: reproduced율 무저하 + no_reproduced 무증가.
- **seam**: exemplar retrieval을 **injected port**(`retrieveExemplarSkeletons(issueSymbols, sandbox) → string[]`)로 — driver가 실 구현(impacted-discovery+skeleton-strip) 주입, generate.ts는 순수.
→ **R3 결과**: bound+선택+공짜측정 확정. injected port seam(generate.ts 순수 유지).

---

## 4. 최종 설계 (3R 반영)

```
generate.ts buildReproTestPrompt(issue, mwe?, exemplarSkeletons?, issueSignatures?)
  + groundingBlock(mwe)                     [기존]
  + exemplarBlock(skeletons)  ← NEW: import+fixture+scaffold만, assertion strip
  + signatureBlock(signatures) ← NEW: 이슈 심볼 공개 시그니처(LSP)
주입: driver가 retrieveExemplarSkeletons(injected port) + LSP 시그니처 → prepareReproTestDeps
gate: QUANTA_BENCH_REPRO_GROUNDING (default-OFF, byte-identical)
fence: skeleton에 assertion/gold 토큰 0 (헬게이트 red-on-injection)
측정: A1 outcome.json exec_failed율 A/B (on/off)
```

## 5. 리트리버 엔진 관련성 (유저 질문)

**이 RFC의 "exemplar 선택"은 본질적으로 RETRIEVAL 문제** — "이 이슈에 맞는 fixture 패턴 테스트가 어느 파일?". 지금: localize/impacted-discovery(lexical/static). 미래 리트리버 엔진(semantic/embedding)이 **직접 업그레이드**:

| 리트리버 수혜처 | 현재 | 엔진 들어오면 |
|---|---|---|
| **repro-gen exemplar 선택**(이 RFC) | impacted-discovery(lexical) | semantic으로 정확한 fixture 파일 픽 → exec_failed 더↓ |
| regression-set 선택(acceptance dual-guard) | LLM이 passing서 제외 | 이슈-관련 테스트만 retrieve → 정밀 |
| localization recall@1 | BM25-lite | embedding 보강 |
| API-usage 컨텍스트(시그니처+예시호출) | LSP 시그니처만 | 실 호출 예시 retrieve |

→ **설계 함의**: exemplar retrieval을 **injected port**(`retrieveExemplarSkeletons`)로 두면, 지금은 impacted-discovery 어댑터로 채우고 **나중에 리트리버 엔진 어댑터로 교체**(generate.ts 불변). 이 RFC가 리트리버의 **첫 소비자**가 되게 seam을 미리 그 모양으로. 즉 리트리버 엔진은 "이 RFC를 더 좋게"가 아니라 **"이 RFC가 깔아둔 port를 채우는 더 나은 백엔드"** — 지금 lexical로 짓고 엔진 오면 무료 업그레이드.

## 6. 단계
1. exemplarBlock + signatureBlock 순수 빌더 + skeleton-strip(assertion 제거) + no-leak fence 헬게이트.
2. `retrieveExemplarSkeletons` injected port + impacted-discovery 어댑터(skeleton-strip 적용).
3. driver 주입(`QUANTA_BENCH_REPRO_GROUNDING` gate) + LSP 시그니처 배선.
4. A/B(A1 exec_failed율 on/off, 회귀 reproduced율 무저하). 박스 free시.
5. (후속) 리트리버 엔진 어댑터로 port 교체.

## 7. 비스코프
- oracle-adequacy(over-narrow false-green) = 별도(hardening-repro/strong-oracle 계보).
- 리트리버 엔진 자체 구현 = 별도(이 RFC는 port만 준비).
- resolved율 직접 상승 주장 = 측정 후에만.
