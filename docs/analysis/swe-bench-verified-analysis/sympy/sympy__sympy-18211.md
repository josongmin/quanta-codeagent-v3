---
instance_id: sympy__sympy-18211
repo: sympy/sympy
base_commit: b4f1aa3540fe68d078d76e78ba59d022dd6df39f
version: "1.6"
difficulty: "15 min - 1 hour"
created_at: 2020-01-03T06:39:19Z
fail_to_pass: 1
pass_to_pass: 54
gold_files: [sympy/core/relational.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`Eq(n*cos(n) - 3*sin(n), 0).as_set()`처럼 닫힌 형식으로 풀리지 않는 univariate 방정식에 `as_set()`을 호출하면, 내부의 `solve_univariate_inequality`가 `NotImplementedError`를 던지며 그대로 전파되어 호출이 깨진다. 기대 동작은 예외 대신 미해결 조건을 그대로 담은 심볼릭 집합 `ConditionSet(n, Eq(...), Reals)`를 반환하는 것이다. 즉 "못 풀면 터지는" 대신 "못 풀면 조건집합으로 표현"하는 sympy의 표준 fallback 관례를 따라야 한다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈가 `.as_set()` → `Relational` 경로를 직접 지목한다. 스택트레이스는 없지만 `as_set`/`_eval_as_set`은 `sympy/core/relational.py`의 단일 메서드로 grep 한 방에 수렴한다. 픽스 지점이 한 함수의 한 줄(`return solve_univariate_inequality(...)`)로 핀포인트된다.
- **S (Repair Strategy) = S1 (+S2)**: dominant는 S1(Direct-Map). 결함 클래스가 "예외 누수 → 도메인 표준 fallback" 으로 정형이고, 픽스는 `try/except NotImplementedError`로 감싸는 기계적 패턴이다. 보조 S2: fallback 값으로 무엇을 반환할지(`ConditionSet(x, self, S.Reals)` — 전체 relational `self`와 base set `Reals`)는 sympy 의미론을 따져 합성해야 하므로 약한 제약추론이 섞인다.
- **K (Knowledge) = K-Domain**: 일반 파이썬으로 try/except는 자명하나, 올바른 반환값이 `ConditionSet`이고 그 base set이 `S.Reals`라는 것은 sympy의 집합 표현 계약(미결정 술어를 ConditionSet으로 표현)을 알아야 한다.
- **Primary = T-DirectMap**: 위치가 명확하고(L0) 픽스가 정형 결함클래스(예외 가드 + 표준 fallback)의 기계적 매핑이라 T-DirectMap. 이슈 본문이 사실상 기대 출력(`ConditionSet(n, Eq(...), Reals)`)을 적어주고, hints에는 거의 동일한 diff까지 들어있어 Direct-Map 성격이 강하다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`sympy/core/relational.py`), 함수 1개(`_eval_as_set`), 순증 +7줄. 1파일·소규모 컷에 해당.
- localize 직접성 높음(L0): 이슈가 API 진입점(`as_set`)을 명시.
- repro 존재(`has-repro`): 이슈에 실행 가능한 재현 한 줄이 그대로 있어 가장 강한 easiness 신호.
- 도메인 지식은 "어디"가 아니라 "무엇을 반환"에만 가볍게 필요(ConditionSet/Reals) → T1까지 내리지 않고 T2.
- P2P 54개로 인접 동작 보존 요구가 있으나(아래 regression 참조), 정상 경로를 건드리지 않는 except-only 패치라 trap이 발화하기 어렵다.

공식 라벨("15 min - 1 hour")과 대체로 일치. 시간라벨이 약간 높은 것은 ConditionSet fallback이 옳은 표현인지 판단하는 도메인 확인 비용 때문이며, 구조적으로는 T2 상한에 위치한다.

## 골드패치 분석
- **파일·함수**: `sympy/core/relational.py`의 `Relational._eval_as_set`.
- **근본원인**: `_eval_as_set`이 `solve_univariate_inequality(self, x, relational=False)`의 반환값을 무조건 그대로 return한다. 이 solver는 닫힌 형식으로 풀 수 없는 방정식/부등식에 대해 결과를 빈손으로 주는 대신 `NotImplementedError`를 raise하는데, 그 예외가 가드 없이 `as_set()` 호출자에게 그대로 전파된다.
- **수정요지**: solver 호출을 `try/except NotImplementedError`로 감싼다. 예외가 나면 `from sympy.sets.conditionset import ConditionSet`를 지연 import 하고 `xset = ConditionSet(x, self, S.Reals)`를 만들어 반환한다. 즉 "풀리면 푼 집합, 못 풀면 조건집합"으로 두 갈래를 만든다. 주석으로 "solve_univariate_inequality raises NotImplementedError for unsolvable equations/inequalities"를 남겨 의도를 못박는다. `S`는 이미 모듈에 import되어 있어 `S.Reals` 사용에 추가 import 불필요, ConditionSet만 순환 import 회피 위해 함수 내부 import.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_issue_18188`** (1개): 두 케이스를 단언한다. (1) `Eq(x*cos(x) - 3*sin(x), 0).as_set() == ConditionSet(x, Eq(x*cos(x) - 3*sin(x), 0), Reals)`, (2) `Eq(x**2 + sqrt(x*2) + sin(x), 0).as_set() == ConditionSet(x, Eq(sqrt(2)*sqrt(x) + x**2 + sin(x), 0), Reals)`. 두 입력 모두 닫힌 형식 해가 없어 solver가 `NotImplementedError`를 던지는 경로다.
- **픽스 증명**: 패치 전엔 `as_set()` 자체가 예외로 죽어 단언 비교에 도달조차 못 한다. 패치 후 except 분기가 `ConditionSet(x, self, S.Reals)`를 생성하는데, 여기서 `x`는 자유심볼, `self`는 원래 relational, base set은 `S.Reals=Reals`라 테스트가 기대하는 ConditionSet 인자와 정확히 일치한다(케이스2의 `sqrt(x*2)`는 sympy 정규화로 `sqrt(2)*sqrt(x)`가 되어 `self` 안에서 동일하게 매칭).
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇아 표면상 overfit-risk가 보이지만, 패치가 입력별 특수분기가 아니라 "solver 예외 일반"을 받아 generic fallback을 주는 구조라 두 테스트 너머 임의의 unsolvable relational로 자연히 일반화된다. special-case 통과가 불가능한 형태라 실질 overfit 위험은 낮다.
- **regression 관점**: P2P 54개 중 핵심은 `test_univariate_relational_as_set` — solver가 정상적으로 푸는 univariate relational들의 as_set 동작. except는 `NotImplementedError`에서만 발화하고 정상 반환 경로(`xset = solve_univariate_inequality(...)` 성공)는 바이트 동일하게 보존되므로 이들이 깨지지 않는다. 이 점이 regression-trap을 무력화한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `.as_set()` 호출과 `NotImplementedError`를 신호로 `relational.py`에서 `as_set`/`_eval_as_set`을 grep → `Relational._eval_as_set` 단일 메서드 도달. 그 안에서 예외를 던질 수 있는 유일 호출이 `solve_univariate_inequality`임을 확인(L0, 탐색 거의 없음).
2. **픽스와 일반화 근거**: 정상 반환은 그대로 두고 solver 호출만 `try/except NotImplementedError`로 감싸 `ConditionSet(x, self, S.Reals)`를 fallback으로 반환. 이게 올바른 일반화인 이유 — sympy에서 "미결정 술어집합"의 표준 표현이 ConditionSet이고(이슈가 기대 출력으로 명시), 예외를 입력값이 아니라 예외 타입으로 잡아 모든 unsolvable relational에 균일 적용되므로 테스트 두 개에 과적합되지 않는다.
3. **regression 안전**: `test_univariate_relational_as_set` 등 풀리는 케이스의 as_set 반환을 보존해야 한다 — except가 성공 경로를 건드리지 않게 try의 정상 흐름을 원형 그대로 유지(`return`을 `xset` 변수로 갈음하되 값은 동일)하는 것이 안전 조건. 광범위 BooleanFunction 단언(`test_bool`, `test_Eq` 등)도 `_eval_as_set` 미경유라 무영향.
4. **함정 회피**: (a) `except Exception`처럼 광범위하게 잡아 다른 버그를 삼키면 안 됨 — `NotImplementedError`로 한정. (b) ConditionSet의 base set을 임의로 잡지 말 것 — `_eval_as_set`은 univariate over reals 전제(메서드 주석의 periodicity 가정)이므로 base는 `S.Reals`여야 테스트의 `Reals`와 일치. (c) ConditionSet을 모듈 상단에서 import하면 순환 import 위험 → 함수 내부 지연 import가 정석. (d) fallback 인자를 `solve` 결과가 아닌 원본 `self`로 넘겨야 함(못 풀었으니 원 조건 그대로 보존).
