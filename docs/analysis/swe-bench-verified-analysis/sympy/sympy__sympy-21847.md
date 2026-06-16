---
instance_id: sympy__sympy-21847
repo: sympy/sympy
base_commit: d9b18c518d64d0ebe8e35a98c2fb519938b9b151
version: "1.9"
difficulty: "<15 min fix"
created_at: 2021-08-10T17:41:59Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [sympy/polys/monomials.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`itermonomials(variables, max_degrees, min_degrees=...)`에 정수 `min_degrees`를 줄 때, total degree가 같은 항(예: `x1*x2**2`)이 누락되고 단일변수 거듭제곱(`x1**3` 등)만 반환된다. docstring은 `min_degree <= total_degree(monom) <= max_degree`를 만족하는 모든 단항식을 약속하지만, 실제 코드는 total degree가 아닌 **단일 변수의 최대 지수**로 하한을 거른다. 이슈에 재현 스니펫과 기대 출력이 명시돼 있다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 함수 이름 `itermonomials`와 `min_degrees` 인자를 직접 지목. 단일 파일 `monomials.py`로 즉시 수렴하나, 함수 내부에 commutative/non-commutative 두 분기가 있어 정확한 줄 식별에 약간의 탐색이 필요.
- **S2 (Constraint-Reasoning)**: 위치는 명확하지만 픽스의 핵심은 "min_degree와 비교할 올바른 양은 무엇인가"를 추론하는 것. total degree = 모든 변수 지수의 **합**(`sum(powers.values())`)임을 단항식 정의에서 도출해야 한다. 후보를 마구 시도하는 G&V가 아니라 불변식(total_degree 정의)으로 한 줄을 합성하는 의미적 수리.
- **K-Domain**: `total_degree`, monomial, commutative/non-commutative 변수 등 sympy 다항식 도메인 개념을 알아야 `max`가 왜 틀렸고 `sum`이 맞는지 판단 가능.
- **primary = T-ConstraintReason**: localize는 쉬우나(L1) 결함의 본질이 "잘못된 집계 함수(`max`→`sum`)"라는 의미 오류이고, 올바른 식을 도메인 불변식에서 추론해 합성해야 하므로 S2 dominant.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개, 변경 줄 2줄(두 분기에서 동일 치환) — scope는 T1~T2급.
- 그러나 픽스가 자명한 가드/기본값(S1)이 아니라 **집계 의미 추론**(`max`가 부분적으로 동작해 정답처럼 보이는 함정)이라 T1/T2를 넘김.
- `has-repro`(이슈에 재현+기대출력)는 강한 easiness 신호지만, `regression-trap`이 상쇄: `test_monomials`는 거대한 단일 테스트로 `min_degrees=None`/리스트형/단일 정수형/non-comm 등 인접 동작을 모두 검증하므로 픽스가 기존 케이스를 깨면 즉시 실패.
- 공식 라벨 `<15 min fix`는 **개발자 구현시간**(한 줄 치환) 기준. 에이전트 관점에선 `max`가 "거의 맞아 보이는" 의미 함정 + 두 분기 동시 수정 누락 위험 때문에 T2가 아닌 T3가 타당.

## 골드패치 분석
- **파일/함수**: `sympy/polys/monomials.py` 내 `itermonomials`.
- **근본원인**: total_degree 경로의 commutative 분기와 non-commutative 분기 양쪽에서, 단항식의 차수 하한 필터를 `if max(powers.values()) >= min_degree`로 작성. `powers`는 변수별 누적 지수 dict이므로 `max(...)`는 "어떤 한 변수의 최고 지수"를 뜻하고, 이는 total degree가 아니다. 따라서 `x1**3`(한 변수 지수 3 ≥ 3)은 통과하지만 `x1*x2**2`(각 지수 1,2 → max=2 < 3)은 탈락 → docstring 위반.
- **수정요지**: 두 분기 모두 `max(powers.values())` → `sum(powers.values())`로 치환. 합은 total degree와 정확히 일치하므로 `min_degree <= total_degree` 계약을 충족한다. `combinations_with_replacement`/`product`가 길이 `max_degree`로 항을 생성하고 `1`(=`S.One`) 패딩으로 더 낮은 차수를 표현하므로 상한은 이미 보장 — 하한만 올바르게 고치면 된다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_monomials` 단일. 추가된 핵심 단언:
  - comm: `set(itermonomials([x, y], 3, 3)) == {x**3, x**2*y, x*y**2, y**3}` — total degree=3 혼합항 포함 검증.
  - `itermonomials([x, y], 3, 2)` — degree 2와 3 항이 모두 포함되는지(범위 하한) 검증.
  - non-comm: `itermonomials([i, j, k], 2, 2)`, `([i, j, k], 3, 2)` — 비가환 분기에서도 동일 수정이 적용됐는지(혼합 곱 순서까지) 검증.
- **픽스 증명**: 기존 `max` 로직은 `x**2*y`(max=2)를 `min_degree=3`에서 탈락시켜 단언 우변에서 빠지므로 RED. `sum`이면 2+1=3≥3로 포함돼 GREEN.
- **overfit 관점**: 추가 단언이 comm/non-comm 양 분기 + 정확히-같음/범위 두 시나리오를 모두 커버해 special-case 통과가 어렵다. 다만 FAIL_TO_PASS가 단일 함수라 얇음 → `overfit-risk` 자체는 낮으나(테스트가 두꺼움) 한 분기만 고치면 non-comm 단언에서 잡힌다.
- **regression 관점**: P2P 9개(`test_monomial_count/mul/div/...`)는 모두 다른 함수라 직접 영향 없음. 진짜 회귀 위험은 같은 `test_monomials` 안의 기존 `min_degrees=None`/리스트형 단언으로, 두 분기만 정확히 치환하면 안전(다른 코드경로 미접촉).

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `itermonomials` + `min_degrees`를 지목 → `monomials.py`로 직행. `min_degrees`가 정수인 total_degree 경로를 따라가면 `if max(powers.values()) >= min_degree` 두 줄(comm/non-comm)에 도달.
2. **픽스와 일반화**: `powers`가 변수별 지수임을 확인 → total degree의 정의는 지수의 **합**. `max`→`sum`. 이것이 overfit 아닌 올바른 일반화인 이유: docstring 계약(`min_degree <= total_degree`)을 직접 구현하는 것이지 특정 입력을 맞추는 게 아니다. 어떤 변수 개수/차수 조합에도 total degree 의미가 동일하게 성립.
3. **regression 안전**: 상한은 생성 단계(`combinations_with_replacement`/`product`, 길이 max_degree)에서 이미 보장되고 `S.One` 패딩으로 저차항도 포함되므로 하한 필터만 건드린다. `min_degrees=None`이면 `min_degree=0`이라 `sum>=0` 항상 참 → 기존 동작 불변. 리스트형 `min_degrees`는 `total_degree=False`의 별도 경로라 미접촉.
4. **함정 회피**: (a) **두 분기 중 하나만 고치는 실수** — non-comm 분기를 놓치면 `itermonomials([i,j,k],2,2)` 단언에서 실패. 두 군데 동일 치환 필수. (b) **`>` vs `>=` / 상한까지 건드리는 과수정** — 하한 비교만 `sum`으로 바꾸고 연산자/상한은 유지. (c) **`max`가 부분적으로 맞아 보이는 함정** — 단일변수 거듭제곱은 옳게 통과하므로 얕은 테스트만 보면 정답처럼 보임. 혼합항(`x*y**2`)으로 반례를 떠올려야 `sum`이 맞다는 확신을 얻는다.
