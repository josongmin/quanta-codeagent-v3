---
instance_id: sympy__sympy-15809
repo: sympy/sympy
base_commit: 28d913d3cead6c5646307ffa6540b21d65059dfd
version: "1.4"
difficulty: "<15 min fix"
created_at: 2019-01-20T06:08:26Z
fail_to_pass: 2
pass_to_pass: 10
gold_files: [sympy/functions/elementary/miscellaneous.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
`Min()`과 `Max()`를 인자 없이 호출하면 `ValueError: The Max/Min functions must have arguments.`가 발생한다. 이슈는 수학적으로 빈 집합에 대한 min/max가 확장 실수에서 각각 `+oo`(`S.Infinity`), `-oo`(`S.NegativeInfinity`)로 정의되므로(Wikipedia: Empty set#Extended real numbers) 예외 대신 이 값을 반환하는 것이 더 편리하다고 제안한다. 즉 lattice의 identity element를 빈 호출의 결과로 노출하라는 요청이다.

## 유형 (정형화)
- **L (Localization) = L0**: 이슈가 던지는 예외 메시지 `"The Max/Min functions must have arguments."`가 코드에 verbatim으로 존재한다. grep 한 방이면 `MinMaxBase.__new__` 첫 줄의 가드로 직행한다. 후보 단일.
- **S (Repair Strategy) = S1 (+S5 보조)**: 픽스는 `if not args: raise ValueError(...)` 가드 2줄을 **삭제**하는 기계적 변경이다(정형 결함클래스 "불필요한 방어 가드 제거"). 다만 "삭제만 하면 왜 `oo`/`-oo`가 나오나"는 도메인 스펙(lattice identity)을 이해해야 안전하다고 판단할 수 있어 S5(스펙 재구성)가 보조로 붙는다 — 코드의 이미 존재하는 `if not args: return cls.identity` 경로가 정답을 만들어낸다.
- **K (Knowledge) = K-Domain**: 일반 파이썬 추론만으로는 "가드를 지우면 무엇이 반환되는가"를 보장할 수 없다. `MinMaxBase`가 `LatticeOp`을 상속하고 `Max.identity = S.NegativeInfinity` / `Min.identity = S.Infinity`라는 sympy 내부 lattice 규약을 알아야 픽스가 올바름을 확신한다.
- **primary = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 가드 제거(S1)다. 추론보다 "찾으면 거의 끝". 다만 자명함의 검증에 도메인 지식이 한 겹 깔려 있다.
- **왜 이 strategy인가 (APR 관점)**: 이슈가 사실상 픽스를 명세(empty→identity)하고, 결함클래스가 "과방어 예외"이므로 template-style 삭제로 매핑된다. SemFix식 식 합성도, generate-&-validate 반복도 불필요하다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개, 함수 1개(`__new__`), 실변경 -2줄(순삭제). 1파일·<5줄 컷(≈48% solve 구간) 안쪽.
- localize 직접성: 예외 문자열 verbatim 매칭 → L0, 거의 무비용.
- repro: 이슈에 `Min()`/`Max()` 호출과 기대결과가 명시되어 사실상 재현·기대값 동시 제공.
- 도메인: lattice identity 규약 이해가 필요해 순수 T1(K-Gen)보다 한 칸 위.
- P2P trap: PASS_TO_PASS 10개가 모두 같은 모듈(`test_miscellaneous.py`) min/max 동작이라 가드 삭제가 비-empty 경로의 단락(`ShortCircuit`/`_new_args_filter`/`_collapse_arguments`)에 영향을 주지 않아야 한다 → `regression-trap` 약(弱)존재.

공식 라벨 `<15 min fix`와 일치(T1~T2 prior). T1로 더 내리지 않은 이유는 "삭제 후 무엇이 반환되는지"가 코드만 봐서는 즉시 자명하지 않고 `cls.identity` 경로와 lattice 규약을 따라가야 안전성이 보장되기 때문(K-Domain 한 겹).

## 골드패치 분석
- **건드린 파일·함수**: `sympy/functions/elementary/miscellaneous.py` → `MinMaxBase.__new__`.
- **근본원인**: `__new__` 진입 즉시 `if not args: raise ValueError("The Max/Min functions must have arguments.")` 과방어 가드가 빈 호출을 차단했다. 정작 같은 메서드 하류에 `_find_localzeros` 이후 `if not args: return cls.identity` 경로가 이미 존재해, 가드만 없으면 빈 인자가 자연스럽게 identity로 귀결되도록 설계돼 있었다.
- **수정요지**: 진입부 가드 2줄을 삭제. 이후 `args`는 빈 generator → `_new_args_filter`/`_collapse_arguments`/`_find_localzeros`를 거쳐도 비어 있고 → `if not args: return cls.identity`에 도달. `Max.identity = S.NegativeInfinity`, `Min.identity = S.Infinity`이므로 정확히 이슈가 요구한 값이 반환된다. 별도의 분기 추가 없이 기존 lattice identity 경로 재사용이 핵심.

## 검증 (test_patch)
- **FAIL_TO_PASS = [`test_Min`, `test_Max`]** (2개). 두 테스트의 기존 `raises(ValueError, lambda: Min())` / `raises(ValueError, lambda: Max())`가 다음으로 교체된다:
  - `assert Min() == S.Infinity`, `assert Min(x) == x`
  - `assert Max() == S.NegativeInfinity`, `assert Max(x) == x`
- **픽스 증명**: 가드 제거 후 빈 호출은 `cls.identity`로 귀결되어 `Min()→oo`, `Max()→-oo`를 만족. `Min(x)==x`/`Max(x)==x`는 새 코드가 아니라 기존 `if len(args) == 1: return list(args).pop()` 경로가 이미 보장하던 동작으로, 단일 인자 회귀가 깨지지 않음을 함께 고정한다.
- **overfit 관점**: FAIL_TO_PASS가 얇지만(2 테스트) 검증 입력이 empty와 single-arg 두 경계를 모두 짚어 special-case 통과 여지가 거의 없다. 가드 삭제는 가장 일반적인 픽스라 over-narrow 패치가 끼어들 자리가 없음.
- **regression 관점**: PASS_TO_PASS 10개(`test_minmax_assumptions`, `test_root`, `test_real_root`, `test_rewrite_*`, `test_issue_8413/11099/12638`, `test_instantiation_evaluation`, `test_rewrite_as_Abs`)가 비-empty 다인자 min/max·rewrite·assumption 경로를 커버. 가드는 `args`가 비었을 때만 트리거되므로 이 경로들과 무관 → 모두 통과 유지.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 예외 메시지 `"The Max/Min functions must have arguments."`를 코드베이스에서 grep → `MinMaxBase.__new__` 첫 줄의 `if not args: raise ValueError(...)`로 즉시 수렴(L0).
2. **픽스와 일반화 근거**: 그 가드 2줄을 삭제. 단순 삭제가 올바른 일반화인 이유는 `__new__` 하류에 `if not args: return cls.identity`가 이미 존재하고 `Min.identity=S.Infinity`/`Max.identity=S.NegativeInfinity`이기 때문 — 즉 이슈가 요구한 확장 실수 정의(empty min=+oo, empty max=-oo)가 lattice identity와 정확히 일치한다. 새 분기를 추가해 `return S.Infinity`를 하드코딩하는 것보다, 기존 identity 경로 재사용이 Min/Max 양쪽에 cls-다형으로 자동 적용되어 더 일반적이다.
3. **regression 안전**: 가드는 빈 인자에서만 발화하므로, 다인자/단일인자/assumption/rewrite 경로(PASS_TO_PASS 10개)는 byte 단위로 불변. 특히 `if len(args)==1: return list(args).pop()`가 `Min(x)==x`를 계속 보장하는지 확인하면 single-arg 경계 회귀가 닫힌다.
4. **함정 회피**: 오라클 없는 에이전트가 빠질 함정은 (a) `__new__` 안에 `if not args: return cls.identity`가 이미 있음을 못 보고 진입부에 `return S.Infinity if cls is Min else S.NegativeInfinity` 같은 cls-하드코딩 분기를 새로 다는 것(중복·취약), (b) 단순 삭제가 KeyError/StopIteration로 터질까 봐 가드를 try/except로 감싸는 과잉방어. 정답은 하류 identity 경로를 신뢰하고 가드만 제거하는 것이며, 이는 lattice 규약(K-Domain)을 한 번 확인하면 자명해진다.
