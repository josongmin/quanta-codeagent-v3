# SWE-bench Verified — Local Leaderboard

로컬(arm64 Docker, official Python harness) 정식 채점으로 **resolved** 된 인스턴스 기록.
preset/model 별로 실제 통과한 것만 올림. FAIL/미시도는 별도 섹션.

- harness: `QUANTA_SWEBENCH_PYTHON=1` + prebuilt amd64 이미지 pull → 에뮬레이션 실행 (max_workers=1)
- grading 신뢰도: ★★★ (가짜 testCmd=true 아님, 실제 FAIL_TO_PASS 통과)

## ✅ Resolved

| instance | repo | preset | model | turns | date |
|---|---|---|---|---|---|
| psf__requests-5414 | requests | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 16 | 2026-06-15 |
| sympy__sympy-16886 | sympy | agentless-v1 | gpt-5.4 (chatgpt-oauth) | 19 | 2026-06-15 |

## ❌ Attempted but unresolved

| instance | repo | preset | model | reason | date |
|---|---|---|---|---|---|
| pylint-dev__pylint-8898 | pylint | agentless-v1 | gpt-5.4 | completed_unresolved — quantifier `{1,}` 콤마 split을 shlex로 잘못 처리(brace-aware 파서 필요); 1파일로 풀리는 문제, 모델 추론 미스 | 2026-06-15 |

## 메모
- baseline 비교용: 과거 기록은 gpt-5/gpt-5-mini(OPENAI_API_KEY). 현재 기록은 chatgpt-oauth gpt-5.4라 직접 비교 주의.
- `QUANTA_SWEBENCH_PYTHON_BIN`은 절대경로 필수(sandbox cwd spawn → 상대경로 ENOENT).
