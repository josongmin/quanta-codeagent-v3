---
instance_id: sympy__sympy-12481
repo: sympy/sympy
base_commit: c807dfe7569692cad24f02a08477b70c1679a4dd
version: "1.0"
difficulty: "<15 min fix"
created_at: 2017-04-03T01:52:33Z
fail_to_pass: 1
pass_to_pass: 7
gold_files: [sympy/combinatorics/permutations.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [overfit-risk, has-repro]
---

## 문제 요약
`Permutation([[0,1],[0,1]])`처럼 **비서로소(non-disjoint) 사이클**을 생성자에 넘기면 항등 순열을 구성하지 않고 `ValueError`를 던진다. 이슈는 사이클이 겹치면 그냥 **왼쪽→오른쪽 순서로 합성**해서 결과 순열을 돌려주면 된다고 명시한다("This should be easy to compute"). 즉 사이클 표기에서 원소 중복을 금지할 이유가 없다는 것이 핵심 주장이다.

## 유형 (정형화)
- **L (Localization) = L1** — 이슈가 `Permutation` 생성자와 `ValueError`를 직접 지목한다. `permutations.py`의 `__new__`로 좁히는 데 약간의 탐색만 필요(`has_dups` 분기 1개). 단일 파일·단일 함수.
- **S (Repair Strategy) = S2 (+S5)** — 고칠 지점은 명확하나, "겹친 사이클을 어떻게 처리해야 옳은가"라는 **불변식 추론**이 본질이다. 핵심 통찰은 픽스가 새 합성 로직을 추가하지 않는다는 것: 아래쪽 `Cycle()` 누적 루프(`c = c(*ci)`)가 이미 좌→우 합성을 정확히 수행하므로, **가드만 제거하면** 의도된 동작이 그대로 나온다. 의도된 스펙(겹친 사이클=합성)은 이슈 본문에서 재구성해야 하므로 S5 보조.
- **K (Knowledge) = K-Domain** — 사이클 표기/사이클 합성/`Cycle` 객체 의미론이라는 sympy 조합론 도메인 지식이 "왜 가드 제거가 안전한가"를 판단하는 데 필요하다.
- **primary_type = T-ConstraintReason** — 위치는 쉽게 찾지만, 올바른 픽스는 "중복 검사를 사이클이 아닌 경우로만 좁히면 기존 누적 루프가 합성을 처리한다"는 의미론적 추론에서 나온다. 기계적 가드 추가(T-DirectMap)가 아니라 가드 **축소**가 정답이라는 점이 결정적.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 파일 1개 / 함수 1개(`Permutation.__new__`), gold diff는 실질 −6/+2줄로 매우 작다 → 위쪽으로(T2) 미는 요인.
- 그러나 **localize는 쉬워도 추론이 필요**하다: 단순히 "에러를 빼라"가 아니라 사이클 표기일 때만 중복을 허용하고 배열 표기(`is_cycle=False`)에서는 여전히 금지해야 한다. 이 `and not is_cycle` 조건을 정확히 합성하는 게 핵심.
- has-repro(이슈에 재현 호출 존재)는 easiness 신호지만, P2P trap(`test_Cycle`, `test_Permutation`, `test_mul` 등 인접 동작 다수)과 overfit 위험이 단순 T1/T2로 떨어지는 것을 막는다.
- 공식 라벨은 `<15 min fix`(T1~T2 prior)다. 개발자 기준 구현시간은 짧지만, 에이전트 관점에선 "겹친 사이클이 합성이라는 스펙 + 배열 표기 가드 보존"이라는 2중 제약을 동시에 만족해야 하므로 한 단계 올려 **T3**로 본다.

## 골드패치 분석
- **파일·함수**: `sympy/combinatorics/permutations.py` — `Permutation.__new__`.
- **근본 원인**: `temp = flatten(args)` 직후 `has_dups(temp)`가 True면 `is_cycle` 여부와 무관하게 무조건 `ValueError`를 던졌다. 사이클 표기에서 원소가 겹치는 것은 "비서로소 사이클을 좌→우 합성"이라는 **유효한 의미**인데도 금지하고 있었다.
- **수정 요지**: 중복 검사를 사이클이 아닌 경우로만 한정한다.
  ```python
  if has_dups(temp) and not is_cycle:
      raise ValueError('there were repeated elements.')
  ```
  사이클 표기일 때의 옛 ValueError 가지("to resolve cycles use Cycle...")를 통째로 제거. 이렇게 하면 아래쪽의 기존 누적 루프
  ```python
  c = Cycle()
  for ci in args:
      c = c(*ci)
  aform = c.list()
  ```
  가 겹친 사이클을 좌→우로 합성해 올바른 `aform`을 만든다. **새 합성 로직은 추가되지 않는다** — 가드가 막고 있던 정상 경로가 열릴 뿐이다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_args`(1개)**. 추가된 단언: `Permutation([[0, 1], [0, 2]]) == Permutation(0, 1, 2)` — 겹친 두 transposition을 좌→우 합성하면 3-사이클 `(0 1 2)`가 되는지 확인. 동시에 `raises(ValueError, lambda: Permutation([[1], [1, 2]]))` 한 줄을 **삭제**한다(이 입력은 이제 합법이므로).
- **픽스 증명**: 가드 제거로 `[[0,1],[0,2]]`가 `Cycle()(0,1)(0,2)` 누적 → `(0 1 2)`로 평가됨을 새 단언이 검증. 기존 `Permutation([1, 1, 0])`(배열 표기 중복)은 `is_cycle=False`라 `and not is_cycle`을 통과해 여전히 `ValueError` → 배열 표기 가드가 보존됨을 같은 테스트가 함께 지킨다.
- **overfit 관점**: FAIL_TO_PASS가 `test_args` 단일 함수라 얇다(overfit-risk). 에이전트가 "사이클 분기의 ValueError를 통째로 지워라"로만 풀고 `is_cycle` 조건을 빠뜨리면, 배열 표기 중복(`[1,1,0]`)까지 허용해 데이터 무결성을 깬다 — 그러나 `test_args` 내부에 그 음성 케이스가 남아 있어 CEGIS식 과소명세를 어느 정도 차단한다.
- **regression 관점**: P2P 7개(`test_Permutation`, `test_Cycle`, `test_mul`, `test_ranking`, `test_josephus`, `test_from_sequence`, `test_printing_cyclic`)는 정상 사이클/배열 생성·곱·랭킹 동작이다. 가드를 사이클에 한해 푸는 변경이므로 서로소 사이클·배열 경로의 동작은 불변이라 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 재현 호출 `Permutation([[0,1],[0,1]])`과 메시지 "there were repeated elements; to resolve cycles use Cycle"를 grep → `permutations.py`의 `Permutation.__new__` 내 `has_dups(temp)` 분기로 즉시 수렴(L1).
2. **픽스와 일반화**: 단순히 에러를 지우는 게 아니라, "겹친 사이클 = 좌→우 합성"이라는 스펙을 확인하고 바로 아래 `Cycle()` 누적 루프가 **이미** 그 합성을 수행함을 읽어낸다. 따라서 중복 검사를 `and not is_cycle`로 한정해 **사이클 표기에서만** 가드를 푸는 것이 올바른 일반화다 — 새 코드가 아니라 정상 경로 개방이라는 점이 핵심.
3. **regression 안전**: 배열 표기(`is_cycle=False`)의 중복 금지는 반드시 유지해야 한다(`[1,1,0]`은 0..n-1 무결성 위반). `and not is_cycle` 조건이 이를 보장하고, 서로소 사이클·곱·printing 동작(P2P 7개)은 건드리지 않으므로 회귀 없음.
4. **함정 회피**: (a) ValueError를 무조건 제거해 배열 표기 중복까지 허용하는 over-fix — `is_cycle` 조건 보존으로 회피. (b) "합성 로직을 새로 짜야 한다"는 과잉 구현 — 기존 `Cycle()` 누적 루프 재사용을 놓치면 불필요한 중복 코드 발생. (c) 사이클 표기 ValueError 가지만 남겨두고 합성을 별도 분기로 추가하는 비대칭 수정 — gold처럼 가드 한 줄로 수렴하는 것이 가장 간결하고 안전.
