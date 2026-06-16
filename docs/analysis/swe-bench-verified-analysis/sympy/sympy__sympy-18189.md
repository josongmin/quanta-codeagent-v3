---
instance_id: sympy__sympy-18189
repo: sympy/sympy
base_commit: 1923822ddf8265199dbd9ef9ce09641d3fd042b9
version: "1.6"
difficulty: "<15 min fix"
created_at: 2019-12-31T15:45:24Z
fail_to_pass: 1
pass_to_pass: 41
gold_files: [sympy/solvers/diophantine.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약

`diophantine`에 `permute=True`를 줄 때, `syms` 인자의 순서에 따라 결과가 불완전해진다.
`syms=(m,n)`이면 8개 해(부호·순열 전개)가 나오지만, `syms=(n,m)`이면 `{(3, 2)}` 하나만 반환된다.
즉 동일 방정식·동일 옵션인데 심볼 나열 순서만 바뀌면 해집합이 달라지는 정합성 버그다.

## 유형 (정형화)

- **L (Localization) = L0.** 이슈 본문이 `diophantine` L182-185 self-recursion 라인을 GitHub permalink로 직접 지목한다. grep 한 방이고 후보 탐색이 사실상 0.
- **S (Repair Strategy) = S1.** 픽스는 재귀 호출 `diophantine(eq, param)`에 누락된 키워드 인자 `permute=permute`를 전달하는 것. "인자 전달 누락" 정형 결함클래스에 기계적으로 매칭 — 새 식·조건을 추론 합성할 필요가 없다.
- **K (Knowledge) = K-Domain.** 한 줄 수정이지만 "왜 순서가 바뀌면 깨지는가"를 이해하려면 `syms != var`일 때 정규 순서로 재귀하고 인덱스 remap하는 sympy diophantine 내부 흐름(도메인 지식)을 봐야 한다. 다만 픽스 자체는 도메인 지식 없이도 hint만으로 복사 가능.

primary type = **T-DirectMap**: 위치가 명확(L0)하고 픽스가 누락 인자 전달이라는 기계적 S1 변경이다. 이슈/hint가 픽스를 사실상 적어주지만 픽스 위치는 self-recursion이라 약간의 흐름 이해가 들어가 T-LocTrivial보다 T-DirectMap이 정확.

## 난이도 티어

**T2 (쉬움).** 공식 라벨 `<15 min fix`와 일치한다.
- 파일수 1, 변경 줄수 1(헌크 1개). 구조적으로 가장 작은 패치 클래스.
- localize 직접성 최상(L0): 이슈에 라인 permalink + diff가 그대로 첨부됨(has-repro에 준하는 강한 easiness 신호).
- 픽스 자명(S1): `permute=permute`만 추가.
- T1로 더 내리지 않는 이유: 수정 지점이 함수의 self-recursion이고, `permute` 플래그가 재귀에서 소실되는 경로를 이해해야 정답을 확신할 수 있어 완전 자명(K-Gen)은 아니다(K-Domain). 또한 P2P 41개로 regression 표면이 넓어 단순 T1보다 한 단계 위.

## 골드패치 분석

- **파일/함수:** `sympy/solvers/diophantine.py`의 `diophantine()` 진입부.
- **근본원인:** `syms`가 변수의 정규 순서 `var`와 다를 때(`if syms != var`), 함수는 자기 자신을 정규 순서로 재귀 호출한 뒤 `dict_sym_index`로 결과 튜플을 사용자 순서로 remap한다. 그런데 이 재귀 호출 `diophantine(eq, param)`이 호출자의 `permute` 인자를 넘기지 않아 항상 기본값 `permute=False`로 풀린다. 따라서 `syms` 순서가 정규 순서와 다른 경우에만 순열/부호 전개가 통째로 누락되어 해 1개만 남는다.
- **수정요지:** 재귀 호출을 `diophantine(eq, param, permute=permute)`로 바꿔 `permute` 플래그를 전파. 이로써 두 syms 순서가 동일한 (remap만 다른) 해집합을 산출한다.

## 검증 (test_patch)

- **FAIL_TO_PASS = `test_diophantine` (1개).** 추가된 단언은 `diophantine(y**4 + x**4 - 2**4 - 3**4, syms=(x, y), permute=True)`와 `syms=(y, x)` 두 순서 모두에 대해 동일한 8원소 집합 `{(-3,-2),(-3,2),(-2,-3),(-2,3),(2,-3),(2,3),(3,-2),(3,2)}`를 요구한다.
- **픽스 증명:** 픽스 전에는 `syms=(y, x)`(정규 순서와 불일치) 경로가 `permute=False`로 재귀하여 1개 해만 remap → 단언 실패. 픽스 후 `permute=True`가 전파되어 8개 해 전부 생성 → 두 순서가 같은 집합으로 수렴.
- **overfit 관점:** 테스트는 두 가지 syms 순서를 모두 고정해 "순서 불변성"을 직접 검증하므로 special-case 통과가 어렵다. 다만 FAIL_TO_PASS가 단일 테스트 함수라 검증 폭 자체는 얇음 → `overfit-risk`는 약하게만 존재하나, 픽스가 인자 전파라는 정답형이라 실질 위험 낮음.
- **regression 관점:** `permute=False` 기본 경로는 동작이 그대로(전파해도 False면 무변화)라 41개 P2P(특히 `test_diophantine_permute_sign`, `test_diopcoverage`)가 안 깨진다. `regression-trap` 플래그는 P2P 폭(41) 때문에 표기하나, 변경이 의미적으로 추가적·비파괴적이라 실위험은 낮다.

## 모범답안 (오라클 기반)

1. **localize 경로:** 이슈가 라인 permalink로 L182-185 self-recursion을 지목 → `diophantine()` 진입부에서 `if syms != var:` 분기를 연다. 키워드 "permute is lost when diophantine calls itself"가 정확한 신호.
2. **픽스와 일반화 근거:** 재귀 호출 `diophantine(eq, param)`이 호출자 옵션을 누락 → `permute=permute`를 추가. 이는 특정 입력에 맞춘 패치가 아니라 "옵션이 재귀에서 소실된다"는 일반 결함을 닫는 것이므로 모든 (방정식 × syms 순서) 조합에 올바르게 일반화된다.
3. **regression 안전:** 기본 `permute=False`에서는 `permute=permute`가 무동작이라 기존 비순열 동작이 보존됨 → `test_quadratic_*`, `test_diop_*` 등 41 P2P 무손상. 순서가 정규와 같은 경로(`syms == var` 또는 `syms is None`)는 분기 자체를 안 타므로 영향 없음.
4. **함정 회피:** 오라클 없는 에이전트가 빠질 함정은 (a) `permute` 전파 대신 remap 로직(`dict_sym_index`)을 의심해 엉뚱한 곳을 고치거나, (b) `syms != var` 분기 밖의 메인 경로에 순열 후처리를 덧대는 과잉 수정. 정답은 "정규 순서 메인 경로는 이미 옳고, 비정규 순서가 그 메인 경로를 옵션 없이 재호출하는 것만이 버그"임을 파악해 단일 인자 전파로 끝내는 것.
