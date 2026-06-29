# oracle-ab regression set (jun-29)

`agentless-v6-oracle` vs `agentless-v6-singlepass-execfull` A/B 측정 셋 (쿼터 풀리면).

- **타겟 15개** (synthesis-class fail, 경쟁사가 푼·우리 under-edit/wrong-predicate): astropy-14369, django-11265, django-13512, django-14376, xarray-3993, xarray-6599, xarray-6744, pylint-6386, scikit-learn-14087, scikit-learn-14983, sympy-13974, sympy-14976, sympy-15976, sympy-19783, sympy-23413
- **통제 7개** (이번세션 우리 PASS — 오라클이 회귀 안 시키는지 가드): sphinx-8595, sphinx-10323, sphinx-11510, sphinx-9230, sympy-21379, django-16560, astropy-13236

측정: recovery(타겟 회수율) + regression(통제 깨짐=0이어야) + cost-per-recovered.
정직: n=15 directional 파일럿(solvable-bias+small-n noise), leaderboard delta 아님.
패치 교본=../competitor-study/. 먼저 2개(django-11265,sympy-23413) 파일럿 de-risk.
