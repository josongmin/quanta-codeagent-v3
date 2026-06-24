# 보고서 — 우리만 못 푼 3 SWE-bench Verified 케이스: 경쟁사 solve 방법론 (레포·코드·라인 인용)

작성 2026-06-24. 대상 = official SWE-bench Verified board에서 다른 submitter는 풀었고 우리만 miss한 3건
(`.tmp/bench-ouronly-visible-2026-06-21/three-confirmed-fails.jsonl`).

---

## 0. 데이터 출처 (provenance)

| 종류 | 위치 |
|---|---|
| 리더보드 | https://www.swebench.com/ 인라인 `<script id="leaderboard-data">` JSON (Verified 180엔트리) |
| per-instance resolved | 인라인 40엔트리 + 나머지 140은 `github.com/swe-bench/experiments` `evaluation/verified/<folder>/results/results.json`의 `resolved[]` |
| trajectory | S3 공개버킷 `s3://swe-bench-submissions/verified/<folder>/trajs/<instance>.{json,log,txt}` (HTTPS: `https://swe-bench-submissions.s3.amazonaws.com/...`) |
| gold/test patch | 로컬 `.tmp/bench-ouronly-visible-2026-06-21/three-confirmed-fails.jsonl` (`patch`/`test_patch` 필드) |
| 우리 패치 | 로컬 `.tmp/bench-ouronly-visible-2026-06-21/rca-case-extracts/<case>.model.patch` |
| 다운로드 trajectory | `competitor-scaffolds/_swe-traces/<case>/` (실패분 `_FAILED-do-not-analyze/`로 격리) |

### 참고 경쟁사 스캐폴드 레포 (로컬 클론, HEAD 고정)

| 스캐폴드 | repo | HEAD | 로컬 경로 |
|---|---|---|---|
| OpenHands (app) | github.com/All-Hands-AI/OpenHands | 9c299e6 | competitor-scaffolds/openhands |
| OpenHands agent-sdk | github.com/All-Hands-AI/agent-sdk | b032401 | competitor-scaffolds/openhands-agent-sdk |
| live-swe-agent | github.com/OpenAutoCoder/live-swe-agent | 8d7dd86 | competitor-scaffolds/live-swe-agent |
| TRAE | github.com/bytedance/trae-agent | e839e55 | competitor-scaffolds/trae-agent |
| Prometheus | github.com/EuniAI/Prometheus | 5e1b712 | competitor-scaffolds/prometheus-agent |
| Agentless | github.com/OpenAutoCoder/Agentless | 5ce5888 | competitor-scaffolds/agentless |
| SWE-agent | github.com/SWE-agent/SWE-agent | abd7d69 | competitor-scaffolds/swe-agent |

board solve 수 (180 전수): 11138 = 22/180, 14315 = 3/180, 13033 = 4/180.

---

## 1. 케이스별: gold ↔ 우리 실패 ↔ 승자 (인용 포함)

### 1A. django__django-14315 — DUAL-SITE 미묘 시맨틱
- **버그**: postgresql client가 빈 dict `{}` 반환(should be None) → `subprocess.run(env={})`가 os.environ 상속 안 함.
- **gold** (2파일):
  - `django/db/backends/base/client.py` runshell(@@ -21,6): `if env: env = {**os.environ, **env}` → `env = {**os.environ, **env} if env else None`
  - `django/db/backends/postgresql/client.py` settings_to_cmd_args_env(@@ -51,7): `return args, env` → `return args, (env or None)`
- **우리 패치** (`rca-case-extracts/django--django-14315.model.patch`): postgresql/client.py **한 곳만** (`if not env: env = None`). base/client.py 미수정 → 채점 test `tests/backends/base/test_client.py` FAIL.
- **승자**:
  - ✅ **Qodo** (closed, trace `_swe-traces/django__django-14315/Qodo__closed.txt`): curl 0건. `git log --oneline django/db/backends/base/client.py`, `git log --grep='bbe6fbb'`, `git show bbe6fbb876`(=버그 도입커밋, base_commit 기준 **과거**)로 회귀 추적 + `subprocess.run(env=)` 시맨틱 추론 → "base client fix가 핵심"이라 **consumer**까지 localize. 구조적·정당·전이가능.
  - ❌ **OpenHands+DevStral** (trace `OpenHands_DevStral__OSS.json`, msg 28/32/33): `curl https://github.com/django/django/pull/14315.patch`, `curl https://patch-diff.githubusercontent.com/raw/django/django/pull/14315.diff` → **머지된 PR(=gold) 네트워크 fetch**. msg 56/58에서 두 파일 베낌(base/client.py byte-identical). = **ANSWER-KEY**. "작은 DevStral가 hard풀었다"=가짜서사. 전이금지. (14315 유일 OSS solve가 이거라 clean OSS 레퍼런스 없음.)

### 1B. astropy__astropy-13033 — EXACT-MESSAGE 정확매칭
- **task**: 오해소지 ValueError 메시지 개선. gold (`astropy/timeseries/core.py` `_check_required_columns`, @@ -55,6 / @@ -76,9): 헬퍼 `as_scalar_or_list_str(obj)` 추가(scalar/len-1 list→`'x'`, longer→`str(obj)`) + 기존 `raise ValueError("...expected '{}' as the first column{} but found '{}'")`를 그 헬퍼로 재작성.
- **채점 test_patch**: `astropy/timeseries/tests/test_sampled.py::test_required_columns`에 **2-컬럼 케이스 추가**(`expected ['time', 'a'] as the first columns but found ['time', 'b']`). 헝크헤더 `@@ -395,6 +395,14`상 **단일컬럼 assertion은 base_commit에 기존**(추가분 아님).
- **우리 패치**: 기존 메시지 대신 **자작 분기** `"...missing required column..."` 추가 → 기대문자열 불일치 + pass_to_pass 1건 깨뜨림(regression). RCA: `failToPassFailed:1, passToPassFailed:1`.
- **승자**:
  - ✅ **Sonar+Sonnet4.5** (closed, trace `Sonar_Sonnet45__closed.json`, MSG 14/16/18/19): curl 0. fix 쓰기 **전에** 레포의 **기존** 테스트 grep/read (`grep -n "required_columns" test_sampled.py`, `view [352,400]`) → 기대 assert 리터럴 확보 후 repro로 어느 문자열이 틀린지 핀포인트. test_patch가 추가하는 2-col 케이스가 아니라 base_commit 기존 테스트라 답안지 아님. 구조적·정당. (trace는 diagnosis phase까지 truncated; edit/iterate 미포함.)
  - 데이터 한계: 13033 OSS 승자(mini-swe+Opus high)는 traj 미업로드(S3 KeyCount 0).

### 1C. django__django-11138 — WIDE COORDINATION (4파일)
- **버그**: per-DATABASE TIME_ZONE이 MySQL/SQLite/Oracle date-aware에서 무시됨.
- **gold** (4파일): `mysql/operations.py`(@@ -69,8) + `oracle/operations.py`(@@ -99,9): `_convert_field_to_tz`에 `self.connection.timezone_name` source tz + `!= tzname` 가드. `sqlite3/base.py`(@@ -195/398/443/473): `_sqlite_datetime_parse`+등록함수 4개에 `conn_tzname` 추가 + **`create_function` arity 2→3, 3→4 bump**. `sqlite3/operations.py`(@@ -84,27): `_convert_tzname_to_sql`→`_convert_tznames_to_sql`(쌍 반환) + call site 4개 갱신.
- **우리 패치**: **빈 패치**(0바이트, 3소스 확인: active-rerun.jsonl/preds.jsonl/observe.patch). ⚠️**[2026-06-24 적대어딧 정정]** 원인이 "oracle 없어 thrash→예산소진"이 **아님**. observe jsonl(`.bench-pull/run-1782190012887/observe/django__django-11138.0.jsonl`) 실측: 11세션(best-of-N/retry, 10 completed+1 aborted), 229 turn, **edit 108회 타겟=mysql/oracle/sqlite operations.py+sqlite3/base.py=gold 4파일 정확일치**, **repro_issue.py 반복실행+실제 `pytest -k test_query_convert_timezones` 6회**(=M3 oracle 이미 존재·작동), `git diff` 검증까지. throttle 아님(backoff 1회뿐). 그런데 **edit 36개 전부 fork worktree(`bench-...-fork-JEPYlM/repo-7NsCo9`) 경로**인데 최종 diff는 다른 트리에서 추출→`patch_generated filesChanged:0`. = **fork-worktree 패치추출 버그**(인프라/plumbing), 방법론·capability 갭 아님. → 11138은 M3 absorb 대상이 아니라 fork-session 패치추출 수정 대상.
- **승자** (4팀, OSS, curl/git archaeology 0):
  - **TRAE+Doubao** (`TRAE_Doubao__OSS.json`, ~44턴 최소): call-graph grep(`grep -n _sqlite_datetime_cast_date`, `grep -rn datetime_cast_date_sql`)로 사이트 추적 → edit 후 `runtests.py datetimes` 실행 → 런타임에러 `sqlite3.OperationalError: wrong number of arguments to function django_datetime_trunc()` → "Oh I forgot to update the function registrations in base.py!" → 빠진 arity/2차 call-site/import를 **테스트가 지목**. ~5 edit→test cycle.
  - **live-swe+Opus4.5** (`live-swe_Opus45__OSS.json`, ~73턴): edit 전 ~17 grep으로 blast-radius 선바운딩 → 1패스 edit → 실제 `tests/timezones/` 실행, 무관한 YAML serialization fail에 **`git stash` paired-control 2회**로 "pre-existing, 내 diff 아님" 증명.
  - **OpenHands** (`OpenHands__OSS.json`, ~62턴): phased 프롬프트(EXPLORATION→TEST CREATION→FIX ANALYSIS→VERIFICATION)로 4파일 열거 후 편집, 무관 fail 격리.
  - **Prometheus+GPT5** (`Prometheus_GPT5__OSS.log`, LangGraph): 자작 repro test + 사전선택 regression test 두 oracle, 검증노드가 `Passing bug reproducing test: False→False→False→True`로 edit 루프.

---

## 2. 휴리스틱/답안지 vs 구조적 — 판정

질문: 쟤네 휴리스틱/답안지로 조진거냐?
판정: **gold 기반 휴리스틱(regex/경로/키워드 매칭) 0건.** 6 trace 중 답안지 1건, 나머지 구조적.

| trace | curl PR/issue | git archaeology(과거) | 판정 |
|---|---|---|---|
| 14315 OpenHands+DevStral | **3회 (PR.diff/.patch)** | - | ❌ ANSWER-KEY, 전이금지 |
| 14315 Qodo | 0 | git log/show bbe6fbb876 | ✅ 구조적 |
| 13033 Sonar | 0 | 0 (레포 기존테스트 read) | ✅ 구조적 |
| 11138 OpenHands/TRAE/live-swe | 0 | 0 (grep+test oracle+stash) | ✅ 구조적 |

핵심 불변식: git archaeology는 **base_commit 이전 히스토리만** 봄(fix 커밋은 이후라 레포에 부재); test_patch는 채점시 적용이라 **구조적 솔버는 답안지 파일 접근 불가**. 즉 1건(PR-fetch) 외엔 정당하게 코드베이스를 증거로 써서 이김.

---

## 3. 전이가능 방법론 M1~M5 (스캐폴드 코드 file:line 앵커)

> 앵커는 스캐폴드 소스(구현). PR-fetch(M0)만 금지, M1~M5는 gold 무관 일반기법이라 흡수 OK.

### M1 — 버그-도입커밋 archaeology (dual-site/consumer 발견) — 14315 Qodo
- 메커니즘: problem statement가 가리키는 도입커밋을 `git log/show`(과거)로 까서 회귀형태+consumer 파악.
- 스캐폴드 앵커: 도구로서 bash가 있으면 성립(에이전트 행동). 명시 프롬프트 강제는 약함 → **우리 신규 steer 후보**(스캐폴드 미내장).

### M2 — 기존 테스트 spec-read 선행 (exact-spec; 자작 메시지 금지) — 13033 Sonar / TRAE / OpenHands
- **TRAE**: `trae-agent/trae_agent/prompt/agent_prompt.py:22-42` 6단계 중 "Reproduce the Bug (Crucial Step)" 선행, `:36` "Prevent Regressions: Execute the existing test suite for the modified files".
- **OpenHands**: `openhands-agent-sdk/openhands-sdk/openhands/sdk/agent/prompts/system_prompt.j2:64` "For bug fixes: Create tests to verify issues before implementing fixes".
- **live-swe**: `live-swe-agent/config/livesweagent_swebench.yaml:42-47` "Recommended Workflow: Verify your fix works by running your script again / Test edge cases".

### M3 — 기존 test-suite를 일관성 oracle로 (wide-coordination 수렴) — 11138 TRAE
- 루프: edit→기존 test 실행→런타임에러가 빠진 site 지목→fix→재실행.
- **TRAE 루프**: `trae-agent/trae_agent/agent/base_agent.py:163-172` `while step_number <= self._max_steps:` (tool result feed-back).
- **bash 실행(test runner)**: `trae-agent/trae_agent/tools/bash_tool.py:213-238` `execute()`→`self._session.run(command)`, `:159` `ToolExecResult(error_code=...)`로 non-zero exit 가시화.
- **VERIFICATION 프롬프트**: `system_prompt.j2:74` (OpenHands) "VERIFICATION: ... test your implementation thoroughly, including edge cases".
- **OpenHands 루프**: `openhands-agent-sdk/openhands-sdk/openhands/sdk/agent/agent.py:542 def step`.
- **Prometheus 정식화(게이트 루프)**: `prometheus-agent/prometheus/lang_graph/subgraphs/issue_verified_bug_subgraph.py:216-223` 조건부 엣지 `lambda state: bool(state["reproducing_test_fail_log"])` → True면 `issue_bug_analyzer_message_node`로 되돌림(edit 재시도); 로그 `prometheus/lang_graph/nodes/bug_fix_verification_subgraph_node.py:50` "Passing bug reproducing test: ...".
- **Prometheus repro 작성/실행**: `prometheus/lang_graph/subgraphs/bug_reproduction_subgraph.py:124-216`, 결정점 `:201-205` `lambda state: state["reproduced_bug"]`.

### M4 — paired-control(git stash)로 pre-existing 실패 1-step 기각 — 11138 live-swe
- 메커니즘: edit 후 실패가 내 diff 탓인지 `git stash`로 되돌려 재실행해 증명.
- **live-swe 제출게이트/diff 추출**: `live-swe-agent/config/livesweagent_swebench.yaml:180-189` `git add -A && git diff --cached`.
- **Prometheus 정식 대응**: regression baseline 사전선택 = `prometheus/lang_graph/nodes/bug_get_regression_tests_selection_node.py:87` "You MUST select N regression tests most likely to break existing functionality", `:120` `[test.test_identifier ...]`; 실행노드 `prometheus/lang_graph/nodes/run_regression_tests_subgraph_node.py:12-53`.
- 스캐폴드 프롬프트엔 stash-control 명시 드묾 → **우리 신규 steer 후보**(에이전트가 즉흥 사용).

### M5 — call-graph grep 선바운딩 (blast radius 한정) — 11138 공통
- 메커니즘: edit 전 `_convert_field_to_tz`/`CONVERT_TZ`/`create_function` 등 grep으로 변경집합 한정.
- 도구: 각 스캐폴드의 bash/grep 도구(TRAE `bash_tool.py`, live-swe yaml action). 프롬프트 강제는 약함, 모델 습관.

---

## 4. 공통 root cause & absorb (ROI순)

⚠️**[2026-06-24 적대어딧 정정]** 3실패가 "하나의 root cause(oracle 루프 부재)"로 수렴한다는 원래 결론은 **과대단순화**. 케이스별로 원인이 다름:
- **13033** = 기대 리터럴 안 읽고 자작 메시지(진짜 방법론 갭, M2 해당). 우리 패치 non-empty wrong.
- **14315** = consumer(base/client.py)로 안 번진 dual-site miss(진짜 방법론 갭, M1 해당). 우리 패치 non-empty 1-site.
- **11138** = **인프라 버그**(fork-worktree 패치추출). M3/M5 oracle·localize 이미 작동, 4파일 정확편집+pytest 실행함. **방법론 갭 아님** → absorb 대상에서 제외.
즉 "우리는 oracle 루프가 없다"는 일반화는 11138 증거로는 **거짓**(우리도 repro+pytest 돌림). 13033/14315는 generation 품질(spec-read/consumer-localize) 문제.

흡수 우선순위(정정):
1. **M2** — localize에 failing-test 본문+"기대 리터럴 먼저 읽기" steer (13033 직접대응, 저비용 고ROI). 앵커=TRAE `agent_prompt.py:22-42`, OpenHands `system_prompt.j2:64`.
2. **M1 consumer-localize** — 반환값 버그면 caller도 찾는 steer (14315 직접대응). 앵커=스캐폴드 미내장, 신규.
3. **11138은 absorb 아님 → fork-session 패치추출 버그 수정**(별개 인프라 티켓). [[worktree-node-modules-hazard]] [[jun-17-bench-failure-fix-and-fork-feature]] 계열.
4. M3(test-oracle 게이트)/M4(paired-control)/M5(grep 선바운딩)은 일반적으로 유효하나 **이 3케이스가 그 필요성을 입증하진 못함**(우리가 이미 그 행동을 함). 앵커=Prometheus `issue_verified_bug_subgraph.py:216-223`.
금지: M0 PR/issue 네트워크 fetch(=answer-key, OpenHands 14315).

---

## 부록 — 참조 코드 전체 경로 (full path + line, 검증됨 2026-06-24)

### 경쟁사 스캐폴드 (차용 방법론 근거)
TRAE (github.com/bytedance/trae-agent @ e839e55):
- M2 spec/test-first 프롬프트: `/Users/songmin/Documents/code-new/competitor-scaffolds/trae-agent/trae_agent/prompt/agent_prompt.py:22` (Reproduce the Bug), `:34` (Verify and Test), `:36` ("Execute the existing test suite for the modified files")
- M3 agent loop: `/Users/songmin/Documents/code-new/competitor-scaffolds/trae-agent/trae_agent/agent/base_agent.py:163` (`while step_number <= self._max_steps:`)
- M3 bash/test runner: `/Users/songmin/Documents/code-new/competitor-scaffolds/trae-agent/trae_agent/tools/bash_tool.py:213` (`execute`), `:236` (`self._session.run`), `:159` (`ToolExecResult(error_code=...)` non-zero exit 가시화)

OpenHands agent-sdk (github.com/All-Hands-AI/agent-sdk @ b032401):
- M2 test-first 프롬프트: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/openhands-sdk/openhands/sdk/agent/prompts/system_prompt.j2:64` ("Create tests to verify issues before implementing fixes")
- VERIFICATION 단계: 같은 파일 `:74` ("5. VERIFICATION: ... test your implementation thoroughly, including edge cases")
- M3 agent loop: `/Users/songmin/Documents/code-new/competitor-scaffolds/openhands-agent-sdk/openhands-sdk/openhands/sdk/agent/agent.py:542` (`def step`)

Prometheus (github.com/EuniAI/Prometheus @ 5e1b712):
- M3 verify→edit 게이트 루프: `/Users/songmin/Documents/code-new/competitor-scaffolds/prometheus-agent/prometheus/lang_graph/subgraphs/issue_verified_bug_subgraph.py:218` (`lambda state: bool(state["reproducing_test_fail_log"])`), `:220` (True→`issue_bug_analyzer_message_node` 재시도), `:212` (verify로 진입)
- 게이트 로그: `/Users/songmin/Documents/code-new/competitor-scaffolds/prometheus-agent/prometheus/lang_graph/nodes/bug_fix_verification_subgraph_node.py:50` ("Passing bug reproducing test: ...")
- M4 regression 사전선택: `/Users/songmin/Documents/code-new/competitor-scaffolds/prometheus-agent/prometheus/lang_graph/nodes/bug_get_regression_tests_selection_node.py:87` ("You MUST select N regression tests..."), `:120` (`[test.test_identifier ...]`)

live-swe-agent (github.com/OpenAutoCoder/live-swe-agent @ 8d7dd86):
- M2 workflow 프롬프트: `/Users/songmin/Documents/code-new/competitor-scaffolds/live-swe-agent/config/livesweagent_swebench.yaml:42` (Recommended Workflow)
- F0 정답 제출패턴(에이전트 작업트리에서 diff): 같은 파일 `:185` (`git add -A && git diff --cached`)
- step 한도: 같은 파일 `:232` (`step_limit: 250`)

Qodo (14315 consumer-localize 근거 / closed, trace만): `/Users/songmin/Documents/code-new/competitor-scaffolds/_swe-traces/django__django-14315/Qodo__closed.txt` (git log/show bbe6fbb876 + base-client 결정 구간)

### trajectory 다운로드 (full path)
- `/Users/songmin/Documents/code-new/competitor-scaffolds/_swe-traces/django__django-14315/OpenHands_DevStral__OSS.json` (❌answer-key, msg 28/32/33 curl PR)
- `/Users/songmin/Documents/code-new/competitor-scaffolds/_swe-traces/django__django-14315/Qodo__closed.txt`
- `/Users/songmin/Documents/code-new/competitor-scaffolds/_swe-traces/astropy__astropy-13033/Sonar_Sonnet45__closed.json` (MSG 14/16/18/19)
- `/Users/songmin/Documents/code-new/competitor-scaffolds/_swe-traces/django__django-11138/{OpenHands__OSS.json,TRAE_Doubao__OSS.json,live-swe_Opus45__OSS.json,Prometheus_GPT5__OSS.log}`
- 실패 traj 격리: `/Users/songmin/Documents/code-new/competitor-scaffolds/_swe-traces/_FAILED-do-not-analyze/`

### 우리 스캐폴드 수정/근거 지점 (full path)
- F0 패치추출 seam: `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/snapshot.ts:137` (`gitStageAndDiffCached(cwd,...)`), `:159` (`withGitSnapshot(sandbox,...)`), `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/report.ts:94`-`111` (`patchGenerated`/`countDiff`)
- F0 fork worktree 생성: `/Users/songmin/quanta-codeagent-v3/src/runner/session-execution-plane.ts`
- F1 spec-fidelity-steer(기존, 보강대상): `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/posture/capability-profiles.ts:208` (THIN_BASE), `:228` (THIN_STRICT_BASE)
- F2 CHA_MULTISITE(기존, 확장대상): `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/posture/capability-profiles.ts:126`
- LSP nav(F2 consumer refs 재사용): LOCALIZATION_CORE `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/posture/capability-profiles.ts:181` (`lsp:"1"`)
- 우리 실패 trace(11138 fork 증거): `/Users/songmin/quanta-codeagent-v3/.bench-pull/run-1782190012887/observe/django__django-11138.0.jsonl`
- gold/test patch: `/Users/songmin/quanta-codeagent-v3/.tmp/bench-ouronly-visible-2026-06-21/three-confirmed-fails.jsonl`
- 우리 모델패치: `/Users/songmin/quanta-codeagent-v3/.tmp/bench-ouronly-visible-2026-06-21/rca-case-extracts/{django--django-14315,astropy--astropy-13033}.model.patch`

### 잔여 불확실성(어딧 미해소)
- 14315/13033도 각 9~11세션(best-of-N) — 최종 제출패치만 검증했고, 더 나은 후보를 selection이 떨군 confound 가능성은 미확인.
- board solve 22/3/4 중 7엔트리(GPT-4.1/4o/Gemini2.0/Llama4 등 약모델)는 results.json 폴더경로 불일치로 미검증(해당셋 solve 가능성 낮아 수치영향 미미로 판단).
- 13033 Sonar trace는 diagnosis까지만 truncated — "기존테스트 read"는 검증, 최종패치가 method로 맞췄는지 vs 운인지는 미검증(RESOLVED는 확정).
