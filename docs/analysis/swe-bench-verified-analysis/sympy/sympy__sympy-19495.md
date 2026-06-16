---
instance_id: sympy__sympy-19495
repo: sympy/sympy
base_commit: 25fbcce5b1a4c7e3956e6062930f4a44ce95a632
version: "1.7"
difficulty: "<15 min fix"
created_at: 2020-06-05T11:53:09Z
fail_to_pass: 1
pass_to_pass: 8
gold_files: [sympy/sets/conditionset.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`ConditionSet`에 대해 자유심볼을 `.subs()`로 치환할 때, base set이 `ImageSet`이면 결과가 깨진다. 이슈의 `Out[75]`에서 보듯 `ConditionSet(x, Contains(y, Interval(-1,1)), imageset(...))`에 `y -> 1/3`을 치환하면 바운드 변수 `x`가 사라지고 치환값 `1/3`이 바운드 변수 자리로 새어 들어간 엉뚱한 `ConditionSet`이 나온다 ("바운드 변수 `x`가 `y`로 오인된 것 같다"). 동일 입력에 `xreplace`나 `simultaneous=True`는 올바르게 동작한다(`Out[78]`, `Out[80]`).

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 `subs` + `ConditionSet`을 직접 지목하고 재현코드가 있다. `conditionset.py`의 `_eval_subs`로 한두 번의 grep으로 수렴한다. 단, 정확한 결함 분기(`if cond is S.true:`)까지는 코드 독해가 필요해 L0은 아니다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 위치는 명확하나, "왜 `cond is S.true`일 때 `Contains(new, base)`로 재구성하면 안 되는가"를 불변식 추론으로 합성해야 한다. 핵심은 `__new__`와의 일관성: 생성자는 가정(assumptions)을 근거로 `sym`이 base에 속하는지 검사하지 않으므로, `subs`도 같은 규약을 따라야 한다. 단순 가드 추가(S1)가 아니라 잘못된 재구성 분기를 제거하고 올바른 등식을 세우는 작업이다.
- **K (Knowledge) = K-Domain**: `ConditionSet`/`ImageSet`/`Contains`의 sympy set 시맨틱과 dummy(바운드) 심볼 규약을 알아야 한다. 일반 파이썬 추론만으로는 `new`가 바운드 변수 자리에 들어가면 안 된다는 점을 못 잡는다.
- **primary_type = T-ConstraintReason**: 위치는 좁지만 픽스의 본질이 "올바른 치환 의미론"을 추론으로 세우는 데 있어 ConstraintReason이 dominant.

## 난이도 티어
**T3 (중간).** 구조적 피처: gold가 단일 파일(`conditionset.py`)·실코드 변경 라인 ~6줄(나머지는 docstring 정리)·has-repro로 재현 명확. 하지만 (1) 결함이 "추가 누락"이 아니라 "잘못된 분기의 존재"라서 localize 후에도 *왜 그 분기를 통째로 지워야 안전한가*를 추론해야 하고, (2) `__new__`와의 시맨틱 일관성이라는 도메인 불변식을 들어야 한다. P2P 8개가 `test_CondSet`/`test_dummy_eq`/`test_contains` 등 인접 동작을 광범위하게 커버해 regression-trap이 실재한다. 공식 라벨은 `<15 min fix`(T1~T2 prior)지만, 개발자 입장의 "고치는 시간"이 짧을 뿐 에이전트 입장에선 잘못된 분기 제거의 정당화(가정 무시 규약) 추론이 필요해 T3로 한 칸 올렸다.

## 골드패치 분석
- **파일·함수**: `sympy/sets/conditionset.py`의 `ConditionSet._eval_subs` (그 외 클래스 docstring 오타/공백 정리).
- **근본원인**: `old != sym`(자유심볼 치환) 경로에서 기존 코드는
  ```python
  cond = self.condition.subs(old, new)
  base = self.base_set.subs(old, new)
  if cond is S.true:
      return ConditionSet(new, Contains(new, base), base)
  return self.func(self.sym, cond, base)
  ```
  였다. `condition`이 `Contains(y, Interval(-1,1))`처럼 치환 후 `S.true`로 평가되면 `if cond is S.true` 분기가 타고, 거기서 **치환값 `new`(=`1/3`)를 바운드 변수 자리에** 넣어 `ConditionSet(new, Contains(new, base), base)`를 만든다. 이 때문에 바운드 변수 `x`가 사라지고 `1/3`이 dummy 자리로 새어 나간다(`Out[75]`).
- **수정요지**: `if cond is S.true:` 특수분기를 **통째로 삭제**하고, `else`로 묶어 항상 `return self.func(self.sym, cond, base)`만 반환한다. 즉 바운드 변수 `self.sym`을 보존한 채 condition/base만 치환한다. 주석으로 "가정 때문에 condition이 true가 되더라도, `subs`가 `__new__`와 일관되도록 `sym`이 실제로 base에 속하는지 검사하지 않는다 — 가정은 무시한다"는 규약을 명시했다.

## 검증 (test_patch)
- **FAIL_TO_PASS = `test_subs_CondSet`** (1개). 두 가지를 추가/수정한다.
  1. 기존 단언 `ConditionSet(n, n < x, Interval(-oo, 0)).subs(x, p) == S.EmptySet`을 `== Interval(-oo, 0)`으로 바꾼다 — `n < x`가 평가돼도 base를 EmptySet으로 붕괴시키지 않고 condition/base만 치환됨을 고정.
  2. 이슈 #17341 케이스: `img1 = imageset(Lambda(k, 2*k*pi + asin(y)), S.Integers)`로 `ConditionSet(x, Contains(y, Interval(-1,1)), img1).subs(y, S.One/3)`가 `img2`(=`asin(1/3)` 버전)와 `dummy_eq`로 같음을 단언. condition이 `S.true`가 되며 ConditionSet이 base인 ImageSet으로 자연 붕괴되어야 함을 검증.
- **픽스 증명**: 분기 제거로 바운드 변수 `self.sym`이 보존되므로 `1/3`이 dummy 자리로 새는 경로가 사라진다. condition `Contains(1/3, [-1,1])`가 true가 되면 `ConditionSet`은 상위 `__new__`/평가 규칙에 의해 base ImageSet으로 정리된다.
- **overfit/regression**: FAIL_TO_PASS가 1개로 얇지만, 픽스가 *특수분기 제거*(코드 단순화)라 special-case 통과가 아니라 일반 규약을 복원한다 — overfit 위험 낮음. 반대로 삭제한 분기가 다른 동작을 떠받쳤을 가능성에 대해선 P2P 8개(`test_CondSet`, `test_dummy_eq`, `test_contains`, `test_subs_CondSet_tebr` 등)가 가드 역할. `regression-trap` 플래그 유지.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `Out[75]`(바운드 변수 오염)와 "xreplace/simultaneous는 정상" 대비가 결정적 신호 — 일반 치환 경로(`subs`)에만 있는 분기 결함을 시사한다. `ConditionSet`의 `_eval_subs`로 직행하여 `old != sym` 경로의 `if cond is S.true: return ConditionSet(new, ...)`를 후보로 지목.
2. **픽스와 일반화**: `ConditionSet(new, Contains(new, base), base)`에서 `new`는 *치환값*이지 dummy가 아니므로 바운드 변수 의미가 깨진다. 올바른 일반화는 dummy `self.sym`을 항상 보존하는 것 — `if cond is S.true` 특수처리를 제거하고 `self.func(self.sym, cond, base)` 단일 반환으로 통일. 이는 `__new__`가 가정 기반 멤버십 검사를 하지 않는 규약과 일치하므로 over-fit이 아닌 시맨틱 복원이다.
3. **regression 안전**: `test_CondSet`/`test_dummy_eq`/`test_contains`가 깨지지 않아야 함 — 픽스는 dummy 보존만 강화하고 condition/base 치환 자체는 그대로라 정상 케이스에 영향이 없다. `Interval(-oo,0)` 단언이 EmptySet에서 Interval로 바뀐 것은 *버그였던 base 붕괴*를 바로잡은 것이므로 의도된 동작 변화.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `if cond is S.true` 분기를 *유지한 채* `new`만 `self.sym`으로 바꾸는 미봉책을 쓰기 쉬운데, 이는 가정 무시 규약과 충돌해 다른 케이스를 깬다. (b) 또는 ImageSet 쪽(`imageset`/`Lambda`)을 의심해 엉뚱한 파일을 고치기 쉽다 — 이슈가 "plain ImageSet subs는 정상"이라 명시했으므로 ConditionSet 경로로 좁혀야 한다. 정답은 분기 *제거*라는 점(코드 추가가 아니라 삭제가 픽스)이 직관에 반해 함정.
