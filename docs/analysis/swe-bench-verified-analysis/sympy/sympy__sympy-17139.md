---
instance_id: sympy__sympy-17139
repo: sympy/sympy
base_commit: 1d3327b8e90a186df6972991963a5ae87053259d
version: "1.5"
difficulty: "<15 min fix"
created_at: 2019-07-01T19:17:18Z
fail_to_pass: 2
pass_to_pass: 67
gold_files: [sympy/simplify/fu.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`simplify(cos(x)**I)` 호출 시 `TypeError: Invalid comparison of complex I`가 발생한다. 스택트레이스가 `sympy/simplify/fu.py`의 `_TR56` 내부 `_f` 함수 504번째 줄 `if (rv.exp < 0) == True:`까지 정확히 지목한다. 지수가 복소수(`I`, `2*I+1`, `2+3*I`)일 때 `Expr.__lt__`가 복소수 비교를 거부하면서 예외가 터진다. 실수 지수만 가정한 부등식 비교가 복소 지수에 대해 방어되지 않은 것이 원인이다.

## 유형 (정형화)
- **L (Localization): L0** — 이슈 본문에 네이티브 스택트레이스가 통째로 들어 있어 `fu.py:504`, 함수 `_f`, 줄 `if (rv.exp < 0) == True:`까지 핀포인트. 탐색이 사실상 0.
- **S (Repair Strategy): S1 (+S2)** — 결함 클래스가 정형적이다(부등식 비교 전 타입 가드 부재). 픽스는 "비교 전에 `rv.exp.is_real`이 아니면 조기 return" 추가로 기계적 가드 삽입(S1). 다만 `< 0` 비교가 well-defined인 정확한 전제조건이 "지수가 실수"임을 도메인 불변식으로 추론해야 하므로 S2 보조.
- **K (Knowledge): K-Domain** — SymPy assumptions 시스템(`.is_real`, `Expr.__lt__`의 복소 비교 거부 계약)을 알아야 올바른 가드를 짠다. 일반 파이썬 추론만으론 `is_real` 3값 논리(True/False/None)를 못 맞춘다.
- **primary type: T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 가드 한 줄(S1)이라 DirectMap. 진짜 어려움이 "어디"가 아니라 "어떤 조건으로 막을지"인데, 그 조건도 도메인 계약상 자명에 가깝다.

APR 관점: 이슈가 사실상 픽스 위치를 명세하고, 결함이 None/타입 가드 부재라는 정형 결함 클래스에 템플릿 매칭되므로 PAR/TBar류 template-based repair(S1)가 dominant. 합성해야 할 식이 새 수식이 아니라 단순 early-return 가드라 S2는 보조에 그친다.

## 난이도 티어
**T2 (쉬움).** 구조적 피처:
- 파일 수 1개(`sympy/simplify/fu.py`), 추가 줄 2줄(가드 1줄 + 공백).
- localize 직접성 최상(L0, 네이티브 스택트레이스 `has-repro`).
- 도메인 지식은 가볍게 필요(`is_real`)하나 깊은 call-chain 추론은 불필요.
- P2P 68개는 넓어 보이지만 변경이 "복소 지수일 때만 조기 탈출"이라 실수 지수 경로는 바이트 동일 — regression-trap은 명목상 존재하나 위험은 낮음.
공식 라벨 `<15 min fix`와 일치한다. T1이 아닌 이유: 픽스가 이슈 본문에 글자 그대로 적혀 있지 않고, `is_real` 가드를 SymPy assumptions 계약에서 선택해야 하는 가벼운 도메인 판단이 들어가서 T1(존나쉬움)보다 한 단계 위.

## 골드패치 분석
- **건드린 파일·함수**: `sympy/simplify/fu.py`의 `_TR56` 내부 클로저 `_f(rv)`.
- **근본원인**: `_f`는 `rv.is_Pow and rv.base.func == f`인 거듭제곱 항에 대해 `if (rv.exp < 0) == True:`로 지수 부호를 판정한다. `Expr.__lt__`(core/expr.py:406)는 피연산자가 복소수면 `TypeError("Invalid comparison of complex ...")`를 던진다. 코드가 지수를 암묵적으로 실수로 가정했는데 `cos(x)**I` 같은 복소 지수 입력에 대한 방어가 없었다.
- **수정요지**: `if not (rv.is_Pow and rv.base.func == f): return rv` 바로 뒤에 가드 한 줄을 삽입:
  ```python
  if not rv.exp.is_real:
      return rv
  ```
  복소(또는 실수 여부 미확정) 지수면 변환을 시도하지 않고 항을 그대로 반환한다. 이후 `(rv.exp < 0)` 비교는 실수 지수에만 도달하므로 `TypeError`가 구조적으로 차단된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `test__TR56` — `T(sin(x)**I, ...) == sin(x)**I`, `T(sin(x)**(2*I+1), ...) == sin(x)**(2*I+1)`로 복소 지수가 변환되지 않고 그대로 통과함을 단언.
  - `test_issue_17137` — 상위 진입점 `simplify(cos(x)**I) == cos(x)**I`, `simplify(cos(x)**(2+3*I)) == cos(x)**(2+3*I)`로 원래 크래시하던 호출이 항등 반환됨을 단언.
- **픽스 증명**: 예외가 나던 두 입력 클래스(순허수 `I`, 복소수 `2+3*I`/`2*I+1`)가 이제 가드에 걸려 조기 return → 결과는 입력과 동일. 픽스 전이면 `__lt__`에서 죽고, 후이면 통과하므로 red→green이 명확.
- **overfit 관점**: 가드 조건이 테스트 입력(`I`, `2+3*I`)에 특화된 게 아니라 `is_real` 일반 술어라 미검증 복소 입력공간 전체를 커버 — overfit 아님. `flags`에 overfit-risk 미부여.
- **regression 관점**: 실수 지수(`is_real == True`)는 가드를 통과해 기존 `(rv.exp < 0)` 경로로 그대로 흐르므로 `test__TR56`의 기존 실수 케이스(`sin(x)**6`, `sin(x)**8` 등)와 P2P 68개가 보존된다. 단 `is_real`이 `None`(미확정)인 심볼릭 지수도 가드에 걸려 조기 return되는데, 이는 안전한 보수적 동작(불확실하면 변환 안 함)이라 회귀가 아니다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 네이티브 스택트레이스가 최종 프레임 `fu.py:504 if (rv.exp < 0) == True:`와 예외 `Invalid comparison of complex I`(core/expr.py:406 `__lt__`)를 직접 준다. → `_TR56`의 `_f` 클로저로 grep 한 방. 탐색 불필요.
2. **픽스와 일반화 근거**: 부등식 `rv.exp < 0`은 지수가 실수일 때만 well-defined다. 따라서 비교 직전에 `if not rv.exp.is_real: return rv` 가드를 넣는다. `I`/`2+3*I` 같은 리터럴이 아니라 `is_real` 술어로 막으므로 모든 복소·미확정 지수에 일반화된다 — 테스트 특화가 아닌 원인 직격.
3. **regression 안전**: 실수 지수는 `is_real == True`라 가드를 그냥 통과해 기존 변환 로직(`sin(x)**6` 등)이 그대로 동작. P2P 68개(`test_TR1`~`test_TR15_16_17`, `test_simplify_*` 등)와 `test__TR56`의 실수 케이스가 바이트 동일 경로로 보존된다.
4. **함정 회피**: (a) `rv.exp < 0`을 `try/except TypeError`로 감싸는 임시방편은 증상만 가리고 비교 의도(부호 판정)를 흐린다 — 오라클은 타입 자체를 사전 배제. (b) 가드를 `is_complex`나 `not is_real`이 아닌 `is_imaginary`로 쓰면 `2+3*I`(실/허 혼합)를 놓친다 — `is_real`의 False/None을 함께 막는 `not rv.exp.is_real`이 정답. (c) 가드를 `if not (rv.is_Pow and rv.base.func == f)` *앞*에 두면 `rv.exp` 접근이 비-Pow 항에서 AttributeError를 낼 수 있어 위치(그 줄 *뒤*)가 중요하다.
