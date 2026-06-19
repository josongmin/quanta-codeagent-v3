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
- **미해결**: trajectory 안 켜서 모델이 lsp_*를 *호출*했는지 미확인 → **①b 재런 trajectory ON 진행 중**(bg `bek8e6w86`).

## 할 것 (목적 + 근거 + ROI)

### S2-P0 — ①b trajectory 판독 (진행 중, bg `bek8e6w86`)
- **기능**: 완료 후 `trajectory-sympy__sympy-17630.jsonl`서 lsp_* 호출수 + 검색어 + blockmatrix 결정지점 grep.
- **왜**: (a)도구 쓰고도 실패 vs (b)도구 무시 를 가름 = CKG(도구개선) vs steer강화/ensemble(사용강제) 우선순위 분기점.
- **ROI**: 높음. 없으면 "모델 등신"도 "도구 부족"도 단정 불가.

### S2-P1 — verify-and-select (ensemble) ★ 최대 레버 (세션1 verify-select.ts 작업과 합류)
- **기능**: N후보 생성 → regression/repro-annotate → selector(테스트 실행) 선택 → majority-vote. Trae 구조 흡수.
- **왜**: 우리는 **single-shot**(agentless-v2엔 sampling/select 없음; retry-transient는 크래시재시도뿐). sympy-17630은 한 방이 blockmatrix로 새면 끝 — N개 중 matexpr 맞춘 거 건지면 회복. oracle-localize가 "모델은 풀 능력 있음" 증명. SWE-bench 최대 레버 중 하나 + Trae 394 검증.
- **ROI**: **최상.** 병렬 에이전트가 `verify-select.ts`/`repro-vote.ts`/`regression-oracle.ts` 작업 중 → 합류.

### S2-P2 — patch-budget kill/keep (② 진행 예정)
- **기능**: sympy-12096(5-file over-broad, SIMPLICITY-resistant) @ v2 vs v3-thin + trajectory.
- **왜**: patch-budget가 SIMPLICITY 놓친 over-broad를 잡으면 keep, 못 잡으면 v3-thin 드롭. (13417은 SIMPLICITY가 이미 풀어 무의미 → 타겟을 sympy-12096으로 정정.)
- **ROI**: 중. 이 세션에 만든 미검증 코드 keep/drop 결정.

### S2-P3 — CKG/Sourcegraph 정적엔진 = **조건부 DEFER**
- **기능**: tree-sitter 심볼인덱스(우리 `src/retrieval/code-parser` 위) 또는 Sourcegraph를 `SymbolIndexPort` 뒤에.
- **왜**: ① 측정상 grounding LIVE인데도 mislocate → **도구 개선이 이 클래스 안 고침.** 모델이 안 쓰거나((b)) 추론이 틀림((a)) → 둘 다 ensemble을 가리킴. **CKG는 ①b가 "(b)도구 무시 + 도구 신뢰성이 진짜 갭"을 보일 때만 정당.**
- **ROI**: 현재 낮음(①가 반증). Sourcegraph A/B는 ensemble 이후.

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
