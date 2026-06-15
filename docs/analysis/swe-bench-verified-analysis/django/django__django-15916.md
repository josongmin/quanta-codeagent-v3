---
instance_id: django__django-15916
repo: django/django
base_commit: 88e67a54b7ed0210c11523a337b498aadb2f5187
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-08-04T18:59:18Z
fail_to_pass: 2
pass_to_pass: 149
gold_files: [django/forms/models.py]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-15916

## 문제 요약
`ModelForm`의 `Meta`에 `formfield_callback`을 지정해도 `modelform_factory`로 폼을 파생시키면 그 콜백이 무시된다. `modelform_factory`는 `formfield_callback` 키워드 인자를 받지만, 호출자가 명시적으로 넘기지 않으면 베이스 폼의 `Meta.formfield_callback`을 상속하는 게 아니라 `None`(콜백 없음)으로 덮어쓴다. 사용자는 다른 `Meta` 옵션들(`widgets`, `labels`, `error_messages` 등)과 일관되게 베이스 폼의 콜백이 상속되어 파생 폼·재서브클래스에서도 필드가 동일하게 가공되길 기대한다. 이슈는 기능 요청으로 재분류되었으나("never documented"), 메인테이너는 "다른 Meta 옵션과의 일관성"을 위해 지원하기로 결정했다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: problem_statement가 `django.forms.modelform_factory`와 `formfield_callback`을 직접 지목한다. 거의 L0이지만, 진짜 고쳐야 할 지점이 명명된 함수 하나가 아니라 같은 파일 안의 `ModelFormOptions.__init__` / `ModelFormMetaclass.__new__` / `modelform_factory` **3개 협응 지점**이라 grep 한 방으로 끝나지 않고 데이터플로우(콜백이 attrs로 흐르는가 Meta로 흐르는가)를 따라가야 해서 L1.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning)**: 한 줄 가드 추가가 아니라 `formfield_callback`을 **정식 Meta 옵션으로 승격**하는 작은 구조 변경이다. 콜백의 단일 소스(SSOT)를 `attrs` 경로에서 `ModelFormOptions` 경로로 **이동**시키고, 그에 맞춰 3개 호출 지점을 재배치해야 한다(collect-then-process 성격). 보조로 S2가 붙는 이유: 단순히 옵션을 추가만 하면 안 되고, factory가 `form_class_attrs`에 콜백을 더 이상 넣지 않아도 베이스 폼 Meta를 통해 정확히 전파된다는 불변식("콜백은 Meta 한 경로로만 흐른다")을 추론으로 보장해야 한다. APR 관점에서 template 매칭(S1)으로는 풀리지 않는다 — 정형 결함클래스(None-guard/off-by-one)가 아니라 옵션 lifecycle을 재배치하는 design 변경이기 때문.
- **K (Knowledge) = K-Domain**: django forms 내부의 `ModelFormMetaclass`/`DeclarativeFieldsMetaclass` 메타클래스 머신, `ModelFormOptions`가 `Meta`를 흡수하는 방식, `fields_for_model(formfield_callback=...)` 계약, 메타클래스가 `attrs`에서 키를 pop하는 관례를 알아야 올바른 위치로 끌어올릴 수 있다. 일반 파이썬 추론(K-Gen)만으로는 "Meta 옵션 체계"라는 정답 구조를 떠올리기 어렵다.
- **primary type = T-DesignRefactor**: dominant 신호가 S6(조율된 구조 변경)다. 위치는 비교적 명확(L1)하고 도메인 지식(K-Domain)도 들지만, 난점의 본질은 "콜백 보유 위치를 attrs→Meta로 옮기고 3지점을 함께 바꾸는 리팩토링"이라 T-DesignRefactor로 라벨.

## 난이도 티어
**T4 (약간 어려움).**
- 이 티어로 미는 구조적 피처: (1) **단일 파일**(`django/forms/models.py`)이지만 한 함수가 아니라 **3개 협응 지점**을 일관되게 바꿔야 함(S6 멀티헌크). (2) **K-Domain** — 메타클래스/ModelFormOptions 내부지식 필요. (3) **넓은 P2P trap** — PASS_TO_PASS 149개, 그중 `A custom formfield_callback is used if provided`, `test_inherit_after_custom_callback`, `test_bad_callback`처럼 **기존 콜백 동작을 직접 검사**하는 인접 테스트가 있어 회귀 위험이 실재한다. (4) localize는 직접적(L1)이고 repro 예제도 본문에 있어 T5까지 가지는 않음.
- **공식 difficulty 라벨("15 min - 1 hour")과의 정합**: 대체로 일치(T3~T4 경계). 다만 공식 라벨은 "개발자 구현시간"이라 **광범위 P2P trap과 '한 줄 fallback으로 때우려는 유혹'**(아래 함정)을 못 잡는다. 에이전트 관점에서는 최소 변경 충동이 오답으로 수렴하기 쉬워 시간라벨보다 약간 높은 T4가 적절하다.

## 골드패치 분석
- **건드린 파일·함수** (모두 `django/forms/models.py`):
  - `ModelFormOptions.__init__` — `self.formfield_callback = getattr(options, "formfield_callback", None)` 한 줄 추가. 다른 Meta 옵션(`widgets`/`labels`/`field_classes` 등)과 동일한 패턴으로 콜백을 흡수.
  - `ModelFormMetaclass.__new__` — `bases`를 순회하며 `b.Meta.formfield_callback`을 찾던 `base_formfield_callback` 루프와 `formfield_callback = attrs.pop("formfield_callback", base_formfield_callback)` 라인을 **삭제**. `fields_for_model(...)` 호출 인자를 지역변수 `formfield_callback`에서 `opts.formfield_callback`으로 교체.
  - `modelform_factory` — `form_class_attrs = {"Meta": Meta, "formfield_callback": formfield_callback}`에서 `"formfield_callback"` 키를 빼 `{"Meta": Meta}`만 남김.
- **근본 원인**: `formfield_callback`이 클래스 속성(`attrs`)으로만 다뤄지고 정식 `Meta` 옵션 체계(`ModelFormOptions`)에 편입되지 않았다. 그래서 메타클래스는 bases를 ad-hoc하게 뒤져 콜백을 찾았고, factory는 명시 인자가 없으면 베이스 폼 Meta의 콜백을 회수할 경로가 없어 `None`으로 덮였다.
- **수정 요지**: 콜백을 **정식 Meta 옵션으로 승격**해 보유 위치를 `attrs`→`ModelFormOptions`로 이동. 메타클래스는 `opts.formfield_callback`을 **단일 소스**로 사용하고, factory는 콜백을 별도 클래스 속성으로 더 이상 주입하지 않는다. 결과적으로 콜백이 `Meta`를 통해 다른 옵션과 동일하게 자연 상속·전파된다(베이스 폼 → factory 파생 → 재서브클래스까지).

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**:
  - `test_custom_callback_in_meta` — `Meta`에만 `formfield_callback=callback`을 둔 `ModelForm`을 정의했을 때 모든 `base_fields`의 위젯이 콜백이 반환한 `forms.Textarea`인지 확인. (기존엔 메타클래스가 attrs만 봤으므로 Meta-only 선언이 적용 안 됨.)
  - `test_custom_callback_from_base_form_meta` — `Meta`에 콜백을 둔 `BaseForm`을 `modelform_factory(model=Person, form=BaseForm)`로 파생하고, 다시 `InheritedForm(NewForm)`으로 서브클래싱했을 때 `NewForm`과 `InheritedForm`의 모든 필드 위젯이 `Textarea`로 상속되는지 확인.
- **픽스 증명**: 콜백이 모든 필드를 `CharField(widget=Textarea)`로 강제한다. 수정 전이면 factory/Meta 경로에서 콜백이 `None`으로 덮여 기본 위젯이 나오므로 `assertEqual(type(field.widget), forms.Textarea)`가 실패. 수정 후 `opts.formfield_callback`이 단일 소스라 콜백이 전파되어 통과.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇아 보이지만, 두 테스트가 **(a) Meta-only 직접선언 경로**와 **(b) factory→재서브클래스 상속 경로** 두 직교 시나리오를 커버해 special-case 패치로는 둘 다 통과시키기 어렵다. overfit-risk는 낮은 편이라 플래그에 넣지 않았다.
- **regression 관점**: PASS_TO_PASS의 `A custom formfield_callback is used if provided`(factory 명시 인자 경로), `test_inherit_after_custom_callback`, `test_bad_callback`이 **기존 콜백 동작을 직접 검사**한다. attrs 경로를 잘못 제거하거나 두 경로로 중복 전달하면 이들이 깨진다 → regression-trap.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 직접 신호 `modelform_factory` + `formfield_callback` → `django/forms/models.py`로 직행. 단, 한 함수만 보지 말고 `grep -n formfield_callback django/forms/models.py`로 **3개 사용처**(`ModelFormMetaclass.__new__`의 bases 루프, `modelform_factory`의 `form_class_attrs`, `fields_for_model(...)` 호출 인자)를 한꺼번에 잡는다. 동시에 `ModelFormOptions.__init__`가 `widgets`/`labels` 등 Meta 옵션을 `getattr(options, ...)`로 모으는 SSOT임을 인지하는 게 핵심 — 이게 정답 구조의 단서다.
2. **픽스와 왜 올바른 일반화인가**: `formfield_callback`을 `ModelFormOptions`에 한 줄 추가해 **정식 Meta 옵션으로 승격**하고, 메타클래스/factory가 `opts.formfield_callback`을 **단일 소스**로 쓰게 통일한다. 이게 overfit이 아니라 올바른 일반화인 이유: 콜백을 다른 모든 Meta 옵션과 동일한 lifecycle에 올림으로써, Meta-only 선언·factory 파생·재서브클래스 상속이 **별도 특수처리 없이** 한 메커니즘으로 일관되게 동작한다(테스트가 검사하는 두 경로를 우연이 아니라 구조적으로 만족).
3. **regression 안전**: `A custom formfield_callback is used if provided`(factory에 콜백을 **명시**로 넘기는 경로)와 `test_bad_callback`, `test_inherit_after_custom_callback`을 깨면 안 된다. factory가 `form_class_attrs`에서 콜백 키를 빼되, factory의 `formfield_callback` 파라미터 자체는 남아 `Meta`로 흘러들어가는 기존 명시-인자 경로가 유지되어야 한다. attrs 경로를 지웠으면 Meta 경로가 그 자리를 **완전히** 대체하는지(누락 없음·중복 없음) 확인.
4. **함정 회피**: 오라클 없는 에이전트가 가장 빠지기 쉬운 함정은 **최소 변경 유혹** — 메타클래스의 bases 루프에 "Meta도 보라"는 fallback 한 줄만 추가하는 것. 이러면 콜백이 `attrs`와 `Meta` **두 경로로 중복 전달**되어 `test_inherit_after_custom_callback` 같은 인접 회귀와 충돌하거나, 반대로 bases 루프만 지우고 `ModelFormOptions` 추가를 빠뜨리면 콜백이 **완전히 사라져** factory 명시-인자 테스트가 깨진다. 정답은 "한 줄 가드"가 아니라 "옵션 보유 위치를 attrs→Meta로 옮기는 구조 이동"이라는 점을 인지하고, 3지점을 **함께** 바꾼 뒤 콜백이 단일 경로로만 흐르는지 검증하는 것이다.
