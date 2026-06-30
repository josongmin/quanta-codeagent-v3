# Competitor-study corpus — synthesis-convergence lever 교본

우리가 fail했고 오픈 스캐폴드가 푼 23개. 각 폴더: `competitor.diff`(쟤네 정답패치) `gold.diff` `ours-FAIL.diff`(우리 틀린패치) `SOURCE.txt`(어느 스캐폴드).

**용도**: 우리 synthesis fail을 경쟁사가 어떤 edit으로 수렴시켰나 직접 비교 → 오라클루프/best-of-N 레버 설계 교본. 전체 trajectory는 `s3://swe-bench-submissions/verified/<scaffold>/trajs/<inst>.traj` (--no-sign-request).

| instance | 경쟁사 파일적중 | 우리 파일적중 |
|---|---|---|
| astropy__astropy-14369 | Y | Y |
| django__django-11265 | Y | Y |
| django__django-11728 | Y | - |
| django__django-12325 | Y | - |
| django__django-13512 | Y | Y |
| django__django-14376 | Y | Y |
| django__django-15563 | Y | - |
| django__django-15695 | Y | - |
| matplotlib__matplotlib-20676 | Y | - |
| matplotlib__matplotlib-20826 | n | n |
| pydata__xarray-3993 | Y | Y |
| pydata__xarray-6599 | n | Y |
| pydata__xarray-6744 | Y | Y |
| pylint-dev__pylint-6386 | Y | Y |
| pylint-dev__pylint-7080 | n | n |
| scikit-learn__scikit-learn-14087 | Y | Y |
| scikit-learn__scikit-learn-14983 | Y | Y |
| sympy__sympy-12489 | Y | - |
| sympy__sympy-13974 | Y | Y |
| sympy__sympy-14976 | Y | Y |
| sympy__sympy-15976 | Y | Y |
| sympy__sympy-19783 | Y | Y |
| sympy__sympy-23413 | Y | Y |

**집계**: 경쟁사는 23/23 중 20개서 gold파일 적중. 우리는 15개 적중/2개 파일틀림 → 우리도 파일은 대체로 맞췄는데 **edit이 틀려 fail**(synthesis), 경쟁사는 같은 파일을 올바른 edit으로 수렴. = jun-29 본질분석과 일치.

---

## 분석 결론 (jun-29) — synthesis fail의 정체 + 오라클루프 정당화

**23개 재분류 (우리-패치 실측):**
- SYNTHESIS(같은파일 다른edit) 9 + MULTISITE(파일누락) 5 + LOCALIZATION(파일틀림) 2 = **진짜 synthesis-class 16**
- 우리=빈패치 6 = **계정-death 좀비**(gapL 쿼터죽음, 진짜 fail 아님 — 집계서 제외)
- 동일패치인데fail 1 (sympy-23413, 아래)

**synthesis fail 2대 시그니처 (corpus 실측):**
1. **UNDER-EDIT (증상만 고침)** — django-11265: 우리=`_filtered_relations.copy()` 1줄(증상), gold=그것+JOIN트리밍 로직(`first_join.filtered_relation`)=진짜원인. 그럴듯한 얕은 fix가 root cause 못 짚음.
2. **WRONG-PREDICATE (구조맞고 조건틀림)** — sympy-23413: 우리=`if k==0 or (m>n and k>i+1)`, 경쟁사=`if k<=0`. 같은 구조 다른 조건.

**핵심**: 둘 다 *읽으면 그럴듯한데 fail-to-pass 테스트는 통과 못 하는* 패치. n=1 single-pass엔 실행 피드백이 없어 모델이 자기 edit이 틀린 걸 인지 못함. **유일 검출법 = 테스트 실행(오라클).**

**→ 오라클 루프 레버 설계 (직접 도출):**
- 패치 생성 후 **FAIL_TO_PASS 테스트 실행** → still red면 "내 수정이 안 고침" 신호를 모델에 되먹임 → iterate
- under-edit는 테스트 still-fail로 잡혀 "더 깊이 파라" 유도; wrong-predicate도 동일
- 이미 있는 verify-and-select(repro-vote)와 결합: 오라클이 reject한 후보는 best-of-N서 탈락
- 검증은 계정 쿼터 풀린 뒤 A/B(오라클 ON vs OFF, 이 14개 synthesis-class corpus가 회귀 셋)
