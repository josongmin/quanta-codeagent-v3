---
instance_id: sympy__sympy-13877
repo: sympy/sympy
base_commit: 1659712001810f5fc563a443949f8e3bb38af4bd
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: 2018-01-10T01:55:34Z
fail_to_pass: 1
pass_to_pass: 110
gold_files: [sympy/matrices/matrices.py, sympy/utilities/randtest.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약

`det(Matrix([[i + a*j for i in range(n)] for j in range(n)]))` 같은 특정 심볼릭 행렬에서 기본 행렬식 알고리즘(Bareiss)이 `n=5`에서 `nan`을 반환하고 `n=6`부터는 `TypeError: Invalid NaN comparison`으로 죽는다. 스택트레이스를 보면 Bareiss 재귀가 `cancel()`→`factor_terms`로 들어가다가 `0/0` 꼴 식에서 NaN을 만들어 비교가 터진다. 근본 원인은 Bareiss의 피벗 선택이 `if val:`로만 0을 판정해, "표현식 형태로는 0이 아니지만 전개하면 0"인 항목을 피벗으로 골라 다음 단계에서 0/0을 만들기 때문이다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈에 완전한 네이티브 스택트레이스가 있어 `matrices.py:_eval_det_bareiss`의 `bareiss`/`_find_pivot`까지 직행한다. 단 트레이스 종착점(`exprtools.factor_terms`)은 증상 위치일 뿐 수정 위치가 아니라, 위로 거슬러 "왜 0/0이 생겼나"를 추적하는 약간의 작업이 필요 → L0가 아니라 L1.
- **S2 (Constraint-Reasoning) +S6**: 고칠 함수는 명확하지만 올바른 픽스는 "어떤 zero-detection이 다항/유리식에 충분하면서도 느리지 않은가"를 추론해야 한다. 단순 `if val:` 대신 `expand_mul(x) == 0`라는 의미적 영-판정을 합성하고, 임시 `_find_pivot` 헬퍼를 제거해 정식 `_find_reasonable_pivot`로 갈아끼우는 소규모 구조변경(S6)을 동반.
- **K-Domain**: sympy의 영-판정 의미론(structural zero vs. expand 후 zero), Bareiss 알고리즘의 무분수성 전제, `iszerofunc` 계약을 알아야 픽스가 옳다고 판단할 수 있다.
- **primary = T-ConstraintReason**: 위치는 잡히나 핵심 난점이 "수학적으로 옳은 영-판정 조건식을 추론 합성"하는 데 있음. 템플릿 가드(S1)로는 못 풀고 테스트 반복(S3)도 본질이 아님.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처: 2파일·소규모 헌크(핵심은 `matrices.py` 한 헌크 + 보조 `randtest.py` 1줄)지만 (1) localize가 트레이스 종착점≠수정점이라 한 단계 거슬러야 하고, (2) 픽스가 단순 가드가 아니라 도메인 추론(expand_mul 영-판정)과 헬퍼 교체를 요구하며, (3) P2P 110개로 regression 표면이 넓다(특히 `test_find_reasonable_pivot_naive_*`, `test_partial_pivoting`, `test_iszero_substitution` 등 피벗 경로 인접 테스트). 공식 라벨 "15 min – 1 hour"와 정합 — has-repro라 시간은 짧지만 올바른 일반화 판단에 도메인 지식이 필요해 T2로 내리지 않는다.

## 골드패치 분석

- **`sympy/matrices/matrices.py`** — 핵심.
  - 새 헬퍼 `_is_zero_after_expand_mul(x)` 추가: `expand_mul(x) == 0` (다항·유리식에 적합한 영-판정). 상단에 `from sympy.core.function import expand_mul` import 추가.
  - `_eval_det_bareiss` 내부의 임시 클로저 `_find_pivot`(이슈 #12362 워크어라운드로 들어가 있던, `if val:`로만 영-판정하던 함수)을 **삭제**.
  - `bareiss`의 피벗 선택을 `_find_reasonable_pivot(mat[:, 0], iszerofunc=_is_zero_after_expand_mul)`로 교체. 주석에 기본 `iszerofunc` 대신 expand_mul을 쓰는 성능 사유(#10279, #13877)를 명시.
- **`sympy/utilities/randtest.py`** — 보조. `random_complex_number`에 `tolerance=None` 파라미터를 추가하고 `nsimplify(..., rational=True, tolerance=tolerance)`로 전달. 영-판정 강화 후 랜덤 검증의 수치 허용오차를 조절할 수 있게 하는 동반 변경.
- **근본원인**: `if val:`는 `2*a**2 - a*(2*a+...)`처럼 전개해야 0이 되는 항을 비-0으로 보고 피벗으로 채택 → 다음 Bareiss 스텝에서 0/0(NaN) 생성. **수정요지**: 피벗 영-판정을 "구조적 비-0"에서 "expand_mul 후 == 0"이라는 의미적 판정으로 끌어올려 가짜 피벗을 배제.

## 검증 (test_patch)

- **FAIL_TO_PASS = `test_determinant`** (단일). `test_matrices.py`에 `M = lambda n: Matrix([[i + a*j ...]])`로 `M(5).det()==0`, `M(6)==0`, `M(7)==0` 단언 추가. 패치 전엔 `n=5`가 `nan`, `n=6/7`이 `TypeError`로 죽던 케이스다. 픽스 후엔 가짜 피벗이 expand_mul로 0으로 걸러져 알고리즘이 올바른 0을 산출.
- **픽스 증명**: 추가된 3개 케이스(n=5,6,7)가 정확히 옛 실패 지점(nan/예외)을 덮고, 결과값 0은 수학적으로 검증 가능(해당 행렬들은 실제로 특이행렬).
- **overfit 관점**: FAIL_TO_PASS가 얇아(1개 함수) special-case 우려가 있으나, 픽스가 입력별 분기가 아니라 영-판정 일반화라 overfit-risk는 낮음. 다만 n=5,6,7만 검증하므로 "특정 패턴 회피"식 꼼수 패치가 통과할 여지는 형식상 존재 → has-repro가 이를 완화.
- **regression 관점**: 피벗 선택 경로를 전면 교체하므로 P2P의 피벗·영-판정 인접 테스트(`test_find_reasonable_pivot_naive_*`, `test_LUdecomposition_*_iszerofunc`, `test_partial_pivoting`, `test_iszero_substitution`)와 `test_det_LU_decomposition`을 깨지 않아야 함. `regression-trap` 플래그 사유.

## 모범답안 (오라클 기반)

1. **localize**: 스택트레이스를 `factor_terms`/`__lt__`(증상)에서 위로 따라가 `matrices.py:_eval_det_bareiss`의 `bareiss`→`_find_pivot`이 0/0을 만든 진원지임을 파악. 이슈 마지막 힌트("`_find_pivot`이 `val.expand()` 같은 zero detection을 써야 한다")가 수정점을 직접 지목한다.
2. **픽스와 일반화 근거**: `if val:`(구조적 비-0)는 다항/유리식에서 위양성을 낸다. `expand_mul(x)==0`로 의미적 영-판정을 도입하면 "전개하면 0"인 가짜 피벗을 일반적으로 배제 — 특정 행렬이 아니라 모든 polynomial/rational 항목에 옳다. 동시에 임시 `_find_pivot`을 정식 `_find_reasonable_pivot(iszerofunc=...)`로 교체해 #12362 워크어라운드 부채를 청산(S6). 기본 `iszerofunc`가 아닌 expand_mul을 쓰는 이유는 성능(2.5배 차이)으로 정당화됨.
3. **regression 안전**: 교체한 `_find_reasonable_pivot`는 이미 LU/가우스 경로에서 검증된 함수라 피벗 품질이 떨어지지 않는다. expand_mul은 정수/단순 심볼 행렬에서 기존과 동일 결과를 내므로 `test_determinant`의 기존 단언(`z**2 - x*y` 등)과 `test_det_LU_decomposition`을 보존.
4. **함정 회피**: 오라클 없는 에이전트는 (a) 힌트만 보고 `det`의 기본 method를 LU로 바꾸는 회피책(이슈 본문 제안)을 택하기 쉬운데, 이는 Bareiss를 고치지 않아 근본원인을 남기고 다른 호출 경로에서 재발 → 골드는 Bareiss 자체를 고침. (b) `factor_terms`(트레이스 종착점)를 NaN 가드로 패치하면 증상 위치를 잘못 잡는 전형적 오류. (c) `if val.expand():`처럼 `expand`만 쓰면 유리식에서 부족할 수 있어 `expand_mul` 의미를 정확히 골라야 함.
