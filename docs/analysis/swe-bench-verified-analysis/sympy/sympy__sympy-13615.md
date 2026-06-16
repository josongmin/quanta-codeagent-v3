---
instance_id: sympy__sympy-13615
repo: sympy/sympy
base_commit: 50d8a102f0735da8e165a0369bbb994c7d0592a6
version: "1.1"
difficulty: "15 min - 1 hour"
created_at: 2017-11-17T08:59:51Z
fail_to_pass: 1
pass_to_pass: 70
gold_files: [sympy/sets/sets.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, underspecified, has-repro]
---

## 문제 요약
`Complement(FiniteSet(x, y, 2), Interval(-10, 10))`처럼 심볼과 숫자가 섞인 유한집합의 차집합이 `{x, y}`를 반환한다. 기대값은 `{x, y} \ [-10,10]` — 즉 심볼 원소는 인터벌 포함 여부를 정적으로 단정할 수 없으므로 평가되지 않은(unevaluated) Complement로 보존되어야 한다. 현재 코드는 `self.contains(el) != True`라는 2치(true/non-true) 판정으로 "확실히 포함됨"이 아닌 원소를 전부 결과에 남겨버려, 포함 여부가 미결정(undecided)인 심볼까지 "포함 안 됨"으로 잘못 처리한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `Complement`/`FiniteSet`/`Interval`을 직접 언급하므로 `sets.py`의 `_complement`로 수렴하지만, 정확히 `FiniteSet` 분기(`isinstance(other, FiniteSet)`)임을 좁히려면 약간의 dispatch 탐색이 필요. grep 한 방은 아님.
- **S2 (Constraint-Reasoning) +S6 (Design-Refactor)**: 고칠 줄은 한 줄이지만, 올바른 식은 "이진 필터"가 아니라 **3치(ternary) 논리**다. `contains`가 `True/False/미결정(None)`을 낼 수 있다는 불변식을 추론해 세 갈래로 분기하고, 미결정 원소는 unevaluated `Complement`로 합성해야 함 — 단순 조건 교체가 아니라 collect-then-process 구조(sift)로의 소규모 재배치라 S6 보조.
- **K-Domain**: sympy의 fuzzy/3치 멤버십 의미론(`contains`가 심볼에 대해 `True`도 `False`도 아닌 값을 반환)과 `Union`/`Complement(evaluate=False)` 생성 계약을 알아야 픽스가 옳음. 일반 파이썬 추론만으론 부족.
- **primary = T-ConstraintReason**: 위치는 명확하나 난점은 "올바른 조건식(2치→3치)을 추론으로 합성"하는 데 있음. 후보를 마구 시도하는 G&V가 아니라 의미론적 불변식으로 푸는 문제.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개(`sympy/sets/sets.py`), 단일 함수(`_complement`), 헌크 1개 — scope는 작음(easiness 신호).
- 그러나 픽스가 단순 가드/상수 변경(S1)이 아니라 **2치→3치 논리 재구성 + 미결정 원소를 unevaluated 노드로 합성**(S2+S6)이라 추론 부하가 큼.
- `has-repro`: 이슈에 정확한 재현 스니펫 존재 → easiness 가산.
- `regression-trap`: PASS_TO_PASS 70개 중 `test_complement`/`test_difference`/`test_intersect`/`test_finite_basic` 등 집합 연산 전반이 같은 코드경로를 공유 → 모든 원소가 결정적으로 포함/미포함인 기존 케이스를 깨면 안 됨.
- 공식 라벨 "15 min - 1 hour"와 일치(T4 prior). localize는 쉽지만 올바른 일반화 추론이 시간을 먹는 전형.

## 골드패치 분석
- **파일·함수**: `sympy/sets/sets.py`, `Set._complement`의 `elif isinstance(other, FiniteSet)` 분기.
- **근본원인**: 기존 줄 `FiniteSet(*[el for el in other if self.contains(el) != True])`는 2치 가정. `self.contains(el)`가 심볼에 대해 `True`도 `False`도 아닌 미결정 결과를 낼 때, `!= True`가 참이 되어 **미결정 원소가 "포함 안 됨"으로 흡수**된다. 결과적으로 심볼이 차집합 결과에 그냥 남고 인터벌과의 관계가 소실된다.
- **수정요지**: `sympy.utilities.iterables.sift`로 원소를 3분류하는 `ternary_sift(el)` 도입 — `contains in [True, False]`면 그 bool, 아니면 `None`. 그 후
  - `sifted[False]`(확실히 self에 안 들어감) → 그대로 `FiniteSet`,
  - `sifted[None]`(미결정) → `Complement(FiniteSet(*sifted[None]), self, evaluate=False)`로 보존(없으면 `S.EmptySet`),
  - `sifted[True]`(확실히 포함) → 버림,
  을 `Union`으로 합친다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_Complement`에 단언 추가 — `Complement(FiniteSet(x, y, 2), Interval(-10, 10)) == Complement(FiniteSet(x, y), Interval(-10, 10))`. 즉 결정 가능한 숫자 `2`는 제거되고(인터벌 안), 미결정 심볼 `x, y`는 `Complement(FiniteSet(x, y), Interval(...))` 형태로 unevaluated 보존됨을 검증.
- **픽스 증명**: 픽스 후 `2`는 `contains=True`→`sifted[True]`로 버려지고, `x, y`는 미결정→`sifted[None]`→`Complement(..., evaluate=False)`. 따라서 좌변이 우변과 동일.
- **overfit 관점**: FAIL_TO_PASS가 단일 테스트라 얇아 보이지만, 픽스가 입력값이 아닌 **`contains`의 3치 출력 구조**에 일반화되어 있어 special-case 하드코딩이 아님 → overfit 위험 낮음. (`overfit-risk` 미표기.)
- **regression 관점**: 모든 원소가 `True`/`False`로 결정되는 기존 케이스에서 `sifted[None]`이 비어 `S.EmptySet`이 되고 `Union`이 `FiniteSet(*sifted[False])`로 collapse → 기존 동작과 동치. 70개 PASS_TO_PASS(특히 `test_complement`, `test_difference`)가 이 동치성을 방어.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `Complement(a,b)` + "FiniteSet/Interval" 신호 → `sets.py`에서 `_complement` 검색 → `isinstance(other, FiniteSet)` 분기의 `self.contains(el) != True`가 범인임을 확인. 힌트 텍스트("symbols remain when numbers removed", `C.contains(x)` 오류)가 미결정 멤버십 문제임을 직접 시사.
2. **픽스와 일반화 근거**: `!= True`는 `False`와 `미결정`을 한 바구니로 뭉개는 게 버그. 올바른 일반화는 `contains`의 출력을 `True/False/미결정` 3치로 분리하고, 미결정 집합만 `Complement(evaluate=False)`로 보존하는 것. 특정 입력이 아니라 멤버십 결정성에 의존하므로 올바른 일반화.
3. **regression 안전**: 결정 가능 케이스에서 `sifted[None]=[]` → `S.EmptySet` → `Union`이 순수 `FiniteSet`으로 환원되어 기존 `test_complement`/`test_difference`/`test_finite_basic` 불변. `Union`/`Complement` import가 모듈 내 존재함을 확인해 NameError 회피.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `self.contains(el) == False`로만 바꿔 미결정 원소를 통째로 버리거나(심볼 소실), (b) 미결정 원소를 그냥 `FiniteSet`에 남겨 인터벌 관계를 잃을 위험. 핵심은 미결정을 **drop도 keep도 아닌 unevaluated Complement로 보존**하는 것. 또한 `contains`가 sympy `S.true`/fuzzy 값을 낼 수 있으므로 `in [True, False]`로 파이썬 bool만 좁혀 걸러야 함.
