# jun-19 핸드오프 — SWE-bench 천장(ceiling) 마이닝 + co-change 엣지 경계

## 목적 (왜 이걸 했나)

SWE-bench Verified의 **천장(ceiling)** = 공개 프론티어 스캐폴드 17개(opus45/gem3/o3/deepseek/moatless/OpenHands…)가 **전부 못 푼** 인스턴스 집합(`_scaffold-summary/`, #=0). 우리 모델(Opus-4.8/gpt-5.x)은 그 17개에 없으므로, **천장 중 우리가 푸는 게 곧 published 누구도 못 한 unique win = 진짜 차별화.** 이미 14315 하나를 천장에서 깸(재채점 ✅ 확정). 이 세션 = 천장을 더 캐고, miss는 RCA해서 **일반 레버**로 환원(단일 인스턴스 튜닝 금지 — [[no-heuristics-only-validated]]).

근거 데이터: 천장 ∩ 우리 진짜 resolved = **14315 단 1개** (10999 등 나머지는 yaml loose-mention 오염이었고 실제론 miss). 천장은 고정 한계가 아니라 표본 늘면 줄어드는 경험값(9→17 스캐폴드로 72→55→union 32).

---

## 한 것 (근거·증거 포함)

### 1. django-10999 = "issue-suggested-fix 앵커링 함정" 천장 확정
- **RCA**: localize 완벽(ownerHit+firstEditOwnerMatch), repro base-RED ✅인데 unresolved. 원인 = **이슈 본문이 권위있는 오답을 직접 제공**("The following will work: `(?=-?\d+:-?\d+)`" + 실명 크레딧). gold은 `(?P<sign>-?)` 통합 front-sign 그룹(부호가 duration 전체에 하나) — 이슈가 안 적은 maintainer 설계판단.
- **측정 3런** (full-remote 공식 docker grade): gpt-5.4 / gpt-5.4+adversarial-repro / **gpt-5.5** — **3런 전부 byte-identical 패치**(이슈 미끼 한 줄). 더 좋은 모델(5.5)도 미끼를 물음. 5.5만 `verify_loop_stuck`(틀린 건 감지했으나 이슈 프레임 못 깸).
- **판정**: 모델-capability 천장이 아니라 **앵커링 함정**. 불가능은 아니지만(정답 의미론은 추론으로 닿음) 앵커가 압도적. 메모리: [[jun-19-django-10999-anchoring-trap-ceiling]].

### 2. adversarial-repro knob 빌드 (default-OFF, 미검증)
- **무엇**: repro 생성 프롬프트(`src/agent/repro-test/generate.ts`)에 adversarial 블록 주입 — boundary / must-reject / consistency 케이스 + "이슈가 제안한 fix 복붙 금지". under-fix가 self-check repro에서 GREEN(false-green) 되는 걸 막으려는 의도.
- **배선**: `generate → driver(prepareReproTestDetailed/installReproTestHint) → posture(BenchPosture.adversarialRepro) → knob(QUANTA_BENCH_ADVERSARIAL_REPRO) + ratchet`. 풀 4층.
- **품질**: 154 테스트 green, OFF일 때 byte-identical, 타입체크 내 파일 0 에러. 커밋됨(32f427d3 "done" 스윕).
- **상태**: ⚠️ **win 0으로 미검증.** 10999에서 효과 0(byte-identical 패치). **프리셋 편입·"작동" 주장 금지** until 셋 단위 net-positive 측정([[claim-100-needs-3-adversarial-audits]]).

### 3. pyright 부트스트랩 fix — LSP grounding 살림 (confound 제거) 🔑
- **문제**: full-remote AMI에 `pyright-langserver` 미설치 → 모든 천장 런이 `lsp: failed`로 **LSP grounding/co-change steer 죽은 채**로 돎(이전 0/N은 전부 confounded). `full.ts:210`이 `pyright`(CLI)만 워밍하고 어댑터가 띄우는 `pyright-langserver`는 노출 안 됐던 것.
- **fix** (`src/apps/bench/remote/full.ts`, **미커밋**): install → warm → **uv tool venv에서 `pyright-langserver` symlink 보장** → langserver 워밍. 전부 fail-open.
- **검증**: 2픽 런에서 `LSP grounding ready — pyright 1.1.410` 출력 = **살았음.** 이제 모든 ceiling 런 grounding 라이브.

### 4. 천장 2픽 측정 (11400, 13212) → co-change 엣지 경계 발견
- **선정**: gold 패치 모양으로 오프라인 트리아지(gold는 *선택*에만, 에이전트엔 안 줌) → multi-site co-change & NOT anchoring 2개. agentless-v2 + gpt-5.5, pyright-live.
- **결과**: **0/2** (11400=52턴, 13212=58턴 — 깊이 매달림). 하지만 진단이 깨끗:

| | co-change 사이트 연결고리 | grep 엣지 | 결과 |
|---|---|---|---|
| **14315** | base+postgresql client이 **같은 메서드 `settings_to_cmd_args_env` 공유** | 심볼 grep→양쪽 발굴 | ✅ |
| **11400** | admin filter → model field `get_choices` = **delegation**(공유심볼 X) | symptom만, 상류 field API(__init__/reverse_related) 못 따라감 (1/3 파일) | ❌ |
| **13212** | core/validators → **forms/fields**(이름 다른 sibling) | "validators" grep으로 postgres까지 over-search, **정작 forms/fields 놓침** | ❌ |

- **핵심 발견**: 우리 grep co-change는 **사이트가 심볼 공유할 때만** 작동. **delegation/상속으로 이름 다른 API에 걸치면 못 따라감.** 탐색 *폭* 문제 아님(13212는 over-search). 둘 다 repro base-RED+unresolved=1 → 실행피드백이 "아직 깨짐"은 줬으나 *어디가* 빠졌는지는 못 알려줌.

---

## 미커밋/동시작업 상태 (주의)

- **내 미커밋**: `src/apps/bench/remote/full.ts`(pyright fix — 보존·커밋 권장).
- **병렬 에이전트 in-flight**: `src/runner/batch/eval/driver.ts`(co-change/sibling-reachability steer 작업 중 — "cm.py" 주석), `verification-bundle/`, `regression-oracle.ts`, `verify-select.ts`, `repro-vote.ts`(verify-and-select 조각들). **건드리지 말 것**(sweep-commit 충돌 위험 — [[never-blind-git-stash-pop]] [[sweep-and-macos-sed]]).
- adversarial-repro knob은 이미 커밋됨(32f427d3).

---

## 할 것 (목적 + 근거 + ROI)

### P0 — pyright fix 커밋 + 이전 천장 런 재평가
- **왜**: 이전 0/N 천장 런은 전부 LSP-dead confounded. pyright 살았으니 **재평가 필요**(특히 [[jun-19-ceiling-bench-pyright-ami-gap]]의 EDGE-YES 3개).
- **근거**: theater 클래스(wired≠engages)가 이 세션만 여러 번 재발([[jun-19-repro-vote-and-theater-class]]). launch-proof(`LSP grounding ready` 라인)로 가시화됨.
- **ROI**: 높음. confound 제거된 baseline 없이는 어떤 레버도 측정 무의미.

### P1 — co-change tracing 레버 (이번 세션 핵심 발견의 직접 대응) 🔑
- **기능**: localize 단계에서 grep 심볼매치 너머 **call-graph(find-refs/delegatee/override)로 co-change 사이트 집합 도출** steer + verifier가 "테스트가 건드리는데 내가 안 만진 파일" 잡기.
- **왜**: 11400/13212 둘 다 delegation-class에서 사이트 누락으로 실패. pyright find-refs는 이미 살아있는데 에이전트가 *안 씀*. 도구를 강제 사용시키는 steer가 갭.
- **근거**: 14315(공유심볼)는 풀고 delegation은 못 푼 엣지 경계가 측정으로 드러남. verify-and-select 방향(병렬 에이전트 작업)과 맞물림.
- **ROI**: 높음. delegation-class는 천장에 다수(multi-file gold 인스턴스 = 11400/13212/15629/16263/sympy-16597…). 측정셋 = 이 delegation-class 묶음. **단일 인스턴스 튜닝 금지** — 셋으로.

### P2 — adversarial-repro 검증 or 폐기
- **기능**: 이미 빌드된 knob을 under-fix 후보 *셋*에 측정.
- **왜**: 10999서 효과 0이었지만 그건 anchoring(generation 문제)이라 self-check 레버가 안 맞았던 것. 진짜 under-fix(repro 약해서 GREEN)가 병목인 인스턴스셋에서 net-positive인지 봐야 판정.
- **ROI**: 중. net-positive 없으면 폐기(미검증 코드 방치 금지).

### P3 — generation skeptic steer (anchoring 클래스)
- **기능**: "이슈가 준 fix는 hint일 뿐, 의심하고 의미론 직접 추론" steer.
- **왜**: 10999류 앵커링 함정의 유일한 미검증 레버. adversarial-repro(self-check)도 더 좋은 모델도 못 깸 → 병목은 generation의 앵커.
- **ROI**: 낮~중. anchoring-class는 천장에 소수(10999만 ANCHOR 플래그). 셋이 작아 측정 빈약할 수 있음.

---

## 측정 인프라 메모 (재현용)

- 채점 = **full-remote 공식 docker가 정본** (로컬 docker 금지). `QUANTA_FULL_REMOTE_ONDEMAND=1 QUANTA_BENCH_PRESET=agentless-v2 [QUANTA_BENCH_ADVERSARIAL_REPRO=1] bun run src/apps/bench/cli.ts grade --mode full --allow-remote-secrets --dataset <jsonl> [--model gpt-5.5]`.
- on-demand(spot reclaim 회피), env `QUANTA_BENCH_*`는 박스로 forward됨.
- 산출물: `~/Library/quanta-codeagent-v3/bench/full-remote/{preds,closure,report}-i-*.json`.
- 채점 SERIAL만, 광역 pkill 금지(유저 벤치 사망), git add -u/blind stash-pop 금지([[jun-19-swebench-concurrent-grading-falseneg]]).
- 천장 트리아지: `_scaffold-summary/scaffold-solving-summary.md` "0개 해결" 섹션 ∩ gold multi-file = delegation-class 후보.

---

## 한 줄 요약

천장 마이닝: 10999=앵커링 함정(불가), 11400/13212=**co-change delegation 미스**(우리 grep 엣지가 공유심볼엔 강하나 delegation엔 약함 — 14315 대비로 경계 확정). **pyright grounding 살림(confound 제거)**이 부수 최대 수확. 다음 핵심 레버 = **find-refs 기반 co-change tracing**, delegation-class 셋으로 측정.

---
---

# 세션 2 (병렬) 추가 — 프론티어 흡수 지형도 · 도구-배선 검증 · gpt-5.5 측정

> 세션 1(위)이 "천장 마이닝 + co-change 엣지"라면, 세션 2는 **(a) 공개제출 전수 흡수 지형도 (b) "왜 프론티어와 차이나나"를 도구/아키텍처 층위로 분해 (c) gpt-5.5 측정으로 레버 검증.** 결론은 세션 1과 **수렴** — 병목은 정적엔진 부재가 아니라 *모델이 grounding을 안 쓰거나 single-shot이라 못 건짐* → **verify-and-select(ensemble) + co-change tracing이 레버.**

## 목적 (왜)
"천장 깨기" probe(sympy-17630 gpt-5.5)로 시작 → 실패 RCA가 "우리 도구가 없어서냐, 모델이 못해서냐"로 번짐 → **우리 스택을 적대적으로 검증**(내가 여러 번 grep만 보고 과대단언 → 유저가 매번 "제대로 확인" → 검증으로 정정). 핵심 깨달음: **흡수할 거의 모든 도구가 이미 있다. 진짜 갭은 (1) 모델이 도구를 쓰게 하기 (2) single-shot → ensemble.**

## 한 것 (근거·증거)

### 1. 프론티어 매트릭스 17 → **134 전수**로 확장 + OSS맵 — `_scaffold-summary/scaffold-solving-summary.md` 재생성
- ceiling=**32**/500, union=468, easy-core(≥90%) 59. **부분집합(17) 천장 55는 뻥튀기**였음(23개를 다른 제출이 풂). → **천장 주장은 전수 union으로만**([[jun-19-frontier-scaffold-matrix]]).
- metadata.yaml `os_system`로 OSS 분류: OPEN ~62 / closed ~64. **흡수 가능 강자** = Live-SWE-agent(UIUC 396)·Trae(ByteDance 394)·Lingxi(Huawei)·JoyCode·Refact·OpenHands·Moatless·Augment·SWE-agent. closed = Sonar(#1 396)·Atlassian·EPAM·Warp·SAGE·Anthropic-tools.

### 2. Trae 흡수 분석 (clone `~/Documents/code-new/competitor-scaffolds/trae-agent`, MIT)
- **CKG** = tree-sitter 심볼인덱스(search_function/class/method). 퀄 = "쓸만한 심볼 테이블"이지 graph 아님(엣지 無·exact-match only·insert마다 commit·body 통째저장·name 인덱스 無·JS/TS 반쪽). 언어 6(py/java/c/cpp/ts/js).
- **Selector Agent**(`evaluation/patch_selection/`) = **verify-and-select** — N후보→regression-annotate→group→majority-vote→selector가 테스트 돌려 고름. **이게 Trae 394의 진짜 무기, 우리가 안 가진 것.**
- 프롬프트는 우리 SWEBENCH_DIRECTIVE와 거의 동일(차별점 아님).

### 3. 우리 정적-grounding 도구는 **이미 완비+배선됨** (CKG 재발명 금지)
- `src/tool/lsp_nav/index.ts`: `lsp_workspace_symbol`(이름→정의, fuzzy)/`lsp_definition`/`lsp_references`/`lsp_document_symbol` — Trae CKG보다 **semantic 우위**(resolve/refs까지). agentless-v2 `lsp:1` → `lspNav=true`(`knobs-bench.ts:286`) → 레지스트리 부착(`driver.ts:1046`) + steer DEFAULT-ON.
- 능력=우리 위 / 신뢰성=Trae 위(서버리스). Sourcegraph(나중)=둘 다 → 같은 **SymbolIndexPort seam** 뒤에 swap해 A/B.
- **교훈**: "CKG 만들자"는 중복개발이었음. 능력 이미 있음 — 진짜 갭은 모델이 도구를 *쓰게* 하기.

### 4. 측정된 winner 상태 정정 (SSOT = `docs/swebench-leaderboard.{yaml,md}`)
- primary = **agentless-v2**(v1 아님). v2가 v1보다 측정 +1(#10914 localize-miss, closure bundle).
- **SIMPLICITY steer = 측정된 winner, DEFAULT-ON** — 2 인과 flip(django-13417 + sympy-24562, over-engineering). OpenHands Linus철학 흡수.
- v3-thin(patch-budget)=v2와 타이·미검증. closure-repair=net-negative(드롭). 동시채점 버그로 과거 verdict 여럿 철회 — serial-graded만 신뢰([[jun-19-swebench-concurrent-grading-falseneg]]).

### 5. gpt-5.5 측정 — sympy-17630 (mislocation 클래스)
- v1런: 0/1, `blockmatrix.py` 오localize(gold=`matexpr.py::_postprocessor` MatAdd 2줄).
- **v2런 (pyright launch-proof READY = grounding LIVE)**: **또 0/1, owner_recall@1=0, 또 blockmatrix.py.** closure 사이드카 확정(first_edit_owner_match=0, synth_repro_base_red=0).
- **oracle-localize A/B**(세션 중): 위치(matexpr.py)만 주면 **gpt-5.5가 gold급 fix → PASS.** ⇒ **localization이 병목, reasoning 천장 아님.**
- **정정(2026-06-20)**: durable sidecar `report-i-007cd5902aad2e32c.json`에서 gpt-5.5/agentless-v1이 `matexpr.py` 패치로 official PASS(26t, 616B). 위 두 실패는 active ceiling이 아니라 **single-shot localization variance / symptom-root split 실패모드**로 보존.
- **미해결**: trajectory 안 켜서 모델이 lsp_*를 *호출*했는지 미확인 → **①b 재런 trajectory ON 진행 중**(bg `bek8e6w86`).

## 할 것 (목적 + 근거 + ROI)

### S2-P0 — ①b trajectory 판독 ✅ DONE (⚠️ "73회"는 파싱오류였음 — 정정)
- **TRUE 결과 (dedup by tool_use_id)**: gpt-5.5의 UNIQUE LSP 호출 = **2건뿐** (lsp_definition 1 → blockmatrix 결과 / **lsp_references 1 → "timed out after 15000ms" 타임아웃**). 주력 도구 = bash 16 / read 14 / grep 3 / edit 2. ⚠️ 이전 "73회(def36+ref35)"는 trajectory 48레코드가 **대화이력을 반복포함** → 중복카운트 아티팩트. (raw 메시지 카운트 금지, 반드시 tool_use_id로 dedup.)
- **mislocation은 real** (closure 사이드카: owner_recall@1=0, blockmatrix.py — 사이드카는 신뢰).
- **판정 (정정)**: "(a) 도구 많이 쓰고도 틀림" ❌. 실제 = **LSP 거의 안 씀(2회) + 핵심 find-references가 15s 타임아웃 → grep/read 폴백 → mislocate.** sympy(동적 dispatch 많음)서 pyright references 타임아웃 = grounding malfunction([[jun-16-lsp-grounding-django-dead-end]] hang과 동류).
- **함의 (역전)**: **CKG/faster-refs 정적엔진 레버 부활** (S2-P3). 우리 LSP는 semantic이나 sympy서 *필요한 순간 타임아웃*으로 무용 → tree-sitter CKG(precomputed SQLite, 타임아웃 無)가 *속도 축*에선 우위. 세션1 co-change(find-refs)도 refs가 타임아웃하면 불가 → **빠른 refs 엔진이 진짜 갭일 수 있음.** (단 n=1 타임아웃 — 체계성 확인 필요.)

### S2-P1 — verify-and-select (ensemble) ★ 개념상 최대 레버 — 단 **구현버그로 측정 BLOCKED** 🔴
- **이미 빌드됨**: `src/runner/batch/eval/selection-executor.ts`(N후보+diversity-seed+VerificationBundle 스코어+selectBest) + `verify-select` knob(`QUANTA_BENCH_VERIFY_SELECT`, default-OFF) + prod driver 배선(`apps/bench/eval/driver.ts:804 runSelectionPhase`). **CKG처럼 "만들 것" 아님 — 이미 있음, 미측정.**
- **🔴 측정 시도 결과 (sympy-17630 @ v2 + verify-select=6 @ gpt-5.5, full-remote)**: **empty_patch, 66턴, resolved 0/1.** report.knobs에 `verify-select=6 (source:env)` = **활성 확인**(env-forward 정상, executor engage함). trajectory: 6후보가 **edit 156회 + apply_patch 30 + lsp 71**로 진짜 일 다 했는데 **최종 제출 0 bytes.** → **executor가 후보들의 패치를 잃어버림 = capture/selection 버그.**
- **원인 강한 의심**: `runSelectionPhase`(driver.ts:524)가 6후보를 **동일 `sandbox`에 reset 없이 순차 실행** → 후보간 diff 캡처 꼬임 → `result.winner?.patch ?? ""`가 빈 채로 떨어짐. **fix = 후보별 sandbox 격리/reset + winner.patch 캡처 검증.**
- **왜 중요**: ①가 "single-shot은 73회 도구쓰고도 mislocate" 증명 + oracle-localize가 "위치 주면 gpt-5.5가 gold급 fix" 증명 → diversity-seed 앙상블이 정확한 회복기전. **개념은 맞고 구현만 깨짐.**
- **ROI**: **최상 (단 fix 선행).** selection-executor 소유 = 병렬 에이전트. **이 버그 fix 전엔 EC2 더 태우지 말 것**(empty 반복). fix 후 sympy-17630 재측정 = 앙상블 효과 첫 클린 측정.

### S2-P2 — patch-budget kill/keep (② 진행 예정)
- **기능**: sympy-12096(5-file over-broad, SIMPLICITY-resistant) @ v2 vs v3-thin + trajectory.
- **왜**: patch-budget가 SIMPLICITY 놓친 over-broad를 잡으면 keep, 못 잡으면 v3-thin 드롭. (13417은 SIMPLICITY가 이미 풀어 무의미 → 타겟을 sympy-12096으로 정정.)
- **ROI**: 중. 이 세션에 만든 미검증 코드 keep/drop 결정.

### S2-P3 — CKG/faster-refs 정적엔진 = **RESURRECTED (DEFER 철회)** 🔼
- **왜 (정정)**: ①이 실제로 보인 건 "grounding 쓰고도 틀림"이 아니라 **find-references가 sympy서 15s 타임아웃** = grounding이 *필요할 때 작동 안 함*. precomputed tree-sitter refs/심볼 인덱스는 타임아웃 없이 즉시 반환 → 모델이 못 받던 co-change grounding 제공. 우리 "우월한" pyright가 정작 타임아웃으로 무용 → Trae의 "열등한" CKG가 *속도 축*에선 우위.
- **기능**: `src/retrieval/code-parser`(이미 tree-sitter 보유) 위에 refs/심볼 인덱스 or Sourcegraph를 `SymbolIndexPort` 뒤에 (pyright는 semantic fallback).
- **🔴 선결 측정**: find-refs 타임아웃이 sympy/django서 **체계적인지** 먼저 확인(여러 인스턴스 lsp_references latency/타임아웃율). n=1이라 단정 금지. 체계적이면 ROI 높음.
- **결합 이슈**: 모델이 refs 1회 호출 후 타임아웃→포기 → 타임아웃 고쳐도 refs를 더 쓰게 steer 필요(jun-17 nav 0% 문제와 결합). + ensemble(verify-select)과 병행.

### S2-P4 — preset sprawl 정리 (위생)
- **기능**: `agentless-v2-safe`→`noexec` 리네임, 측정끝난 arm `_archive` 섹션, winner 마킹.
- **왜**: v2 패밀리 4개+v3-thin+mini-parity — single-variable A/B는 옳으나 lifecycle 관리 안 됨(best/spent 구분 불가).
- **ROI**: 낮(위생). 측정 안정 후.

## 수렴 노트 (세션1 ↔ 세션2)
- 세션1 P1(co-change find-refs tracing) ≡ 세션2 발견(grounding LIVE인데 모델이 안 따라감). **둘 다 "도구를 모델이 쓰게 / 여러 번 시도해 건지게"를 가리킴 — 정적엔진 부재 아님.**
- 세션1 측정(11400/13212 delegation 미스, 10999 anchoring) + 세션2 측정(17630 mislocation, pyright-up) = 같은 그림: **localize/co-change가 병목, grounding이 *있어도* 모델이 전환 못함 → verify-and-select가 공통 상위 레버.**

## 미커밋 / in-flight (주의)
- bg run `bek8e6w86`(sympy-17630 v2+trajectory) 완료 대기 → trajectory 판독이 다음 액션.
- 세션1 `full.ts` pyright fix(미커밋) 보존. 병렬 에이전트 `driver.ts`/`verify-select.ts`/`repro-vote.ts`/`regression-oracle.ts` **건드리지 말 것**([[never-blind-git-stash-pop]] [[sweep-and-macos-sed]]).
- **세션2 내 미커밋 = `src/lsp/adapters/pyright.ts` 주석만** (indexing/timeout 둘 다 측정 후 원복: `indexing:false`, `15_000` — 값 변경 0, dead-end 문서화 주석만 추가).

---

## 🔴 세션2 측정 결론 — references-grounding 스레드 (DEFINITIVE, 소거법)

**질문**: sympy-17630 단일샷이 mislocate(blockmatrix, gold=matexpr)하는 진짜 원인 = 도구냐 모델이냐?

**측정 (전부 full-remote gpt-5.5, agentless-v2, pyright launch-proof READY):**
| 시도 | 결과 | 의미 |
|---|---|---|
| 단일샷 trajectory dedup | LSP 실호출 **2건**(73 아님—파싱오류), `lsp_references` **15s 타임아웃** | 모델 LSP 거의 안 씀 + 핵심 refs 죽음 |
| `indexing:true` (config fix) | references **여전히 타임아웃**, 0/1 | indexing은 refs 경로 안 건드림 — config로 못 고침 |
| references 타임아웃 **60s** 상향 | **여전히 60s 타임아웃**, 0/1 | references는 느린 게 아니라 sympy서 **intractable** |

**확정**: pyright `textDocument/references`는 거대 repo서 **근본적으로 못 씀**(config-no + 60s-no, 둘 다 측정). cross-ref/co-change grounding은 pyright로 불가 → **precomputed 비-semantic 인덱스(tree-sitter/ripgrep, repo크기 무관 즉시반환)가 유일 경로.** = 세션1 P1(co-change) + S2-P3(CKG)의 **측정된 정당화**. `definition`(point-query)은 빠르고 멀쩡 — 죽는 건 references/workspace-symbol(전역 스캔)뿐.

**부수**: `ast_grep` 도구 존재(structural search)하나 agentless-v2서 **OFF**(`QUANTA_AST_GREP` 미설정) + pattern-based(symbol-refs 아님). ripgrep-기반 `find_references` 폴백 or tree-sitter ref 인덱스가 본命.

**단 — 모델이 refs를 1번 부르고 타임아웃→포기**(retry/대체 안 함). 빠른 ref 인덱스를 줘도 **모델이 쓰게 steer** 필요(jun-17 nav 0% 결합). 즉 fix = (1) 안 죽는 ref 도구 + (2) 그걸 쓰게 하는 steer/ensemble.

**우선순위 (측정 후 확정):**
1. **ripgrep/tree-sitter `find_references` 도구** (pyright refs 대체, 안 죽음) + localize-phase steer. ← references-grounding의 진짜 fix. ast_grep 이미 있으니 거기서 출발 가능.
2. **verify-select capture+seeding 버그 fix** (병렬에이전트). 정정: 측정 trajectory dedup상 edit **11회**(156 아님—파싱오류) + **diversity seed 0건 fired**(localizeCandidates 빈 듯) + empty 제출 = 버그 2개(seeding 안 함 + capture 잃음).
3. patch-budget: v3-thin이 sympy-12096 풀었으나 **in-budget(patch-budget 안 fired)** → 공로는 steer/모델, patch-budget **unproven**. v2 baseline은 /tmp reap으로 미완.

**메타 교훈(이 세션 반복)**: trajectory raw 메시지 카운트 금지 — 48레코드가 대화이력 반복포함 → "73 LSP" "156 edit" 둘 다 inflated. **반드시 tool_use_id로 dedup.** + wired≠engages≠returns(launch-proof로 engages 확인, but references는 returns 안 함).

---

## ✅ 세션2 빌드 — `find_references` 도구 (SOTA++, LANDED)

위 측정 결론("pyright references intractable → precomputed ref가 fix")의 **구현**.

- **무엇**: `src/tool/find-refs/index.ts` — ripgrep `-F -w`(fixed-string whole-word) 기반 즉시-반환 reference 검색. def-looking 라인 `[def]` 분류+우선, file:line 그룹, 200 cap, jail(resolveJailed), no-throw. pyright `lsp_references`(15s/60s 타임아웃)의 timeout-immune 대체.
- **배선**: barrel export(`@/tool`) + bench driver registry(`findRefsToolList`, gate `QUANTA_BENCH_FIND_REFS`) + `FIND_REFS_STEER`(localize-phase-guard, co-change를 find_references로 redirect) + driver prompt 합성(`findRefsSteerLine`, swebench∧gate) + manifest GATED 엔트리. **default-OFF byte-identical**; `QUANTA_BENCH_FIND_REFS=1`로 켜짐(`buildForwardedBenchEnv`가 QUANTA_BENCH_* forward → EC2 박스 도달 확인).
- **품질**: 적대 어딧 3R — 보안/correctness 0 HIGH(injection·jail·word-boundary·no-throw 전부 SAFE, 라이브 rg로 검증), 배선/byte-identity 0 HIGH(forward·byte-identical·steer⊆tool·siblingSteerLine 무손상), dunder/metachar 엣지. LOW perf 1건(row마다 regex 컴파일) **fix**(1회 컴파일). 12/12 test green, tsc 내파일 0, drift가드 green.
- **측정 중**(bp98f16e2): django-11400(3파일 co-change: fields/reverse_related/admin.filters) @ agentless-v2 + QUANTA_BENCH_FIND_REFS=1. 가설: find_references+steer가 multi-site co-change를 잡아 resolved/owner_recall 개선. ⚠️ n=1 — 효과 주장은 측정 결과 + 셋 단위 확인 후.
- **남은 것**: (1) 측정으로 효과 확인되면 agentless-v2(or 신규 arm)에 QUANTA_BENCH_FIND_REFS 묶기. (2) `isDefinitionLine` 분류는 cosmetic(ordering)만 — 정밀화는 tree-sitter 분류로 후속. (3) verify-select capture/seeding 버그(병렬에이전트) + patch-budget(unproven) 별개.
