---
instance_id: sympy__sympy-23413
repo: sympy/sympy
base_commit: 10de1a18a0efac0b19b611e40c928250dda688bf
version: "1.11"
difficulty: "15 min - 1 hour"
created_at: 2022-04-23T23:40:41Z
fail_to_pass: 1
pass_to_pass: 2
gold_files: [sympy/polys/matrices/normalforms.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`hermite_normal_form`(HNF)이 행이 열보다 많은(m > n) 정수 행렬에서, rank-deficient가 아닌데도 멀쩡한 행을 제거한다. 이슈는 `[[1,12],[0,8],[0,5]]`처럼 상단 행에 pivot이 있을 때 HNF가 `[[12],[8],[5]]` 같은 단일 열로 잘못 축소되는 재현을 제시한다. 사용자는 flip/transpose로 row-style HNF를 얻으려다 행이 사라지는 것을 관찰했고, Wolfram의 `HermiteDecomposition`은 올바른 결과를 준다며 대조한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `hermite_normal_form`을 직접 지목한다. 심볼명 grep으로 `sympy/polys/matrices/normalforms.py`의 `_hermite_normal_form`까지 한두 단계로 수렴 — 다만 알고리즘 루프 내부의 *어느 줄*이 원인인지는 read가 필요해 L0는 아니다.
- **S2 (Constraint-Reasoning)**: 고칠 함수는 자명하나, 픽스는 "어느 행까지 처리할지"의 불변식을 다시 추론해야 나온다. 기존 `rows = min(m,n)` 캡이 *왜* 틀렸는지(아래) 이해하고, "pivot이 더 들어갈 열이 남아있는 한 모든 행을 본다"는 올바른 종료조건을 합성해야 한다. 상수 추가/None가드류 기계적 픽스(S1)가 아니다.
- **K-Domain**: Cohen 알고리즘 2.4.5(HNF) 도메인 지식이 병목이다. pivot column invariant `k`, 행이 0이면 같은 pivot 열을 다음 행에 재시도(`b==0 → k+=1`)하는 등 HNF 내부 의미를 알아야 올바른 종료조건을 쓸 수 있다.
- **primary = T-ConstraintReason**: 위치는 거의 주어졌고(L1), 난점은 루프 경계 불변식을 *추론으로* 바로잡는 데 있다. 이게 dominant.

## 난이도 티어
**T3 (중간).** 구조적 피처: 파일 1개·함수 1개·실질 +5/-3줄로 scope는 작다(=쉬움 쪽). has-repro로 재현이 명확하다(강한 easiness 신호). 그러나 픽스가 single-line 가드가 아니라 루프 range와 종료조건의 동시 재설계(S2)이고, HNF 알고리즘 불변식(K-Domain)을 정확히 따져야 해서 T1/T2를 넘는다. P2P가 smith-normal 2개뿐이라 regression-trap은 약하지만, 같은 파일이 Smith normal form과 공유되므로 루프를 잘못 풀면 인접 동작을 깰 여지는 있다. 공식 라벨 "15분-1시간"과 정합 — localize는 쉽고 추론이 본질인 전형적 중간 난이도.

## 골드패치 분석
- **파일/함수**: `sympy/polys/matrices/normalforms.py`의 `_hermite_normal_form(A)`.
- **근본원인**: 알고리즘이 "한 번에 한 행씩, 맨 아래 행부터 위로" 처리하면서 처리할 행 수를 `rows = min(m, n)`으로 캡했다. m > n일 때 이는 *아래쪽* `n`개 행만 보고 위쪽 `m-n`개 행을 통째로 건너뛴다. pivot이 상단 행에 있는 경우(`[[1,12],[0,8],[0,5]]`), 그 상단 행이 루프 범위 밖이라 처리되지 못해 결과 열이 잘려나가고, 멀쩡한 행이 "rank-deficient"로 오인되어 사라진다.
- **수정요지**: `rows = min(m,n)` 캡과 `range(m-1, m-1-rows, -1)`를 제거하고 **모든 행을 순회**하도록 `range(m-1, -1, -1)`로 바꾼다. 대신 pivot 열 인덱스 `k`가 0에 도달하면(이미 `n`개의 pivot을 다 채운 경우) `break`로 조기 종료한다. 즉 종료 조건을 "행 개수 캡"에서 "pivot 열 소진(`k==0`)"으로 옮긴다 — 이것이 m>n에서도 상단 행을 누락하지 않으면서 최대 pivot 수 `min(m,n)`을 그대로 보장하는 올바른 불변식이다.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_hermite_normal`: 두 테스트 파일에서 기존 기대값이 *틀려있었음*을 드러낸다. `Matrix([[2,7],[0,0],[0,0]])`의 HNF가 기존 `Matrix(3,0,[])`(빈 행렬)에서 `Matrix([[1],[0],[0]])`로 정정된다 — 상단 행의 pivot이 살아남는다. 또 신규 `test_issue_23410`이 이슈 재현(`[[1,12],[0,8],[0,5]] → [[1,0],[0,8],[0,5]]`)을 직접 검증한다.
- **픽스 증명**: 상단 pivot 행을 루프에 포함시키므로 그 행이 더 이상 잘리지 않고, `k==0` break가 과잉 처리를 막아 열 개수가 `min(m,n)`으로 정확히 유지됨을 두 케이스(정사각 아닌 m>n)가 함께 보인다.
- **overfit/regression 관점**: FAIL_TO_PASS가 1개지만 special-case 분기가 아니라 루프 경계 자체를 고쳤기에 입력 일반화가 자연스럽다(overfit-risk 낮음). regression은 PASS_TO_PASS의 smith-normal 2개로만 커버되어 얇으나, 변경이 HNF 종료조건에 국한되고 pivot 상한 `min(m,n)`을 보존하므로 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `hermite_normal_form`을 명시 → grep으로 `normalforms.py`의 공개 래퍼 → `_hermite_normal_form` 코어 진입. hints의 "pivot이 어느 행에 있느냐에 결과가 달라진다"는 단서가 곧장 "행 순회 범위가 행 위치에 의존한다"를 가리키므로, 루프 `for i in range(m-1, m-1-rows, -1)`와 `rows = min(m,n)`를 의심 1순위로 좁힌다.
2. **픽스와 일반화**: 캡의 의도는 "pivot은 최대 min(m,n)개"였지만, 행 개수로 캡하면 *어느* 행을 보는지가 위치 종속이 되는 게 버그다. 올바른 불변식은 "pivot 열이 남아있으면(`k>0`) 모든 행을 본다". 따라서 전 행 순회 + `k==0 break`로 바꾸면, pivot 상한은 그대로 보존되면서 상단/하단 어디에 pivot이 있어도 동일하게 동작한다 — 이게 special-case가 아닌 구조적 일반화다.
3. **regression 안전**: 같은 모듈의 Smith normal form 경로(`test_smith_normal*`)는 별도 함수라 종료조건 변경의 영향권 밖. m≤n인 기존 통과 케이스는 새 루프에서 `k`가 0에 닿지 않거나 마지막에 닿아 동작이 동일하게 유지됨을 확인해야 한다.
4. **함정 회피**: 오라클 없는 에이전트는 (a) 기존 테스트의 `Matrix(3,0,[])` 기대값을 "정답"으로 믿고 거꾸로 코드를 끼워맞추는 inverted-fix, (b) 상단 행만 따로 처리하는 special-case 분기 추가(overfit), (c) `rows`만 `m`으로 키우고 break를 안 넣어 `k`가 음수가 되며 index 오류/과잉 pivot을 내는 실수에 빠지기 쉽다. 정답은 *행 캡을 열 캡으로 치환*하는 것임을 알고리즘 불변식에서 도출해야 회피된다.
