# jun-24 Wave-2 핸드오프 — 정적엔진 필요성 어딧 + 측정-위생 사고 정리

## 목적 (왜 이걸 했나)

질문: **우리가 못 푼 SWE-bench Verified 인스턴스들, "LSP 이상의 정적엔진"(call-graph/data-flow/change-impact/MRO/AST) 있으면 풀리나? 반드시 필요한가, 있으면 도움인가?** 오라클(gold patch) 보고 점수표로 어딧하는 게 출발점이었다.

결론부터: **정적엔진은 핵심 레버 아니다.** 하지만 이 세션의 더 큰 산출물은 **내 측정 파이프라인의 사고 2건을 적발·정정**한 것 — (1) 오염된 옛 프로필 데이터로 결론냄, (2) **gold 패치를 우리 패치로 오인**해서 분석 절반이 동어반복이었음. 둘 다 유저가 "옛날 프로필 아니냐", "골드 줬냐" 추궁으로 잡아냄. 진짜로 살아남은 신호 + 코드 보완 + 다음 할 일을 여기 박는다.

> 핵심 교훈: [[no-heuristics-only-validated]] · [[jun-20-throttle-swallow-and-measurement-hygiene]] · [[claim-100-needs-3-adversarial-audits]] — 측정 소스의 provenance(preset/timestamp/스키마)부터 까라. n=1 SWE 패치지표는 노이즈.

---

## 한 것 (근거·증거 포함)

### 1. 71개 미해결 인스턴스 오라클 어딧 (7개 병렬 에이전트)
- gold patch 모양으로 "정적엔진이 도움될까" 점수화(MUST/HELPFUL/MARGINAL/NONE). 데이터: `docs/analysis/swe-bench-verified-analysis/_data/verified-full.jsonl` (500행 gold).
- 결과: **MUST 2 / HELPFUL 22 / MARGINAL 9 / NONE 38(54%)**. NONE은 순수 추론·수학·스펙 천장(정규식 한 줄, 심볼릭 수학, TeX 등) → 엔진 무관. **세 적대입장(필요없다/개도움/그래프) 만장일치로 NONE 인정.**
- ⚠️ 이 점수표는 gold *모양* 기반이라 살아있음. 하지만 아래 patch-body 분석은 죽음(§철회).

### 2. gradeBreakdown 측정 (n=33, 진짜 우리 채점결과) — **유효 생존**
- 소스: `~/.quanta/bench/results/*.json` 의 `perInstance[].gradeBreakdown` (`passToPassFailed`/`failToPassFailed`). **이건 gold 아니라 우리 런 채점결과** → 오염 안 됨.
- 분류: **61% "못고침"**(passToPassFailed=0, 기존 안 깸·정답 못 만듦 = 추론/insight 실패, 엔진 무관) / **30% 회귀**(passToPassFailed>0, 기존테스트 깸 = change-impact 엔진의 유일한 메커니즘) / **9% 채점불량**(grader_invalid 인프라).

### 3. 코드 어딧 (4개 병렬 적대어딧) → 라쳇 보강 **완료(이번 세션 랜딩)**
- steers(lsp/findRefs/spec/simplicity/sibling)·issue-expected 추출기·localize/primary-rail/preflight guards = **전부 CLEAN** (instance ID는 주석에만, 런타임은 config knob 분기, gold 안 읽음).
- **유일 결함**: answer-key 재발방지 라쳇이 WEAK(theater 경계) — 제거된 3개 steer의 *특정 문자열 denylist*일 뿐, 새 overfit·import된 steer·SWEBENCH_DIRECTIVE·런타임 builder 못 잡음. RED-ON-INJECTION이 자기 needle로 만든 문자열이라 tautological.
- **보강(v2)**: `tests/unit/no-benchmark-overfit-steer-ratchet.test.ts` 재작성 — framework-agnostic 클래스 탐지기(`.py 멀티세그 경로`/`framework+instance번호`/`"for the X issue"·RCA framing`/gold-recipe) + 스캔표면 확대(driver+localize-phase-guard, 캡처 **2→12**) + 진짜 red-on-injection(denylist에 없는 flask/requests/pandas) + end-to-end 합성주입 + multisite provenance 가드. **8/8 통과.** (다른 코드 0 변경, 유저 working-tree 안 건드림.)

### 4. answer-key 코드검증 → **agent는 gold/힌트 안 봄 (확인)**
- gen 프롬프트 경로: agent는 **`problem_statement`(공개 이슈텍스트, `normalizePublicIssueText` 정제)만** 받음. 명시 불변식 주석 `no goldPatch reaches src/agent`(driver.ts:2498).
- `test_patch`/`FAIL_TO_PASS` = gen 경로 미사용(채점만). `hints_text` = **src 전체 사용 0.** `issue-hint` 노브 = gold 아니라 이슈본문 추출(Agentless §3.1).
- gold patch가 닿는 곳 = **eval-only 3곳**(repro-oracle 캘리브레이션 / localization 측정 / strict-LSP 게이트 언어선택). 전부 agent 밖.
- 🟡 회색지대 1개: strict-LSP 게이트가 gold 파일목록 언어로 "무슨 LSP 요구할지" 고름(`dominantBinOf(taskFiles)`, driver.ts:4068). agent엔 안 새고 게이트는 런을 **죽이기만**(점수 못 올림) → answer-key 아님. 찜찜하면 whole-repo 언어감지로 전환 가능(대신 [[jun-21-strict-lsp-gate-flake-and-oom-retraction]] flake 복귀).

### 5. clean-config 재런 3개 (진짜 우리 패치, --predictions)
- 레시피: `bun run src/apps/bench/cli.ts run --swebench <ds> --instance <ids> --n 1 --report <r> --predictions <p> --auth-file ~/.quanta/auth/chatgpt-acct-a.json`. **별도 cred(acct-a)로 유저 기본 chatgpt.json 런 throttle 회피** (둘 다 LOCAL patch-gen, 박스락 없음).
- 결과: django-14011/11734/sympy-16597 = 셋 다 **멀티파일 gold(2/3/6파일)를 1파일로 과소커버 + 실패(0/3).**

---

## 🔴 발견된 문제점 (해결 대상)

### P1 — [분석툴 버그] gold 패치를 우리 패치로 오인 (이 세션 사고의 근원)
- `.tmp/bench-*/` 의 `active-rerun.jsonl`·`04-h-tail.jsonl`·`gate-artifacts.jsonl` 등은 **predictions가 아니라 재런용 dataset 파일**(`base_commit`/`FAIL_TO_PASS`/`patch` 스키마, `patch`=gold). 내 추출기가 `model_patch` 없으면 `patch`로 폴백 → **gold를 ours로 추출.** "복구한 7개" 중 **5개가 gold**(해시 byte-일치 확인): sympy-16597·seaborn-3187·django-11734·astropy-13398·django-14011. 진짜 ours는 2개(django-13212·11400, `_fails-combined.jsonl`의 `model_patch`)뿐.
- **고칠 것**: 패치 추출기는 **`model_patch`/`modelPatch`만 신뢰. `patch` 폴백 금지. `base_commit`·`FAIL_TO_PASS` 키 있으면 dataset 파일로 보고 패치소스에서 배제**(어서션으로 강제). 일회용 스크립트라도 이 가드 박아둘 것.

### P2 — [측정 위생] 오염된 옛 프로필 데이터로 결론
- 내가 깐 리포트 전부 `agentless-v3-thin-strict` @ **2026-06-20~21** = answer-key `*_STEER` 제거(294b40a8, **06-22 14:14**) **이전**. 그 프리셋은 `issue-hint-expected-actual:1`이라 steer가 LIVE였음. 33개 중 8개가 키워드 매칭(AdapterFamily 멀티사이트 떠먹임 3개 포함).
- **고칠 것**: `~/.quanta/bench/results` 결론 내기 전 **report `timestamp`/`knobs.preset`/active knobs를 294b40a8 기준으로 검사**하는 습관(또는 헬퍼). 06-22 이전 = 오염 가정.

### P3 — [인프라] 리포트가 patch 본문 미저장
- report.json은 `patchBytes`(바이트수)만 저장, diff 본문 없음. overnight-unsolved 캠페인이 `--predictions` 없이 돌아서 **26/33 인스턴스 패치 본문이 로컬에 없음**(EC2에 남음). 그래서 post-hoc enumeration 분석이 막힘.
- **고칠 것**: 모든 캠페인/overnight 런을 **`--predictions` 필수**로(SSOT 미러에 preds 포함). 그래야 사후 패치분석 가능.

### P4 — [멀티파일 과소수정] 진짜 병목 가설 (미확정, but 교차 corroborated)
- 우리 실패의 지배모드 = **멀티파일 버그를 한 파일만 고치고 끝냄**. 근거: gradeBreakdown 61% "못고침" + clean 3런 전부 과소커버.
- **🔑 교차증거**: [[jun-19-handoff]] §4가 **같은 인스턴스**(django-11400=1/3파일, django-13212=forms/fields 놓침)를 실제 런으로 측정 → co-change grep이 **심볼 공유할 때만 작동, delegation/상속으로 이름 다른 API엔 못 걸침**. 즉 이 세션의 ours 2개(13212·11400 ENUM-MISS)와 **독립적으로 일치.** 가설이 n=3 노이즈가 아닐 가능성 ↑.
- 구조적 원인 후보: 현재 preset = minimality ON(`round0-minimal`/`patch-budget-strict`/`spec-fidelity-steer`) + **멀티파일 유도 steer(sibling/multisite) default-OFF** → 단일파일 편향.

---

## ❌ 철회 (이 위에 빌드 금지)

- **patch-body enumeration 분석 전체** (구·신 양쪽). "FULL-COVERAGE = 자리 다 찾고 실패 = insight failure" 증거 7개 중 5개가 gold였음 → 동어반복. 무효.
- **"6→1 붕괴"** = gold(6파일) vs ours(1파일) 비교한 허상. 우리가 sympy-16597을 6파일로 짠 적 없음. 회귀 아님.

## ✅ 검증되어 안전 (재어딧 금지)

- bench gen path는 **agent에 gold/test_patch/hints 안 줌**(코드 확인, §4).
- **코드 answer-key 클린**, 라쳇 v2 teeth 있음(§3).
- **gradeBreakdown 분석(n=33)은 유효**(gold 아닌 우리 채점결과).

---

## 앞으로 해야 할 것 (우선순위 · 기능+왜+ROI)

- **A1 [P0] 깨끗한 멀티파일 커버리지 측정** — `model_patch`만(gold 폴백 금지, P1 가드 적용) 멀티파일-gold 인스턴스 **n≥5**, "우리 패치 파일수 vs gold 파일수" 분포. *왜*: P4 가설(멀티파일 과소수정 = 진짜 병목)을 노이즈와 분리. *ROI*: 최상 — 다음 레버가 "minimality 완화/sibling steer ON"이냐 "생성 정확도"냐를 결정. jun-19 §4와 합치면 거의 확정 직전.
- **A2 [P1] 분석툴 gold-가드** — 패치 추출 유틸에 "dataset 파일(`base_commit` 키) 배제 + `model_patch`만" 어서션. *왜*: 이 세션 사고 재발방지. *ROI*: 중(반나절), 향후 모든 측정 신뢰성.
- **A3 [P2] 멀티파일 레버 A/B** — A1이 minimality 편향 확정 시: 멀티파일 subset에 `sibling`/`multisite` steer ON vs minimality-only A/B(공식 docker grade, n≥5, [[jun-22-evidence-signal-audit-and-v5-seam]] posture seam 활용). *왜*: 병목 직격 레버 검증. *ROI*: 높음 but A1 선행 필수(n=1로 켜지 말 것).
- **A4 [P3] 캠페인 preds 필수화** — overnight/pool 런에 `--predictions` 강제 + SSOT 미러 포함. *왜*: 사후 패치분석 가능. *ROI*: 낮은 비용, 측정 인프라 영구이득.

---

## 레시피·참조 (다음 사람용)

- **gold 데이터셋**: `docs/analysis/swe-bench-verified-analysis/_data/verified-full.jsonl` (instance_id→patch/problem_statement/FAIL_TO_PASS/difficulty).
- **clean 재런**: `bun run src/apps/bench/cli.ts run --swebench /Users/songmin/Documents/code-new/quanta-benchmark-corpus/external/swebench/verified/raw/instances.jsonl --instance <ids> --n 1 --report <r.json> --predictions <p.jsonl> --auth-file ~/.quanta/auth/chatgpt-acct-a.json` (LOCAL gen, 별도 cred=throttle 회피).
- **현재 기본 preset**: `agentless-v3-thin-strict` (minimality ON, sibling/multisite OFF). `src/apps/bench/preset.ts:CURRENT_BENCH_BASE_PRESET`.
- **오염 경계 커밋**: `294b40a8` (2026-06-22 14:14, *_STEER answer-key 제거). 이전 리포트 = 오염.
- **라쳇**: `tests/unit/no-benchmark-overfit-steer-ratchet.test.ts` (v2, 8 tests). 새 steer 추가 시 통과해야 함.
- **auth 풀**: `~/.quanta/auth/bench-pool.yaml` (acct-a/b/c, 기본 chatgpt.json = 유저용).
