---
instance_id: sympy__sympy-14976
repo: sympy/sympy
base_commit: 9cbea134220b0b951587e11b63e2c832c7246cbc
version: "1.2"
difficulty: "15 min - 1 hour"
created_at: 2018-07-25T17:38:07Z
fail_to_pass: 1
pass_to_pass: 13
gold_files: [sympy/printing/pycode.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`lambdify(modules='mpmath')`로 생성된 함수가 유리수(Rational)를 mpmath 정밀도로 감싸지 않고 `232/3` 같은 파이썬 식으로 그대로 내보낸다. Python 2 division 또는 일반 정수 나눗셈으로 평가되어 임의정밀도가 깨지고, 그 결과 `nsolve(eqn, ..., prec=64)`가 요청한 자릿수만큼의 정밀도를 못 낸다. 즉 mpmath 코드 프린터가 Float는 `mpmath.mpf(...)`로 감싸면서 Rational은 누락했다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `lambdify(... 'mpmath')` + "doesn't wrap rationals"를 직접 명시. `MpmathPrinter`를 찾으면 끝이지만, "Float는 감싸는데 Rational만 빠졌다"는 대칭성을 코드에서 읽어야 하므로 L0는 아니고 L1.
- **S2 (Constraint-Reasoning, +S5)**: 고칠 지점(`MpmathPrinter`)은 자명하나, 올바른 출력식 `mpmath.mpf(p)/mpmath.mpf(q)`를 합성해야 한다. "분자/분모를 각각 mpf로 감싼 뒤 나눠야 임의정밀도가 보존된다"는 불변식을 추론으로 도출 — 단순 가드/상수가 아니다. 의도된 출력 형식은 기존 `_print_Float`의 관례에서 재구성(S5)된다.
- **K-Domain**: mpmath의 `mpf` 임의정밀도 의미와 sympy printer dispatch(`_print_<Class>` 오버라이드) 내부 메커니즘을 알아야 함.
- **primary = T-ConstraintReason**: 위치는 좁게 수렴하지만 난점은 "정밀도를 보존하는 올바른 출력식 합성"에 있다. 기계적 템플릿(T-DirectMap)이 아니라 도메인 불변식 추론.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 단일 파일(`pycode.py`) / 신규 메서드 1개(7줄) / localize는 비교적 직접적(이슈가 mpmath 프린터 지목) / `has-repro`(이슈에 `nsolve` 정밀도 손실 재현 코드 첨부, 강한 easiness 신호). 다만 "한 줄 가드"가 아니라 정밀도 불변식을 따져 출력식을 합성해야 하므로 T2를 넘는다. P2P 13개가 인접 프린터(NumPy/SciPy/Python)와 `nsolve` 정밀도 테스트를 광범위하게 커버 → `regression-trap`이 있어 무분별한 변경을 막는다. 공식 라벨 "15분-1시간"과 일치(T3).

## 골드패치 분석
- **파일·함수**: `sympy/printing/pycode.py`의 `MpmathPrinter` 클래스에 `_print_Rational(self, e)` 신규 추가.
- **근본원인**: `MpmathPrinter`는 `_print_Float`만 오버라이드해 Float를 `mpmath.mpf(...)`로 감싼다. Rational에 대한 핸들러가 없어 부모 `PythonCodePrinter`의 기본 경로로 떨어지고, 거기서 `p/q`(예: `232/3`)를 일반 파이썬 division으로 출력 → mpmath 임의정밀도를 우회하여 정밀도 손실.
- **수정요지**: `'{0}({1})/{0}({2})'.format(self._module_format('mpmath.mpf'), e.p, e.q)` — 분자 `e.p`와 분모 `e.q`를 각각 `mpmath.mpf(...)`로 감싸 나눈다. 이러면 나눗셈이 mpf 정밀도로 수행되어 요청 자릿수가 보존된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (`test_MpmathPrinter`)**: `p.doprint(Rational(1, 2)) == 'mpmath.mpf(1)/mpmath.mpf(2)'` 단언 추가. 패치 전에는 `1/2`를 출력해 실패, 패치 후 통과 — 출력식이 정확히 mpf-wrapped division임을 직접 증명.
- **`test_nsolve_rational`** (test_numeric.py, end-to-end): `nsolve(x - Rational(1,3), 0, prec=100) == Rational(1,3).evalf(100)`. 프린터 변경이 실제 nsolve 정밀도 회복으로 이어짐을 100자리에서 검증 — 이슈의 근본 증상을 재현/봉인.
- **overfit 관점**: FAIL_TO_PASS는 `Rational(1,2)` 하나라 얇지만, 출력 형식 단언이 정확(special-case 통과 불가)하고 nsolve 정밀도 테스트가 일반화를 보강하므로 overfit 위험 낮음.
- **regression 관점**: P2P 13개가 `test_PythonCodePrinter`/`test_NumPyPrinter`/`test_SciPyPrinter`와 `test_nsolve*` 군을 포함. 변경이 `MpmathPrinter`에만 국한된 신규 메서드라 다른 프린터의 Rational 처리(정수 나눗셈을 의도하는 경우)를 건드리지 않음 — regression-trap을 통과.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 `lambdify(... 'mpmath')` + "doesn't wrap rationals" → `sympy/printing/pycode.py`의 `MpmathPrinter`로 직행. 거기서 `_print_Float`가 `mpmath.mpf`로 감싸는 걸 보고, Rational용 동등 핸들러가 없음을 확인(부모로 fall-through하여 `p/q` 출력).
2. **픽스와 일반화 근거**: `_print_Rational`을 추가해 `mpmath.mpf(p)/mpmath.mpf(q)`로 출력. 분자·분모를 각각 mpf로 감싸야만 나눗셈이 임의정밀도로 평가된다(한쪽만 감싸거나 `mpf(p/q)`로 감싸면 이미 정밀도가 손실된 후라 틀림). `_print_Float`와 동일한 `_module_format('mpmath.mpf')` 관례를 따르므로 일관적이고 일반적인 수정.
3. **regression 안전**: `MpmathPrinter`에만 메서드를 추가하므로 NumPy/SciPy/Python 프린터의 Rational 동작(정수 나눗셈 의도)은 불변. `test_nsolve*`·다른 프린터 P2P가 무손상임을 보장.
4. **함정 회피**: (a) 부모 `PythonCodePrinter`나 base printer의 `_print_Rational`을 고치면 다른 모듈 출력을 깨뜨림 — 반드시 mpmath 서브클래스에만 한정. (b) `mpf(232/3)`처럼 결합된 분수를 감싸면 division이 먼저 일어나 정밀도가 이미 깨진 채로 감싸짐 → 분자·분모를 분리해 각각 감싸야 한다. (c) `e.p/e.q`가 아니라 sympy의 `_print`로 재귀시키면 또 일반 나눗셈으로 회귀할 수 있음 — 정수 속성 `e.p`,`e.q`를 직접 mpf로 감싸는 것이 정답.
