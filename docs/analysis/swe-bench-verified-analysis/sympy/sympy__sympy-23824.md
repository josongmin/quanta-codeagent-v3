---
instance_id: sympy__sympy-23824
repo: sympy/sympy
base_commit: 39de9a2698ad4bb90681c0fdb70b30a78233145f
version: "1.12"
difficulty: "15 min - 1 hour"
created_at: 2022-07-23T22:13:36Z
fail_to_pass: 1
pass_to_pass: 2
gold_files: [sympy/physics/hep/gamma_matrices.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약

`sympy.physics.hep.gamma_matrices.kahane_simplify()`가 contraction이 있는 감마행렬 곱($\gamma^\mu\gamma_\mu = 4I$ 등)을 단순화할 때, 앞쪽(leading)에 붙은 contraction 없는 감마행렬들의 순서를 거꾸로 뒤집어 버린다. 예: $\gamma^\rho\gamma^\sigma\gamma^\mu\gamma_\mu$는 $4\gamma^\rho\gamma^\sigma$가 되어야 하는데 $4\gamma^\sigma\gamma^\rho$로 나온다. 함수 시작 시 떼어낸 leading 행렬들을 끝에서 다시 product 앞에 끼워넣는 삽입 루프가 역순으로 동작하는 것이 원인이다. 이슈 제출자가 원인과 재현코드를 모두 제공했다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 함수명 `kahane_simplify()`와 "the insertion loop is just backward"까지 직접 지목. grep 한 방으로 `for i in range(0, first_dum_pos)` 루프 도달. 탐색 노력 0.
- **S2 (Constraint-Reasoning)**: 위치는 자명하나, 올바른 픽스는 "삽입 순서를 어떻게 뒤집어야 원래 순서가 복원되는가"라는 불변식 추론을 요구한다. `resulting_indices` 각 항 `ri` 앞에 `free_pos[0..first_dum_pos]`를 **원래 순서대로** 다시 붙여야 한다는 점을 이해해야 함. 단순 가드/상수 변경(S1)이 아니라 시퀀스 정합성 추론.
- **K-Domain**: Kahane 알고리즘(gamma matrix contraction 식별)의 자료구조 의미(`resulting_indices`가 인덱스 리스트들의 리스트, `free_pos`가 free index 위치 배열)를 알아야 무엇이 "정순서"인지 판단 가능. 단, 도메인 깊이는 얕음 — 리스트 순서 문제로 환원됨.
- **primary = T-ConstraintReason**: 위치는 L0로 확정이고 진짜 작업은 "올바른 순서로 다시 합성"하는 S2 추론. APR 관점에서 PAR/TBar식 결함 템플릿(None가드/경계)에 매칭되지 않고, 시퀀스 불변식을 사람이 따져서 식을 합성하는 SemFix 계열이라 S2가 dominant.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처: 파일 1개, 헌크 1개, 실질 변경 2줄(루프 2줄 → comprehension 1줄). localize 직접성은 최상(L0, has-repro). 도메인 지식은 필요하나 "리스트 순서 뒤집힘"으로 얕게 환원됨. P2P trap 약함(인접 테스트 2개뿐). overfit 위험 낮음 — 픽스가 순서 보존이라는 일반 불변식이고 special-case가 아님. 공식 라벨은 "15min-1hour"로 T3 근방을 시사하나, 이는 개발자가 Kahane 알고리즘 맥락을 처음 파악하는 시간 비용이지 에이전트가 이슈의 직접 포인터를 받은 상황의 난이도가 아니다. 이슈가 원인·재현·픽스 방향까지 적어주므로 T2로 하향 조정.

## 골드패치 분석

- **파일·함수**: `sympy/physics/hep/gamma_matrices.py`의 `kahane_simplify()` (~694라인).
- **근본원인**: 함수 앞부분에서 leading free 감마행렬들을 떼어내고, 끝에서 다시 붙일 때 다음 루프 사용:
  ```python
  for i in range(0, first_dum_pos):
      [ri.insert(0, free_pos[i]) for ri in resulting_indices]
  ```
  `list.insert(0, x)`를 `i=0,1,...` 순서로 반복하면 나중 원소가 더 앞에 와서 `free_pos[0:first_dum_pos]`가 **역순**으로 prepend된다. 그래서 leading 행렬 순서가 뒤집힘.
- **수정요지**: 삽입 루프를 순서 보존 concatenation으로 교체:
  ```python
  resulting_indices = list( free_pos[0:first_dum_pos] + ri for ri in resulting_indices )
  ```
  각 결과 항 `ri` 앞에 `free_pos[0:first_dum_pos]` 슬라이스를 **정순서 그대로** 이어붙여, leading 행렬의 원래 좌→우 순서를 복원한다.

## 검증 (test_patch)

`test_gamma_matrices.py::test_kahane_simplify1`에 케이스 추가:
- `G(mu)*G(-mu)*G(rho)*G(sigma)` → `4*G(rho)*G(sigma)` (contraction이 trailing, leading 영향 없음 — 기존도 통과 가능한 control).
- `G(rho)*G(sigma)*G(mu)*G(-mu)` → `4*G(rho)*G(sigma)` (leading $\rho,\sigma$ 두 개 — **버그를 직접 노출**: 픽스 전엔 $4\gamma^\sigma\gamma^\rho$가 나옴).
두 번째 케이스가 핵심 fail→pass 신호다. `r.equals(...)`로 텐서 동등성을 검사하므로 순서 뒤집힘이 곧 assertion 실패.

- **overfit 관점**: 위험 낮음. 픽스는 "어떤 길이의 leading 시퀀스든 순서 보존"이라는 일반 변환이라, 테스트가 2개 leading 케이스만 검사해도 special-case 통과가 불가능. `free_pos[0:first_dum_pos] + ri`는 `first_dum_pos`에 무관하게 정합.
- **regression 관점**: P2P `test_kahane_algorithm`, `test_gamma_matrix_class`가 contraction이 leading에 없는/복합 케이스를 커버. concatenation은 `first_dum_pos==0`이면 빈 슬라이스(no-op)라 기존 동작 보존. 좁은 P2P이지만 변경이 국소적이라 trap 약함.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `kahane_simplify()`와 "insertion loop is just backward"를 명시 → 파일 grep으로 `for i in range(0, first_dum_pos): [ri.insert(0, free_pos[i]) ...]` 즉시 도달. 재현코드($\gamma^\rho\gamma^\sigma\gamma^\mu\gamma_\mu$)가 leading 케이스를 가리켜 정확히 이 루프를 확증.
2. **픽스와 일반화 근거**: `insert(0, ...)` 누적 반복이 역순을 낳는다는 점을 파악하고, leading 슬라이스를 정순서로 prepend하는 `free_pos[0:first_dum_pos] + ri`로 교체. 이는 "leading 행렬은 순서를 보존해야 한다"는 도메인 불변식의 직접 표현이라 길이·내용 무관하게 올바른 일반화(overfit 아님).
3. **regression 안전**: `first_dum_pos==0`(leading free 행렬 없음)일 때 슬라이스가 비어 `[] + ri == ri`로 기존과 byte-동일. contraction이 trailing인 케이스(추가된 첫 테스트)도 그대로 통과. `test_kahane_algorithm`의 복합 케이스 불변.
4. **함정 회피**: (a) `insert(0)`를 단순히 `append`로 바꾸거나 `reversed(range(...))`만 적용하면 일부 케이스만 맞고 다른 순서가 깨지는 부분픽스 위험 — 슬라이스 concatenation이 가장 명확. (b) `resulting_indices`가 리스트들의 리스트임을 놓치고 단일 리스트로 취급하면 깨짐. (c) trailing-contraction control 케이스만 보고 "이미 통과"라 오판하지 말고 leading 케이스로 버그를 재현해 검증해야 함.
