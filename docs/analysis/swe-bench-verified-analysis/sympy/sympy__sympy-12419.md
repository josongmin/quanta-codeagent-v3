---
instance_id: sympy__sympy-12419
repo: sympy/sympy
base_commit: 479939f8c65c8c2908bbedc959549a257a7c0b0b
version: "1.0"
difficulty: "15 min - 1 hour"
created_at: 2017-03-25T15:02:26Z
fail_to_pass: 1
pass_to_pass: 25
gold_files: [sympy/matrices/expressions/matexpr.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`Identity(n)` 행렬의 모든 원소를 이중 `Sum`으로 더하면 `n`이 기대되는데 `0`이 나온다. 원인은 `Identity._entry(i, j)`가 심볼릭 인덱스 `i != j`일 때 무조건 `S.Zero`를 반환해, "아직 `i == j` 여부를 모른다"는 케이스를 off-diagonal로 단정해버리기 때문이다. 대각합 `Sum(e[i,i], ...)`는 `n`으로 맞지만, 일반 `e[i,j]`는 0으로 붕괴된다. 이슈 본문에 완전한 재현 코드가 있다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 코멘트(smichr)가 culprit을 `Identity`의 `_entry` 메서드로 직접 지목하고, 트레이스 경로(`e[1,2]`)까지 적어준다. grep `_entry` 한 방.
- **S2 (Constraint-Reasoning)**: 위치는 자명하나 올바른 픽스는 "심볼릭 동등성의 3-값 논리"를 추론해야 한다. `i == j`(파이썬 structural eq)를 `Eq(i, j)`(심볼릭)로 바꾸고, 결정 가능할 때만 `S.One`/`S.Zero`, 미결정이면 `KroneckerDelta(i, j)`로 보류해야 한다. 단순 상수 교체(S1)가 아니라 불변식 합성이다.
- **K-Domain**: SymPy의 `S.true`/`S.false` 싱글톤, `Eq`의 fuzzy 평가, `KroneckerDelta`의 `Sum` denest 동작을 알아야 한다. 일반 파이썬 지식으론 `if i == j`가 왜 틀린지 못 짚는다.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 핵심 난점이 "올바른 조건식 합성"(S2)에 있으므로.

APR 관점: 이슈가 `KroneckerDelta` 후보까지 제시하지만, 그 자체를 베끼면 PASS_TO_PASS 회귀를 부른다(아래). 결정 가능 케이스를 먼저 처리하고 미결정만 KroneckerDelta로 보류하는 SemFix/Angelix식 조건 합성이 정답이라 S2.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개(`matexpr.py`), 골드 헌크는 작음(`_entry` 4줄 변경 + import 2줄).
- localize 직접성 매우 높음(L0, 이슈가 함수 지목) → T4 이상으로 안 밀림.
- `has-repro` 존재(강한 easiness 신호).
- 그러나 픽스가 자명한 상수 교체가 아니라 3-값 동등성 추론(S2)이라 T2를 넘김. 순진한 `return KroneckerDelta(i, j)`는 `i == j`가 결정 가능한 인덱싱 테스트(`test_indexing`/`test_single_indexing`)에서 `1`/`0` 대신 미평가 델타를 반환해 회귀를 일으킬 수 있음 → regression-trap.
공식 라벨 "15분-1시간"과 일치(T3). 라벨이 시간 기준이라 회귀 함정은 안 잡지만, 여기선 L0 + 좁은 회귀라 T3로 수렴.

## 골드패치 분석
- **파일/함수**: `sympy/matrices/expressions/matexpr.py`의 `Identity._entry(self, i, j)`. 부수적으로 import를 모듈 상단으로 호이스트(`Eq`, `KroneckerDelta`)하고, `_eval_derivative` 안의 지연 `from sympy import KroneckerDelta`를 제거.
- **근본원인**: 기존 `if i == j: return S.One else: return S.Zero`. 파이썬 `==`는 두 심볼릭 객체의 structural 동등성만 본다. `i`, `j`가 서로 다른 자유 심볼이면 `i == j`는 `False`가 되어 무조건 off-diagonal로 단정 → 모든 비대각 위치가 0으로 평가 → 이중 Sum이 0.
- **수정요지**:
```python
eq = Eq(i, j)
if eq is S.true:
    return S.One
elif eq is S.false:
    return S.Zero
return KroneckerDelta(i, j)
```
`Eq(i, j)`는 심볼릭 동등성으로 평가되어, 결정 가능하면 `S.true`/`S.false` 싱글톤을, 미결정이면 미평가 `Eq`를 준다. `is S.true`/`is S.false`로 결정 케이스만 즉시 0/1로 접고, 미결정은 `KroneckerDelta(i, j)`로 보류 → `Sum`이 KroneckerDelta를 denest/평가해 `n`을 도출.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_Identity`** (1개). 추가 단언:
  - `In[i, j] != 0` — 심볼릭 인덱스에서 0으로 붕괴하지 않음(미평가 델타).
  - `Sum(In[i, j], (i,0,n-1), (j,0,n-1)).subs(n,3).doit() == 3` — flat 이중 범위.
  - `Sum(Sum(In[i, j], (i,0,n-1)), (j,0,n-1)).subs(n,3).doit() == 3` — 중첩 형태.
- **픽스 증명**: `_entry`가 KroneckerDelta를 돌려주므로 Sum이 대각 기여만 누적 → `n=3`에서 3. 이전 코드는 0을 반환해 합이 0이었다.
- **overfit/regression 관점**: 테스트가 `n=3` 구체값으로만 검증하므로 단독으론 얇다(`overfit-risk` 잠재). 다만 골드의 결정-케이스 분기(`is S.true`/`is S.false`) 덕에 PASS_TO_PASS의 `test_indexing`/`test_single_indexing`/`test_identity_powers`(구체 인덱스로 0/1 기대)가 깨지지 않는다 — `KroneckerDelta`만 반환하는 순진 픽스였다면 여기서 회귀했을 것. 25개 P2P 통과가 일반화 검증 역할.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 재현에서 "대각합은 `n`인데 전체합은 0" → 비대각 평가가 의심. 이슈/코멘트가 명시한 트레이스(`e[1,2]`)를 따라가면 `Identity._entry`의 `if i == j` 분기. `matexpr.py`에서 `class Identity` → `_entry` 직행.
2. **픽스**: structural `==`를 심볼릭 `Eq(i, j)`로 교체. 결정 가능(`is S.true`/`is S.false`)이면 즉시 `S.One`/`S.Zero`, 미결정이면 `KroneckerDelta(i, j)`로 보류. 이게 올바른 일반화인 이유 — "두 인덱스가 같은지 아직 모른다"는 fuzzy 상태를 0으로 단정하지 않고 보존하므로, 구체값 substitution 후 Sum이 올바르게 평가된다. KroneckerDelta는 Sum denest를 지원해 Piecewise보다 깔끔히 `n`으로 수렴.
3. **regression 안전**: `test_indexing`/`test_single_indexing`/`test_identity_powers`는 구체 정수 인덱스로 0/1을 기대한다. 결정-케이스 분기를 먼저 두어 이들은 그대로 `S.One`/`S.Zero`를 받는다 — 이 가드 없이 무조건 KroneckerDelta면 회귀. import 호이스트는 동작 불변(순수 정리).
4. **함정 회피**: (a) 코멘트의 `Piecewise((1, eq), (0, True))` 변형은 이슈 스레드가 보였듯 중첩 Sum이 denest 안 돼 0/미수렴 → KroneckerDelta가 우월. (b) `eq == True` 대신 반드시 `eq is S.true` — SymPy 객체의 `==`는 또 다른 함정(심볼릭 비교 반환). (c) 결정-케이스 분기 생략 시 인접 인덱싱 테스트 회귀. 오라클 없는 에이전트는 이슈가 던진 KroneckerDelta를 그대로 무조건 반환하기 쉽고, 거기서 P2P가 깨진다.
