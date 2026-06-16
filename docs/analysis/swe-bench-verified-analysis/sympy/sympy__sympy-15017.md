---
instance_id: sympy__sympy-15017
repo: sympy/sympy
base_commit: 6810dee426943c1a2fe85b5002dd0d4cf2246a05
version: "1.2"
difficulty: "<15 min fix"
created_at: 2018-08-03T03:15:04Z
fail_to_pass: 1
pass_to_pass: 14
gold_files: [sympy/tensor/array/dense_ndim_array.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

rank-0 배열(스칼라, 예: `sympy.Array(3)`)에 대해 `len()`이 항상 0을 반환한다. 이슈는 올바른 값이 1이어야 한다고 명시한다 — 이터레이터가 산출하는 원소 개수(`len(list(a)) == 1`)이며 numpy의 `numpy.asarray(1).size == 1`과 일치하는 동작이다. 즉 rank-0 배열은 "원소 1개를 담은 0차원 컨테이너"로 취급되어야 한다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 `NDimArray.__len__`을 심볼 단위로 직접 지목한다. `__len__`은 `self._loop_size`를 그대로 반환하므로, 실제 결함 지점은 `_loop_size`를 계산하는 `DenseNDimArray._new`의 한 줄로 grep 한 방에 수렴한다.
- **S1 (Direct-Map) + S2 보조**: 픽스는 사실상 기계적이다 — `functools.reduce(lambda x,y: x*y, shape) if shape else 0`을 `functools.reduce(..., shape, 1)`로 바꾸는 것. 다만 "왜 0이 아니라 1인가"는 빈 곱(empty product)=1 이라는 불변식 추론(S2)을 요구한다. 빈 shape의 원소 수는 0이 아니라 1이라는 점이 핵심.
- **K-Domain**: sympy 텐서 배열의 rank/shape/`_loop_size` 의미론(rank-0 = 스칼라 = 원소 1개)을 알아야 numpy 정합성 판단이 가능하다. 순수 일반 파이썬 추론만으로는 "1이 맞다"의 정당성을 세우기 어렵다.
- **primary = T-DirectMap**: 위치가 명확하고 픽스가 reduce의 initializer 인자 추가라는 정형 패턴(경계/기본값 교정)에 매칭된다.

APR 관점: 결함 클래스가 "축약(reduce) 항등원 오지정"이라 template 기반(PAR/TBar류) 수리로 잡히는 전형이다. 후보 탐색·테스트 반복(G&V)이 필요 없고, 올바른 상수(빈 곱=1)를 한 번 추론하면 끝난다.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처: 단일 파일(`dense_ndim_array.py`) 1줄 수정, has-repro(이슈에 실행 가능한 재현 + 기대값 명시), localize 직접성 최상(L0). 공식 라벨 `<15 min fix`와 일치한다 — T1이 아닌 이유는 픽스가 순수 자명(None가드 추가 등)이 아니라 "빈 곱=1" 불변식과 numpy 정합성이라는 도메인 추론을 한 단계 끼고, 동시에 14개 P2P(arithmetic/iterator/slices 등 인접 배열 동작)를 깨지 않아야 하는 regression-trap이 있기 때문. rank-0 분기를 잘못 건드리면 `__getitem__`(`if index >= self._loop_size`)나 reshape 경로가 회귀할 수 있다.

## 골드패치 분석

- **파일·함수**: `sympy/tensor/array/dense_ndim_array.py`의 `DenseNDimArray._new` (classmethod).
- **근본원인**: `self._loop_size = functools.reduce(lambda x,y: x*y, shape) if shape else 0`. rank-0 배열은 `shape == ()`(빈 튜플)이라 `if shape` 분기가 False → `_loop_size`가 0으로 강제 세팅. `__len__`이 `_loop_size`를 반환하므로 `len`이 0이 된다. 빈 shape의 원소 수는 "곱이 정의 안 됨→0"이 아니라 "빈 곱=1"이어야 한다.
- **수정요지**: 삼항식을 제거하고 `functools.reduce`에 initializer `1`을 넘긴다(`reduce(..., shape, 1)`). 비어 있으면 1을, 비어 있지 않으면 기존과 동일하게 shape 원소들의 곱을 반환 — rank≥1 동작은 byte 수준으로 보존된다.

## 검증 (test_patch)

FAIL_TO_PASS = `test_ndim_array_initiation` 1개. 추가/변경된 단언:
- 신규 `ImmutableDenseNDimArray([], shape=(0,))`: `len == 0`, `rank() == 1` — shape에 실제 0 차원이 있으면 곱이 0이라는 정상 케이스를 함께 고정(빈 shape `()`와 `(0,)`의 구별 확인).
- `rank_zero_array = ImmutableDenseNDimArray(x)`: 기대값을 `len == 0`에서 **`len == 1`**로 뒤집고, 과거 `raises(ValueError, lambda: rank_zero_array[0])`를 `rank_zero_array[0] == x`로 교체. 즉 rank-0 배열이 인덱스 0에서 자기 스칼라를 내놓도록 동작 자체가 변경됨.
- 픽스 증명: `_loop_size`가 1이 되면서 `__len__`==1, 그리고 `__getitem__`의 `index >= self._loop_size`(0 >= 1 False) 가드가 통과해 `[0]`이 값을 반환한다 — 한 줄 수정이 len과 getitem 두 동작을 동시에 정합화.
- overfit/regression: FAIL_TO_PASS가 1개로 얇아 보이나, 같은 테스트 안에서 빈-shape(`()`)·0-차원(`(0,)`)·rank≥1을 함께 단언해 special-case 통과를 차단. 14개 P2P가 인접 배열 연산 전반을 커버해 regression 안전망 역할.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 `NDimArray.__len__`을 직접 지목 → `__len__`이 `return self._loop_size`임을 확인 → `_loop_size`가 어디서 세팅되는지 역추적하면 `DenseNDimArray._new`(그리고 sparse 대응)의 reduce 한 줄로 수렴. L0이라 탐색 비용 거의 0.
2. **픽스와 일반화**: `reduce(..., shape)` + `if shape else 0` 대신 `reduce(..., shape, 1)`. 이게 올바른 일반화인 이유 — "빈 곱은 1"이라는 수학적 항등원이고, numpy(`asarray(1).size==1`) 및 `len(list(a))==1`과 정합. `else 0`은 특수치 하드코딩이라 의미상 오류였다. initializer 추가는 rank≥1 결과를 바꾸지 않으므로 부수효과 없음.
3. **regression 안전**: `(0,)`처럼 실제 0 길이 차원은 여전히 `len==0`(0이 곱에 포함됨)을 유지해야 한다 — 그래서 단순히 0→1 치환이 아니라 reduce 항등원 방식이 정답. P2P(test_iterator/test_slices/test_arithmetic 등)가 rank≥1 경로를 보호한다.
4. **함정 회피**: 오라클 없는 에이전트의 오답 경로 — (a) `__len__`에 `if self._rank == 0: return 1` 같은 special-case 분기를 넣으면 sparse/getitem 경로와 불일치(`_loop_size` 자체가 0인 채라 `[0]` 인덱싱이 여전히 ValueError로 깨짐). 근본은 `_loop_size`를 고쳐야 len과 getitem이 함께 정합화된다. (b) `if shape else 1`로만 바꾸면 `(0,)` 케이스가 reduce로 들어가 0을 내놓아 통과처럼 보이지만, 빈-shape와 0-차원의 구별을 우연히 맞춘 것 — initializer 1 방식이 의미적으로 더 견고. (c) sparse 구현(`SparseNDimArray`)의 대응 지점도 같이 점검해야 표면적 일관성이 유지됨.
