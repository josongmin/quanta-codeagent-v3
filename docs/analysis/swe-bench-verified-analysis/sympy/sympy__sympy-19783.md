---
instance_id: sympy__sympy-19783
repo: sympy/sympy
base_commit: 586a43201d0357e92e8c93548d69a9f42bf548f4
version: "1.7"
difficulty: "15 min - 1 hour"
created_at: 2020-07-16T09:40:38Z
fail_to_pass: 2
pass_to_pass: 9
gold_files: [sympy/physics/quantum/dagger.py, sympy/physics/quantum/operator.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

## 문제 요약
양자물리 모듈에서 `Operator('A') * IdentityOperator()`는 올바르게 `A`로 단순화되지만, `Dagger(A) * IdentityOperator()`는 `A^\dagger I`로 남아 단순화되지 않는다. 즉 항등 연산자와의 곱이 Hermitian conjugate(Dagger) 객체에 대해 한쪽 방향(`Dagger * I`)도, 반대 방향(`I * Dagger`)도 흡수되지 않는다. 이슈 본문에 재현 코드가 그대로 제공된다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 픽스가 두 파일에서 **조율되어** 일어나야 한다. `I * Dagger`는 `IdentityOperator.__mul__`(operator.py)에서, `Dagger * I`는 `Dagger.__mul__`(dagger.py 신규)에서 처리해야 양방향이 모두 흡수된다. 한쪽만 고치면 다른 방향이 깨진 채로 남는다.
- **S = S2 (+S6)**: 고칠 지점 자체는 명확하나, "항등원 흡수"라는 불변식을 어느 `__mul__`에서 어떤 타입 가드로 표현해야 하는지를 추론해 합성해야 한다(S2). 또한 `Dagger`에 존재하지 않던 `__mul__` 메서드를 **새로 도입**하는 소규모 구조 변경이라 S6 보조.
- **K = K-Domain**: `IdentityOperator`/`Operator`/`Dagger`의 sympy.physics.quantum 내부 클래스 계약과 `Mul` fallback 관례를 알아야 한다. 일반 파이썬 추론만으로는 "어디서 흡수가 일어나야 하는지"를 못 짚는다.
- **primary = T-DomainBound**: 병목이 도메인 클래스 상호작용 지식(누가 누구를 흡수하는지)에 있고, 그 지식 위에 다중 지점 조율(L3)이 얹힌다. 그래서 G&V로 때려맞히기보다 quantum 객체 대수 계약을 이해해야 풀린다.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일수 2 / 헌크 2 / 순증 ~15줄 — 소규모지만 **단일 지점이 아니다**.
- localize 직접성: 이슈가 `Dagger`, `IdentityOperator`를 직접 지목해 후보 파일은 명확(grep 쉬움)하나, **두 곳을 함께** 손봐야 한다는 점이 비자명(L3).
- has-repro: 재현 코드 존재 → easiness 신호.
- P2P trap: `test_identity`, `test_operator`, `test_operator_dagger` 등 인접 항등/연산자 동작 9개를 안 깨야 함(regression-trap).
- 공식 라벨 "15분-1시간"과 일치. 다만 시간라벨은 양방향 조율(한쪽만 고치면 절반 통과)이라는 함정을 못 잡으므로, 구조축으로 보면 T3가 아니라 T4가 맞다.

## 골드패치 분석
- **`sympy/physics/quantum/dagger.py`**: `Mul`을 import하고, `Dagger` 클래스에 신규 `__mul__` 추가 — `other`가 `IdentityOperator`면 `self`(=Dagger 자신) 반환, 아니면 `Mul(self, other)` fallback. (불필요해진 `from __future__ import` 정리도 포함.)
- **`sympy/physics/quantum/operator.py`**: `IdentityOperator.__mul__`의 흡수 가드를 `isinstance(other, Operator)`에서 `isinstance(other, (Operator, Dagger))`로 확장 → `I * Dagger(O)`가 `Dagger(O)`로 흡수.
- **근본원인**: 항등원 흡수 로직이 `Operator` 타입만 인지했고, `Dagger`는 (a) 자기 `__mul__`이 없어 일반 `Mul`로 떨어졌으며 (b) `IdentityOperator` 쪽 가드 대상에도 빠져 있었다. 그래서 `Dagger`가 곱셈에서 항등원을 양방향 모두 흡수하지 못했다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_dagger_mul`, `test_identity`**.
  - `test_dagger_mul`(신규): `Dagger(O)*O`, `Dagger(O)*O*I == Mul(Dagger(O), O)*I`, `Dagger(O)*Dagger(O) == Dagger(O)**2`, `Dagger(O)*Dagger(I) == Dagger(O)`를 검사 → 새 `Dagger.__mul__`이 `IdentityOperator`만 흡수하고 나머지는 `Mul` fallback으로 정상 동작함을 증명.
  - `test_identity`(기존 확장): `I * Dagger(O) == Dagger(O)`와 `Dagger(O) * I == Dagger(O)` 양방향을 추가 → operator.py와 dagger.py 두 변경이 **모두** 있어야 통과(한쪽만이면 한 줄이 실패).
- **overfit 관점**: 테스트가 흡수/비흡수 양쪽 케이스(`Dagger*Operator`는 `Mul`로 남음, `Dagger*Dagger`는 `**2`)를 함께 검사하므로 "무조건 self 반환" 같은 special-case 통과를 막는다. overfit 위험 낮음.
- **regression 관점**: PASS_TO_PASS의 `test_operator`, `test_operator_dagger`, `test_outer_product` 등이 기존 `Operator`/`Dagger` 곱셈·adjoint 동작을 고정. `Dagger.__mul__` 추가가 `Mul` fallback을 유지하므로 기존 대수 동작 보존.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `Dagger`, `IdentityOperator`를 명시 → `dagger.py`의 `Dagger` 클래스와 `operator.py`의 `IdentityOperator.__mul__`을 연다. `Operator * I`는 되는데 `Dagger * I`는 안 된다는 비대칭에서 "흡수 로직이 `Operator` 타입만 본다"는 가설로 좁힌다.
2. **픽스와 일반화**: 흡수는 곱셈의 **양방향** 문제임을 인지 — `I * X`는 `IdentityOperator.__mul__`, `X * I`는 `X.__mul__`이 책임진다. 그래서 (a) `IdentityOperator.__mul__` 가드에 `Dagger`를 추가하고 (b) `Dagger`에 `__mul__`을 신설해 `IdentityOperator`를 흡수하되 그 외엔 `Mul(self, other)`로 위임한다. fallback을 남기는 것이 "항등원만 흡수"라는 정확한 일반화이며, 다른 곱을 임의로 단순화하지 않는다.
3. **regression 안전**: `Mul` fallback 덕에 `Dagger*Operator`, `Dagger*Dagger`(→`**2`), outer product 등 기존 경로가 그대로 동작 → `test_operator`/`test_operator_dagger`/`test_outer_product` 불변. `IdentityOperator` 가드 확장도 `Operator` 케이스는 건드리지 않아 `test_identity`의 기존 단언 유지.
4. **함정 회피**: (i) **한쪽만 고치는 실수** — `IdentityOperator.__mul__`만 확장하면 `Dagger * I`(우측 곱)는 여전히 안 되고, `Dagger.__mul__`만 추가하면 `I * Dagger`(좌측 곱)가 안 된다. 양방향 모두 필요. (ii) `Dagger.__mul__`에서 fallback `Mul(self, other)`를 빠뜨려 모든 곱을 self로 흡수해버리는 과단순화. (iii) `Mul` import 누락으로 인한 NameError.
