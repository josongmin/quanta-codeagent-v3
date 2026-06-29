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
