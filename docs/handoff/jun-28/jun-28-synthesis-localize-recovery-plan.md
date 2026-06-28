# jun-28 — synthesis/localize 회복 플랜 (rm5 5케이스 RCA → 구체 실행)

작성 2026-06-28. rm5 재측정(5/5 FAIL, baseline+sticky) RCA 확정본 + 경쟁사 근거 + 단계별 구현.
관련: `[[jun-28-harness-safety-audit-hardening]]` `[[jun-27-11141-model-gap-controlled]]` `[[jun-20-bestofn-wrong-repro-oracle-root]]` `[[no-heuristics-only-validated]]`

## 0. 확정 사실 (raw 검증됨, 추측 아님)
5케이스(경쟁사 22-27/134 풂 = 천장 아님), 우리 baseline·sticky 둘 다 0/5. sticky 무관 확정(전부 F2P-못고침/회귀0).

| instance | gold 파일 | 우리 실패 | repro oracle(report) | 클래스 |
|---|---|---|---|---|
| sympy-23413 | normalforms.py | over-eng(rank/flag/restore 덧댐, gold=loop cap치환) | installed=false `execution_failed` | synthesis |
| pylint-4970 | similar.py | wrong synthesis | installed=false `no_reproduced_candidate` | synthesis+oracle부재 |
| sympy-15976 | mathml.py | wrong synthesis | installed=true 2-3/5 | synthesis(oracle有) |
| django-14376 | base.py+**client.py** | base.py만/sticky는 connection.py(오답) — **client.py 누락** | installed=true 5/5 | **multi-site miss** |
| pylint-7080 | **expand_modules.py** | pylinter.py/utils.py(읽긴읽음) — **edit-site 승격 실패** | installed=false `no_reproduced_candidate` | localize/one-hop |

raw 출처: gold=`/tmp/camp-rm5-b201.jsonl` / baseline report=`~/Library/quanta-codeagent-v3/bench/full-remote/report-i-0b506c67f5db00f2b.json` / sticky=`...report-i-077a014568a29de49.json` / **trajectory(per-turn 있음)**=`...trajectory-i-0b506c....jsonl`(17MB)·`...-077a01....jsonl`(33MB) / preds(patch body)=`...preds-i-*.jsonl`.

### 0.1 live-code anchors (중복구현 방지)
- trajectory recording은 이미 default-ON: `tests/unit/bench-trajectory-default-on.test.ts:50-95` / `src/apps/bench/trajectory.ts`. Phase 1의 "강제"는 신규 knob 구현이 아니라 **캠페인에서 opt-out 금지 + custom path 확인**으로 처리.
- repair breadth fan-out은 이미 driver seam 있음: `src/runner/batch/eval/repair-breadth.ts:42-59`, `:139-184`, `:209-222`. 양쪽 driver wiring: `src/runner/batch/eval/driver.ts:3206-3305`, `src/apps/bench/eval/driver.ts:683-786`.
- breadth selector/finish-gate authority는 `src/runner/batch/eval/repair/index.ts:135-196`, `:219-238`. `clearedAsValidated`는 현재 private; Phase 3 reducer가 같은 판정을 써야 하면 여기서 좁은 helper를 export해야 함. 별도 selector 재구현 금지.
- repair type fence는 `src/runner/batch/eval/repair/types.ts:1-17`, `:28-53`, `:69-100`. hidden SWE-bench 필드(`FAIL_TO_PASS`, `test_patch`, official report json)는 타입에 추가 금지.
- `verify-select`는 retired로 고정되어 있음: `tests/unit/kernel/experiment-lifecycle-ratchet.test.ts:60-63`, `:123-132`. Phase 4는 retired selector 부활이 아니라 repair-loop/rerank 후보 ordering만 허용.

## 1. 경쟁사 근거 (검증됨, code-agent-loop/*.md)
- claude-code 프롬프트: "smallest correct change" / "pick the minimal **covering set**" / "R2 Run-verify: 안 돌렸으면 done 금지, test=시나리오 통과 AND 회귀0" → 우리 over-eng·multi-site·verify 갭 정조준.
- cursor localize: 서버 symbol-graph(`getReferencedSymbols`/`getDefinedSymbols`+LspSubgraphChunk+embeddings) → one-hop downstream·sibling 추적(7080/14376).
- ⚠️ SWE-bench 인스턴스별 경쟁사 trajectory는 **없음**(results.json 매트릭스만).

## 2. 구현 (단계 순서 = 하드 의존, 어기면 weak-oracle 위 blind search)

### Phase 1 — oracle persistence + canonical fail-closed ★먼저
**왜:** 3/5서 repro `installed=false` = verifier가 candidate 판별 불가. 이 위에 reducer/expander auto-adopt = 그럴듯한 오답 선택기.
- **persistence**: candidate patch + generated repro script + repro stdout/stderr + sidecar JSON 전부 저장(selected/reproduced subset만 저장 금지).
  - 위치: `src/agent/repro-test/pytest-report.ts`, `src/agent/repro-test/execute.ts`, `src/runner/batch/eval/repair/validator.ts`, `src/runner/batch/eval/repro-vote.ts`
- **fail-closed**: missing repro = "검증불가"로 남김. stdout sentinel/weak success text로 submit gate 통과 금지. hardening repro는 advisory/offline, submit gate는 canonical만.
- **authority schema gap**: 현재 `ValidatorResult`에는 `authority` 필드가 없음. Phase 3의 `validator.authority === canonical-sidecar` 같은 조건은 그대로 구현 불가. Phase 1에서 `proofAuthority: "canonical_sidecar" | "agent_verify_cmd" | "none"` 같은 좁은 필드를 추가하거나, canonical-sidecar 여부를 별도 typed wrapper로 넘겨야 함.
- **knob**: trajectory는 default-ON이므로 신규 default 변경 금지. 캠페인 runner에서 `QUANTA_BENCH_RECORD_TRAJECTORY=0/off` opt-out 차단 + prediction/patch persistence 경로를 report에 남김.
- **선행 측정**: repro 생성이 왜 false인지(no_reproduced_candidate vs execution_failed) instance별 — `[[jun-20-repro-gen-python-version-rca]]`(python버전 매핑) 재확인.
- **stop rule**: Phase 1 green 전에는 Phase 2/3 후보를 "generated/advisory"로만 기록. submit/adopt/leaderboard credit 금지.

### Phase 2 — evidence-expander (14376/7080, localize)
oracle md가 gold 없이 예측한 trap을 **public evidence로 재구성**(gold leakage 금지):
- offline: oracle md에서 일반화 failure label만 추출(`test-domain-to-second-site`, `one-hop-downstream-edit-site`, `false-easy-multisite`).
- runtime 입력(public only): issue-mentioned files, touched files, read-but-not-edited files, agent가 실행/생성한 public repro/test names/module paths, traceback/symbol, cheap grep/callgraph one-hop.
- 금지: official `FAIL_TO_PASS`/`PASS_TO_PASS`/gold patch에서 test path를 읽어 expander 입력으로 쓰는 것. "F2P"라는 이름을 쓰더라도 public run/trajectory에서 관측된 테스트만 허용.
- 위치: `src/runner/batch/eval/repair/evidence-expander.ts`(신규) — F2P test-domain→missing edit-site 후보(14376: dbshell.test_mysql→client.py / 7080: pylinter→expand_modules._is_ignored_file). types: `repair/types.ts` `RepairEvidenceHint`/`RepairLocalizeHint`. 주입: `repair/index.ts` repair context. fan-out: `repair-breadth.ts` 후보에 추가. driver: `driver.ts`/`apps/bench/eval/driver.ts` repair rounds 직전 evidence packet.
- **oracle 전엔 auto-adopt 금지 — 후보 생성까지만.**
- test rail: `tests/unit/evidence-expander.test.ts`(pure no-leak), `tests/unit/repair-evidence-expander-integration.test.ts`(seed/fan-out), existing `tests/unit/repair-breadth-selection.test.ts`에 no-leak assertion 확장.

### Phase 3 — patch-reduction (23413/15976, over-eng synthesis)
- 위치: `src/runner/batch/eval/patch-reduction.ts`(신규, driver-side: fork/apply/validate 필요). hook: `src/runner/batch/eval/repair-breadth.ts:162-184`의 `runOneBreadthCandidate` 직후 reducer 호출(`RepairBreadthDeps.reduceCandidate?` 포트 추가). reducer가 patch 바꾸면 새 `adopt`도 같이 생성.
- pure generator `generateReductionCandidates(patch)`: added assignment/branch/flag/restore-block 제거 + **loop-bound relaxation operator**(`for i in range(m-1,m-1-rows,-1)`→`range(m-1,-1,-1)` + 없으면 `if k==0: break`) ← 23413 gold 생성, 단순삭제만으론 못 살림.
- 검증: 기존 validator 재사용. `clearedAsValidated`가 private → `repairCandidateClears(args,v)` helper export해서 공유.
- **adopt 조건(하드)**: Phase 1에서 추가한 canonical authority가 있고 `repairCandidateClears(args, validator) === true`일 때만. 아니면 `advisoryCandidates`에만 저장("generated, not eligible"). official grader는 loop 내부에서 절대 호출하지 않음; 최종 채점 1회만.
- ✅ retired verify-select 함정 회피(empty-laundering 없음, 원본 fallback).
- test rail: `tests/unit/patch-reduction.test.ts`(pure generator), `tests/unit/patch-reduction-driver.test.ts`(fork/apply/validate/adopt), `tests/unit/patch-reduction-no-leak.test.ts`(gold field 접근 불가 + missing-oracle adopt 0).

### Phase 4 — best-of-N / rerank
authority-validated 후보 위에서만. (retired hard-veto selector 재활성화 ❌ — `experiments.ts:45`/`selection-finalize.ts` deprecated. 레버는 repair-loop: `repair-breadth.ts`/`repair/index.ts`.)
- scoring source: canonical-sidecar green > strong-oracle non-contradicted green > validated red rank(`reproOutcomeRank`) > advisory hints. LLM self-score/weak stdout text는 tie-break에도 금지.

## 3. 테스트 (각 Phase 필수 3종)
- pure generator: input over-eng patch → output에 minimal+loop-cap 후보 존재.
- fan-out integration: candidate A red, reduced/expanded B green → outcome가 B로 교체 + adopt(B).
- no-leak/default-off: knob off면 호출 0 + deps/type에 gold/official 필드 없음 + missing-oracle면 adopt 0(advisory만).
- parity rail: `bun test tests/unit/bench-trajectory-default-on.test.ts tests/unit/repair-breadth-selection.test.ts tests/unit/repair-breadth-driver-fanout.test.ts tests/unit/kernel/experiment-lifecycle-ratchet.test.ts`는 Phase별 신규 테스트와 같이 유지.

## 4. 함정 (이번 세션 실측)
- 장시간 런 `nohup bun &` 금지(~15-20분 reap, 박스 orphan) → supervisor([[feedback-bg-launch-supervisor-not-nohup]]).
- preset 추가는 PRESET_SPECS SSOT 경유(parity 게이트). knob DEFAULT-OFF byte-identical.
- 동시런 throttle=grader-invalid 제외분류. 채점 SERIAL+원격 정본.
- spot-reclaim 재발사 있음 → green-tally backup오염, ■PASS/FAIL 정본.

## 5. 한 줄 요약
oracle-first(Phase1) 안 하면 expander/reducer/best-of-N 다 weak-oracle 위 blind. 순서 엄수. arm 준비됨=`agentless-v6-singlepass-execfull-sticky`(B1 sticky 측정용, 단 sticky는 이 5케이스 무관 확정).
