---
instance_id: sympy__sympy-16597
repo: sympy/sympy
base_commit: 6fd65310fa3167b9626c38a5487e171ca407d988
version: "1.5"
difficulty: 1-4 hours
created_at: 2019-04-08T12:49:10Z
fail_to_pass: 3
pass_to_pass: 74
gold_files: [sympy/assumptions/ask.py, sympy/assumptions/ask_generated.py, sympy/core/assumptions.py, sympy/core/power.py, sympy/printing/tree.py, sympy/tensor/indexed.py]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, underspecified]
---

# sympy__sympy-16597

## 문제 요약
`Symbol('m', even=True)`의 `is_finite`가 `None`을 반환한다 — even이면 finite가 함의되어야 하는데 그렇지 않다. integer/rational도 마찬가지로 finite를 함의하지 않는다. 이슈는 "유한해야 even/integer일 수 있다"는 직관을 제기하지만, 정확히 어느 assumption까지 finite를 부여해야 안전한지(특히 `real`은 현재 `extended_real` 의미라 건드리면 위험)는 본문에서 미정이다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 진짜 픽스는 `core/assumptions.py`의 `_assume_rules` 한 곳이지만, 같은 룰 테이블을 별도로 인코딩한 `assumptions/ask.py`(`get_known_facts`)와 그 코드생성 산출물 `ask_generated.py`(CNF + dict)를 **함께** 일관되게 갱신해야 한다. 게다가 finite 함의 추가가 깨뜨리는 부수효과를 `core/power.py`·`tensor/indexed.py`에서 보정해야 한다 → 조율형 멀티사이트.
- **S = S6 (Design-Refactor) +S2**: 단일 가드가 아니라 **assumption 그래프(불변식 집합)의 재설계**다. 어떤 함의(`rational -> finite`, `algebraic -> finite`, `transcendental`/`irrational`의 동치식에 `& finite`)를 추가할지 정확히 합성해야 하므로 제약추론(S2)이 보조로 붙는다.
- **K = K-Domain**: sympy assumptions 엔진(FactRules CNF, three-valued 논리, `real` vs `extended_real` 구분, 무한대 객체 `oo`의 가정)에 대한 내부 지식이 병목.
- **primary_type = T-DesignRefactor**: 결함은 "한 줄 버그"가 아니라 가정 시스템의 불완전한 함의 그래프이며, 여러 표상(rules/CNF/dict)을 조율해 구조적으로 확장하는 게 본질. APR 관점에서 템플릿/단일가드(S1)로는 절대 안 잡히고, 불변식 집합을 바꾼 뒤 그 파급을 다른 모듈에서 봉합하는 S6 작업이다.

## 난이도 티어
**T5 (어려움)**. 구조 피처:
- **파일수 6 / 헌크 다수**: ICLR 2024 컷에서 ≥3파일이면 solve <10% 구간. 핵심 1파일이지만 코드생성 미러(`ask_generated.py`)와 파급보정 2파일이 강제로 동반된다.
- **localize 직접성 낮음**: 이슈는 `even`을 가리키지만 실제 수정점은 `even`이 아니라 상위 함의(`rational`/`algebraic`/`irrational`/`transcendental`)와 finite 연결이다. 증상→수정점이 한 단계 떨어져 있다.
- **repro 약함**: 동작 차이(`None` 출력)는 있으나 네이티브 스택트레이스가 없고, "어디까지 finite를 줄지"는 underspecified.
- **P2P trap 큼**: 74개 PASS_TO_PASS. 가정 그래프 변경은 `test_Mul_is_infinite`, `test_special_is_rational`, `test_Pow_is_algebraic` 등 광범위한 인접 추론을 깨기 쉽다.
공식 라벨 "1-4 hours"와 일치 — 단순 패치가 아니라 그래프 일관성+회귀 봉합이 시간을 먹는다.

## 골드패치 분석
- **`sympy/core/assumptions.py`** (`_assume_rules`): `'rational -> real'`→`'rational -> real & finite'`, `'algebraic -> complex'`→`'algebraic -> complex & finite'`, `'transcendental == complex & !algebraic'`→`... & finite`, `'irrational == real & !rational'`→`... & finite`. **근본원인 수정**: finite가 어느 가정에서도 함의되지 않던 그래프 누락을 채움. `real`은 의도적으로 건드리지 않음(현재 `extended_real` 의미라 회귀 위험 — 이슈 코멘트의 결론을 따름).
- **`sympy/assumptions/ask.py`** (`get_known_facts`) + **`ask_generated.py`**(`get_known_facts_cnf`/`get_known_facts_dict`): 같은 함의를 ask 시스템 표상으로 미러. `Implies(Q.rational, ...)`/`Equivalent(...)`에 `Q.finite` 추가, CNF 절·compressed dict 재생성.
- **`sympy/core/power.py`** (`_eval_is_rational`): finite 함의 추가로 `self.func(*self.as_base_exp())` 재평가 경로가 더 자주 타며 `integer**integer` 대형 지수에서 비용 폭발. 가드 추가 — `exp.is_integer and base.is_rational and fuzzy_not(fuzzy_and([exp.is_negative, base.is_zero]))`면 즉시 `True` (조기 탈출). `fuzzy_and` import 추가.
- **`sympy/tensor/indexed.py`** (`Idx.__new__`): bound `is_integer is False`만으로 거부하던 코드가, 이제 `oo`가 `is_integer is False`로 확정되면서 `Idx` 범위에 `±oo`를 못 쓰게 됨 → `bound is not S.Infinity and bound is not S.NegativeInfinity` 예외 추가.
- **`sympy/printing/tree.py`** (`print_tree` docstring): 출력 예시에 `finite`/`infinite` 줄 반영(문서 일관성).

## 검증 (test_patch)
- **FAIL_TO_PASS (3)**: `test_infinity`·`test_neg_infinity`는 `oo`/`-oo`의 `is_integer/is_rational/is_algebraic/is_transcendental/is_irrational/is_even/is_odd/is_composite`가 이전 `None`에서 **`False`로 확정**됨을 단언. 즉 finite 함의가 추가되니 무한대 객체에서 그 반대 방향(`~finite → ~rational` 등)이 추론되어 None→False로 좁혀진다 — 픽스의 직접 증명. `test_other_symbol`은 `Symbol(integer/odd/even/rational/irrational=True)`에 대해 `is_finite is True`, 그리고 `rational=False`/`irrational=False`에서 `is_finite is None`(과확장 방지)을 단언.
- **overfit 관점**: 테스트가 finite-true와 finite-None 양쪽을 모두 검사하므로 "전부 True로 칠해버리는" special-case 통과가 막힌다. CEGIS 위험은 낮음.
- **regression 관점**: 74 P2P가 가정 그래프의 인접 동작(Mul/Pow/Add 추론, prime/composite)을 폭넓게 가드. `test_minmax_assumptions`는 `p = Symbol('p', real=True, rational=False)`를 `irrational=True`로 바꿔야 통과한다. 여기서 `real`은 명시적 kwarg라 `rational=False`가 `real`을 함의하던 게 아니다 — 진짜 원인은 `irrational` 동치식 변경(`irrational == real & !rational` → `... & finite`)이다. 옛 규칙에선 `real=True & rational=False`가 `is_irrational=True`를 유도했으나, 새 규칙에선 `p`에 `finite`가 없어 `is_irrational`이 `None`이 되어 'irrational 테스트 대상' 역할을 잃는다. 그래서 테스트가 `p`를 `irrational=True`로 다시 선언해 그 역할을 복원한다 — 의미 변화는 (real 함의가 아니라) finite가 추가된 `irrational` 동치식에 있다.

## 모범답안 (오라클 기반)
1. **localize 경로**: "is_finite가 함의 안 된다" + 코멘트의 `'rational -> real'`을 `'rational -> real & finite'`로 확장하자는 힌트 → `core/assumptions.py`의 `_assume_rules`가 1차 수정점. 같은 규칙이 `assumptions/ask.py`·`ask_generated.py`에 미러됨을 grep으로 확인(코드생성 산출물이므로 함께 갱신 필수).
2. **픽스와 일반화 정당성**: finite를 `rational`·`algebraic`과 `transcendental`·`irrational` 동치식에 추가하되 **`real`에는 추가하지 않음**. 이유: sympy의 `real`은 사실상 `extended_real`(±oo 포함)을 허용하는 의미라 finite를 강제하면 무한대 객체가 모순이 된다. 코멘트가 명시한 이 경계를 따르는 것이 over-generalize가 아닌 올바른 일반화.
3. **regression 안전**: 74 P2P 중 `test_Mul_is_infinite`/`test_special_is_rational`/`test_Pow_is_algebraic`을 안 깨야 함 — finite 추가가 무한대 추론과 충돌하지 않도록 `real`을 보존한 게 핵심. `power.py` 가드는 finite 함의가 유발한 재평가 비용 폭발(성능 회귀)을 봉합, `indexed.py`는 `oo` 범위 거부 회귀를 봉합.
4. **함정 회피**: (a) 오라클 없는 에이전트는 `_assume_rules`만 고치고 `ask_generated.py`(CNF/dict)를 빼먹어 ask 시스템이 불일치 — **코드생성 미러 누락**이 1번 함정. (b) `real -> finite`까지 욕심내면 무한대 객체에서 모순 폭발 → P2P 대량 실패. (c) `power.py`의 조기탈출 가드를 빠뜨리면 `integer**integer` 대형 지수 테스트가 타임아웃/지연되는 성능 회귀를 못 잡는다. (d) `indexed.py`의 `±oo` 예외를 빠뜨리면 무한 적분/합 경계 사용처가 깨진다.
