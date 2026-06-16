# SWE-bench Verified — Local Leaderboard

로컬(arm64 Docker, official Python harness) 정식 채점으로 **resolved** 된 인스턴스 기록.
preset/model 별로 실제 통과한 것만 올림. FAIL/미시도는 별도 섹션.

> **머신리더블 SSOT = [`swebench-leaderboard.yaml`](swebench-leaderboard.yaml)** (run 블록별 resolved 리스트). 이 md는 사람이 보는 큐레이션 뷰 — 전체 resolved 인스턴스는 yaml 참조.

## 📊 easy django T1+T2 batch (2026-06-16, scaffold-fixed) — 39 resolved

우리 정형화 분석의 easy 티어(T1 존나쉬움 + T2 쉬움) django 84개 블라인드 런. **bench 스캐폴드 2버그 구조수정 후** 측정:
deadline을 env-setup 후 arm + 기본 per-instance 타임아웃 2분→10분 + bench stale-read-guard off
([driver.ts](../src/apps/bench/eval/driver.ts), [index.ts](../src/apps/bench/index.ts)).
**효과: abort 74%(39/53) → 0%.** 같은 gpt-5.4가 mini-swe-agent 수준으로 회복 — quanta가 틀렸던 django-12039·12304가 수정 후 PASS(스캐폴드 탓 확정, 모델 아님).
confirmed **resolved 39 django** (remaining 런 진행 중, 전체 목록은 yaml).

- harness: `QUANTA_SWEBENCH_PYTHON=1` + prebuilt amd64 이미지 pull → 에뮬레이션 실행 (max_workers=1)
- grading 신뢰도: ★★★ (가짜 testCmd=true 아님, 실제 FAIL_TO_PASS 통과)

## picks-10 (agentless-v1, gpt-5.4) — 5/10 resolved (= 5/9 patch-bearing = 55.6%)

**EC2 교차검증 (2026-06-15, c7i.8xlarge spot, native, run_id=quanta-ec2-r2)**: 동일 패치를
x86 네이티브로 재채점 → **resolved 5/10, error 0, 56초**(arm64 에뮬레이션 몇시간 대비). 로컬
5 resolved와 정확히 일치. 로컬의 "infra fail 2개" 정체 해소: pytest-5787은 진짜 unresolved
(model miss, 로컬 harness_error는 경합 노이즈), sympy-12489는 빈 패치(patch-gen 실패).

**로컬 병렬 재검증 (2026-06-15, concurrency=4, probe-fix + fake-fallback 제거 후)**: 로컬 arm64에서
patch-gen 4-way 병렬 + grading mutex 직렬로 재실행 → **resolved 5/10, harness_error 0**(이전
직렬 런의 infra-fail 2개가 이제 전부 진짜 completed_unresolved). 병렬화가 정확성 안 바꿈(직렬·EC2와
동일 5개) + silent fake 폴백 제거로 모든 실패가 신뢰 가능한 verdict. import-probe 15s→60s(swebench
import이 idle 9~13s라 부하 시 초과해 fake로 폴백하던 버그) + swebench 인스턴스 testCmd 폴백 차단.

## ✅ Resolved

| instance | repo | preset | model | turns | date |
|---|---|---|---|---|---|
| psf__requests-5414 | requests | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 16 | 2026-06-15 |
| sympy__sympy-16886 | sympy | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 19 | 2026-06-15 |
| pallets__flask-5014 | flask | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 23 | 2026-06-15 |
| sympy__sympy-13480 | sympy | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 16 | 2026-06-15 |
| pytest-dev__pytest-7982 | pytest | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 17 | 2026-06-15 |

## ⛔ 채점불가 — grading env false-negative (gold도 fail; 모델 무죄)

| instance | repo | 확인 | date |
|---|---|---|---|
| sphinx-doc__sphinx-8595 | sphinx | 에이전트 패치 = gold와 byte-identical. **gold 패치 직접 채점해도 동일하게 unresolved**(applied:True, test_empty_all fail). 로컬 instances.jsonl test_patch ↔ prebuilt `swebench` 이미지 환경 불일치(로그에 Sphinx-3.5.0.dev 재설치). EC2도 동일 재현. → 점수 산정에서 제외. 모델은 사실상 정답. | 2026-06-15 |

## ❌ Unresolved — model miss (real, agent 패치가 gold와 명확히 다름)

| instance | repo | preset | model | reason | date |
|---|---|---|---|---|---|
| pylint-dev__pylint-8898 | pylint | agentless-v1 | gpt-5.4 | quantifier `{1,}` 콤마 split을 shlex로 잘못 처리(brace-aware 파서 필요); 1파일로 풀리는 문제, 모델 추론 미스 | 2026-06-15 |
| pylint-dev__pylint-4970 | pylint | agentless-v1 | gpt-5.4 | 가드를 `_compute_sims()`에 넣음(gold는 `run()`에 early-return); 위치/의미 미묘하게 빗나간 near-miss | 2026-06-15 |
| pytest-dev__pytest-5787 | pytest | agentless-v1 | gpt-5.4 | 미완성 — chained exception 직렬화를 절반만(4369자 vs gold 9824자) | 2026-06-15 |
| sympy__sympy-12489 | sympy | agentless-v1 | gpt-5.4 | 대폭 미달 — Permutation 서브클래싱 광범위 수정 필요한데 1109자만(gold 9648자) | 2026-06-15 |

## ⚠️ 로컬 infra fail → EC2 재채점으로 해소 (2026-06-15)

| instance | repo | 로컬 | EC2 네이티브 재채점 결과 |
|---|---|---|---|
| pytest-dev__pytest-5787 | pytest | harness_error(경합) | **unresolved (진짜 model miss)** — 인프라 아님 |
| sympy-dev__sympy-12489 | sympy | code 143 SIGTERM(경합) | **empty patch** — patch-gen 실패(채점 무관, 재생성 필요) |

## 🤖 mini-swe-agent baseline (표준 스캐폴드, gpt-5.4 via 로그인)

quanta(agentless-v1)와 **별개 스캐폴드**인 mini-swe-agent v2를 같은 gpt-5.4(로그인)로 돌린 per-instance 해결여부.
스캐폴드 차이가 결과를 가르는지 비교용 칼럼. `✅`=resolved, `❌`=unresolved, 빈칸=미시도.

- 실행: `~/swe-bench-tools/mini-login.sh -y -l 0 --exit-immediately -t "<problem_statement>"` (base_commit 워크트리 cwd)
  - 로그인 경로: mini(litellm) → `_data/oauth-proxy.ts`(:8765) → quanta `createLLM("chatgpt-oauth")` → gpt-5.4 (raw key 불요)
- 채점: mini 패치 → `mini-predictions.jsonl` → **공식 swebench harness**(`run_evaluation`, arm64 에뮬, max_workers=1, namespace=swebench) — quanta 칼럼과 **동일 grader**라 apples-to-apples. 산출물: `docs/analysis/swe-bench-verified-analysis/_data/mini-picks10-{predictions.jsonl,report.json}`.

### picks-10 — mini 5/10 vs quanta(agentless-v1) 5/10 → **인스턴스 단위 1:1 동일**

mini가 10개 전부 골드 파일 적중(picks=light 티어). resolved/unresolved 분할이 quanta와 정확히 일치 — 스캐폴드(mini vs 우리 harness 강제)가 결과를 안 가르고 **모델+localization이 결정**.

| instance | repo | mini | quanta | 근거 |
|---|---|---|---|---|
| psf__requests-5414 | requests | ✅ | ✅ | both resolved |
| pallets__flask-5014 | flask | ✅ | ✅ | both resolved |
| sympy__sympy-13480 | sympy | ✅ | ✅ | both resolved |
| sympy__sympy-16886 | sympy | ✅ | ✅ | both resolved |
| pytest-dev__pytest-7982 | pytest | ✅ | ✅ | both resolved |
| pylint-dev__pylint-4970 | pylint | ❌ | ❌ | both miss — 가드 위치 near-miss(gold=`run()` early-return) |
| pylint-dev__pylint-8898 | pylint | ❌ | ❌ | both miss — brace-aware 파서 필요, 1파일만 수정(gold 3파일) |
| pytest-dev__pytest-5787 | pytest | ❌ | ❌ | both miss — chained-exception 직렬화 미완성 |
| sympy__sympy-12489 | sympy | ❌ | ❌ | both miss — Permutation 서브클래싱 대폭 미달 |
| sphinx-doc__sphinx-8595 | sphinx | ⛔ | ⛔ | **grading false-neg**: 골드 패치도 이 harness서 fail(env 불일치). 양쪽 모델 무죄, 점수서 제외 |

**합계: mini 5/10 resolved (= 5/9 patch-bearing), quanta와 동일.**

### hard mislocation 케이스 (별도)

| instance | repo | mini | quanta | 근거 | date |
|---|---|---|---|---|---|
| django__django-15280 | django | ❌ | ❌ | mini가 `django/utils/deconstruct.py`(@deconstructible) 수정 — gold `related_descriptors.get_prefetch_queryset`와 무관 서브시스템(gross mislocation). FAIL_TO_PASS `1 query != 0` 잔존. 골드픽스는 동일 셋업서 GREEN(채점 유효). blind/grep도 같은 mislocation. | 2026-06-16 |

## 🟢 floor 검증 — `agentless-v2-safe` preset (bench-in-loop-exec OFF, 2026-06-16)

스캐폴드 구조수정 2탄: **in-loop 테스트 실행 강제(SWEBENCH_DIRECTIVE "MANDATORY run tests")를 제거**하는 `bench-in-loop-exec` knob + `agentless-v2-safe` preset. host test-env이 incompatible한 인스턴스(pytest-7982 등)에서 에이전트가 못 돌리는 테스트를 강제당해 flail→abort하던 경로를 끊음(edit-and-submit=mini-swe posture; 채점기가 도커서 테스트 실행).

**검증 (pytest-7982, abort→RESOLVED):**

| preset | 결과 |
|---|---|
| agentless-v1 (in-loop ON) | ❌ ABORT — 16턴 pytest collection-error flail, empty_patch |
| **agentless-v2-safe (floor OFF)** | ✅ **RESOLVED** — 9턴, pytest 호출 0, 475B 패치(src/_pytest/pathlib.py=골드), 공식 harness 통과 |

구현: default-ON knob(미설정=byte-identical), `SWEBENCH_DIRECTIVE_NOEXEC` 분기 + verifyGuard/repro/repair 게이트(runner buildConfig + apps runInstanceOnce), 7 hellgate teeth + 438 bench유닛 0회귀 + 3렌즈 적대어딧. 산출물 `_data/floor-validate-pytest7982.json`. agentless-v1 frozen 미접촉. 계획 `~/.claude/plans/bench-exec-posture.md`.
잔여: sphinx-8595(grading false-neg)/pylint-8898(model miss) + 전체 picks-10 v2safe A/B는 transport throttle 풀린 창에서.

## 메모
- baseline 비교용: 과거 기록은 gpt-5/gpt-5-mini(OPENAI_API_KEY). 현재 기록은 chatgpt-oauth gpt-5.4라 직접 비교 주의.
- `QUANTA_SWEBENCH_PYTHON_BIN`은 절대경로 필수(sandbox cwd spawn → 상대경로 ENOENT).
