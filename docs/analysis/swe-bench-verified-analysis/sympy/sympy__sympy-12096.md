---
instance_id: sympy__sympy-12096
repo: sympy/sympy
base_commit: d7c3045115693e887bcd03599b7ca4650ac5f2cb
version: "1.0"
difficulty: "<15 min fix"
created_at: 2017-01-25T13:40:24Z
fail_to_pass: 1
pass_to_pass: 43
gold_files: [sympy/core/function.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [overfit-risk, regression-trap]
---

## 문제 요약
`implemented_function`으로 만든 함수를 합성(`f(g(2))`)한 뒤 `evalf()`를 호출하면 평가가 안 되고 `f(g(2))` 심볼이 그대로 남는다. 단일 적용(`f(2).evalf()`)은 정상 동작한다. 이슈 본문이 직접 원인을 지목한다: `Function._eval_evalf`가 `_imp_`의 인자에 대해 `evalf`를 재귀적으로 호출하지 않아, 내부 함수 `g(2)`가 수치로 환원되지 않은 채 Python 콜러블 `_imp_`에 전달되어 `TypeError`/`ValueError`로 조용히 실패(`return None`)하기 때문이다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈가 `Function._eval_evalf`를 함수명으로 직접 지목하고 "재귀적으로 evalf를 안 부른다"고 원인까지 명시. grep 한 방.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 줄은 자명하나, 올바른 수정은 "인자를 먼저 `evalf(prec)`로 환원한 뒤 `_imp_`에 넘긴다"는 평가 순서 불변식을 추론으로 합성해야 한다. 단순 가드 추가(S1)가 아니라 데이터플로우 의미(`_imp_`는 수치만 받는다)를 이해해야 옳은 한 줄이 나온다.
- **K (Knowledge) = K-Domain**: `_imp_`/`implemented_function`/`Float`/`prec` 전달 의미 등 sympy의 evalf·lambdify 내부 계약 지식이 병목. 일반 파이썬 추론만으론 `prec`를 어디로 흘려야 하는지 모름.
- **primary_type = T-ConstraintReason**: 위치는 명확(L0)하나 정확한 식(`*[i.evalf(prec) for i in self.args]`)을 의미 추론으로 만들어야 하므로 S2 dominant. APR 관점에서 SemFix/Angelix식 "조건·식 합성"이며 generate-and-validate(여러 후보 시도)가 아니다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 파일 1개·실질 변경 1줄(헌크 1개), localize 직접성 최상(L0, has-repro에 가까운 명확 재현 스니펫 존재). 그러나 (1) 올바른 수정이 `prec`까지 함께 전파하는 의미 추론을 요구하고, (2) `_eval_evalf`가 **모든** `Function` 평가의 공통 경로라 PASS_TO_PASS 43개(trig/sqrt/exponentiation/mpmath 정밀도 등)를 안 깨야 하는 regression-trap이 있다. 공식 라벨은 `<15 min fix`(T1~T2급)지만, 이는 "패치 작성 시간"이라 의미 추론 깊이와 광범위한 회귀 위험을 반영 못 한다 — 그래서 T3로 한 단계 올린다.

## 골드패치 분석
- **파일·함수**: `sympy/core/function.py`의 `Function._eval_evalf(self, prec)`.
- **근본원인**: mpmath 함수 lookup이 실패하는 fallback 분기(`except (AttributeError, KeyError)`)에서 `_imp_`를 호출할 때 `Float(self._imp_(*self.args), prec)`로 **심볼릭 인자를 그대로** 넘겼다. 합성 `f(g(2))`에서는 인자 `g(2)`가 아직 미평가 sympy 표현식이라, Python 콜러블 `lambda x: x**2`가 이를 산술할 수 없어 내부 except로 빠져 `None`을 반환 → evalf가 표현식을 못 줄임.
- **수정요지**: 인자를 먼저 수치로 환원해서 넘긴다.
  `Float(self._imp_(*[i.evalf(prec) for i in self.args]), prec)`.
  각 인자에 `evalf(prec)`를 적용해 내부 `g(2)`를 재귀적으로 평가하므로, 콜러블이 받는 값이 항상 수치가 되어 합성이 풀린다. `prec`를 함께 넘겨 정밀도 계약을 유지.

## 검증 (test_patch)
- **FAIL_TO_PASS** = `test_issue_12092` (1개): `f = implemented_function('f', lambda x: x**2)`에 대해 `f(f(2)).evalf() == Float(16)`을 단언. 패치 전엔 `f(f(2))`가 그대로 남아 `Float(16)`과 불일치 → 실패. 패치 후 내부 `f(2)`가 `evalf(prec)`로 4.0이 되고 외부가 16.0을 산출 → 통과. 이 한 줄 수정이 정확히 "재귀 평가" 동작을 증명.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 얇음(`overfit-risk`). 단, 합성 입력으로 재귀 경로를 직접 친다는 점에서 special-case 통과는 어렵다. 다만 0-arg/다중 arg/예외 인자 등은 미검증.
- **regression 관점**: `_eval_evalf`는 전 `Function`의 수치평가 핵심 경로 → PASS_TO_PASS 43개(`test_trig_float`, `test_sqrt`, `test_exponentiation`, `test_mpmath_precision`, `test_imps`, `test_lambdify_imps` 등)가 회귀 게이트. 변경이 fallback 분기 내부에 국한되고 mpmath 정상 경로는 무손상이라 안전(`regression-trap`이지만 헌크가 분기 격리됨).

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `Function._eval_evalf`를 명시 + "재귀 호출 안 함" 언급 → `sympy/core/function.py`에서 해당 메서드로 직행. fallback `except (AttributeError, KeyError)` 블록의 `self._imp_(*self.args)`가 인자를 미평가로 넘기는 지점을 즉시 식별.
2. **픽스와 일반화**: `self.args`를 `[i.evalf(prec) for i in self.args]`로 바꿔 각 인자를 먼저 수치 환원. 이는 합성뿐 아니라 "임의 깊이의 중첩 implemented_function"을 모두 처리하는 올바른 일반화 — 한 단계가 아니라 인자 전체에 evalf를 매핑하기 때문. `prec` 전파로 정밀도 계약도 유지하므로 special-case가 아니다.
3. **regression 안전**: mpmath 정상 lookup 경로(`func = getattr(mpmath, fname)` 이후)는 손대지 않아 모든 표준 함수 evalf가 그대로. PASS_TO_PASS의 정밀도/translation 테스트가 안 깨지는 이유. 변경은 `_imp_` fallback 안에서만 발생.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정 — (a) `prec`를 빼고 `i.evalf()`만 호출해 정밀도 계약을 어기는 것, (b) 인자를 `_to_mpmath`로 바꾸려다 fallback 분기에 mpmath가 없는 상황을 깨닫지 못하는 것, (c) `except (AttributeError, TypeError, ValueError)`가 실패를 삼키므로 "왜 None인가"를 못 보고 엉뚱한 곳을 고치는 것. 올바른 접근은 except가 가린 실제 실패(콜러블에 심볼 전달)를 짚는 것이다.
