# SWE-bench Verified — Local Leaderboard

로컬(arm64 Docker, official Python harness) 정식 채점으로 **resolved** 된 인스턴스 기록.
preset/model 별로 실제 통과한 것만 올림. FAIL/미시도는 별도 섹션.

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

## 메모
- baseline 비교용: 과거 기록은 gpt-5/gpt-5-mini(OPENAI_API_KEY). 현재 기록은 chatgpt-oauth gpt-5.4라 직접 비교 주의.
- `QUANTA_SWEBENCH_PYTHON_BIN`은 절대경로 필수(sandbox cwd spawn → 상대경로 ENOENT).
