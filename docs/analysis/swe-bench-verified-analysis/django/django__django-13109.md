---
instance_id: django__django-13109
repo: django/django
base_commit: fbe82f82555bc25dccb476c749ca062f0b522be3
version: 3.2
difficulty: <15 min fix
created_at: 2020-06-25T08:36:45Z
fail_to_pass: 2
pass_to_pass: 170
gold_files: [django/db/models/fields/related.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [regression-trap, underspecified]
---

# django__django-13109

## 문제 요약
`ForeignKey.validate()`가 FK 값의 존재 여부를 검사할 때 대상 모델의 `_default_manager`를 사용한다. default manager가 `get_queryset()`을 오버라이드해 일부 행을 필터링(예: `archived=False`)하면, 폼에서 `self.fields['article'].queryset = Article._base_manager.all()`로 queryset을 교체해 archived 객체를 허용하려 해도 모델 검증 단계에서 항상 "Select a valid choice. That choice is not one of the available choices."로 실패한다. 사용자 입장에선 DB에 실제 존재하는 행이므로 검증을 통과하길 기대했다. hints에서 maintainer가 정리했듯, FK 검증의 역할은 "DB 에러(행 존재 여부)를 막는 것이지 비즈니스 로직(archived 여부)을 막는 것이 아니다" — 후자는 폼 레이어의 책임이다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 `django/db/models/fields/related.py`의 L917-L919를 직접 링크하고 `_default_manager` vs `_base_manager`를 명시. grep 한 방으로 `ForeignKey.validate` 도달. cross-file 추적 불필요 — 소스 수정은 정확히 1파일 1심볼.
- **S (Repair Strategy) = S1 Direct-Map (+S5 Spec-Inference)**: 픽스 자체는 `_default_manager` → `_base_manager` 한 토큰 치환으로 완전히 기계적(S1). 다만 "왜 그게 옳은가"는 코드만으론 결정 안 되고 — 둘 다 syntactically valid — 이슈 본문/hints/django의 manager 계약("base_manager는 default 필터를 적용하지 않는다")에서 **의도된 스펙을 재구성**해야 정당화된다(S5 보조). 그래서 S1이 dominant, S5가 보조.
- **K (Knowledge) = K-Domain**: `_default_manager`와 `_base_manager`의 의미 차이, manager의 `get_queryset()` 오버라이드가 FK 검증 쿼리에 전파되는 메커니즘, "DB 무결성 vs 비즈니스 필터" 분리 원칙은 django ORM 내부 도메인지식. 일반 파이썬 추론으론 어느 쪽이 맞는지 못 가린다.
- **Primary type = T-DomainBound**: 위치는 L0로 자명하고 픽스도 1토큰이라 표면적으론 T-DirectMap처럼 보이나, 진짜 병목은 "두 manager 중 무엇이 검증의 올바른 의미적 계약인가"라는 **프레임워크 도메인 판단**에 있다. localize도 픽스 mechanics도 trivial이라 T-LocTrivial/T-DirectMap이 아니라, K-Domain이 dominant 난점인 T-DomainBound가 정확하다.
- 왜 이 strategy인가 (APR 관점): 결함이 "잘못된 심볼 1개"라는 정형 클래스(wrong-manager-selection)에 템플릿 매칭되므로 PAR/TBar류 single-token replacement(S1)로 즉시 표현된다. 하지만 plausible 후보가 `_default_manager`/`_base_manager` 둘로 갈리고 테스트가 후자만 정답으로 만들기 때문에, 후보 선택의 근거를 generate-&-validate(S3)나 시행착오가 아닌 **명세 재구성(S5)**으로 잡아야 overfit 없이 옳게 수렴한다.

## 난이도 티어
**T3 (중간)** — 공식 라벨은 `<15 min fix`(개발자 구현시간 최단), prior로는 T1~T2를 가리킨다. 그러나 에이전트 난이도 축으로 재조정하면 T3가 맞다:
- T1/T2로 미는 피처: L0 핀포인트 localize, 1파일·1줄 패치(`<5줄` 컷), single-hunk.
- T3로 끌어올리는 피처: (1) **K-Domain 판단이 본질** — manager 시맨틱을 모르면 "검증을 느슨하게 하는 게 맞나?"에서 막힘. (2) **underspecified** — 코드만 보면 두 manager 중 무엇이 옳은지 결정 불가, 이슈/hints의 스펙 재구성 필요. (3) **regression-trap** — P2P 170개가 광범위하고, 특히 `test_validate_foreign_key_uses_default_manager`·`test_limited_FK_raises_error`처럼 "여전히 막아야 하는" 인접 동작이 P2P에 박혀 있어 과교정 시 즉시 깨진다.
- has-repro는 없음(네이티브 스택트레이스/실행 가능한 repro 코드 부재, 의사코드 모델만 제시)이라 T1의 "픽스를 거의 적어줌" 프로파일에 못 미친다. 공식 시간라벨이 짧은 건 "정답을 아는 maintainer가 손으로 칠 시간"이지, 에이전트가 manager 시맨틱+회귀경계를 추론하는 비용을 반영하지 않는다. → 그래서 공식 라벨보다 한 단계 위인 T3.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/fields/related.py` → `ForeignKey.validate(self, value, model_instance)`.
- **근본 원인**: 검증 쿼리가 `self.remote_field.model._default_manager.using(using).filter(**{self.remote_field.field_name: value})`로 작성됨. default manager가 비즈니스 필터(`archived=False` 등)를 `get_queryset()`에 걸면, FK가 가리키는 행이 DB에 실제 존재해도 이 쿼리 결과에서 빠져 "존재하지 않음"으로 오판된다. FK 검증의 목적은 referential integrity(행 존재) 검사이지 비즈니스 가시성 필터링이 아닌데, default manager를 쓰면서 두 책임이 뒤섞였다.
- **수정 요지**: 단 한 줄, `_default_manager` → `_base_manager`. `_base_manager`는 커스텀 `get_queryset()` 필터를 적용하지 않으므로(django 계약상 "uncustomized" manager) 행의 실제 존재 여부만 본다. 바로 다음 줄 `qs = qs.complex_filter(self.get_limit_choices_to())`는 **건드리지 않는다** — `limit_choices_to`는 의도된 명시적 FK 제약이라 검증에 계속 적용되어야 한다. 즉 "비즈니스 default 필터는 제거, 명시적 FK 제약은 유지"라는 정밀한 경계 조정.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `validation.tests.BaseModelValidationTests.test_FK_validates_using_base_manager`: `AuthorManager`(archived 제외)를 가진 `Author`를 `archived=True`로 생성 후 `Article(title='My Article', author=author).full_clean()`이 `None`(검증 통과)을 반환하는지 단언. 패치 전엔 default manager가 author를 숨겨 검증 실패 → 패치 후 base manager로 통과.
  - `model_forms.tests.ModelFormBasicTests.test_validate_foreign_key_to_model_with_overridden_manager`: 폼 `__init__`에서 `self.fields['writer'].queryset = Writer._base_manager.all()`로 교체 후 archived writer 선택 시 `is_valid()`가 True가 되고 `form.save()`로 article이 저장되며 `article.writer == w`인지 확인. 모델 검증과 폼 검증이 둘 다 base manager 경로로 통과해야 성립.
- **픽스 증명**: 두 테스트 모두 "archived(=default manager에서 숨겨진) 행을 FK로 넘김"이라는 동일 트리거. 패치 전엔 `_default_manager` 필터가 행을 누락시켜 ValidationError, 패치 후 `_base_manager`가 행을 보존해 통과. 두 토큰 중 정답을 base로 못 박는 차별 입력.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇지만 special-case 통과는 불가능 — 픽스가 1토큰 치환이라 "테스트만 통과시키는 우회 분기"를 끼울 여지가 구조적으로 없다(overfit-risk 플래그 미부여). 단 S4(CEGIS)식 과소명세는 아님: 정답 일반화가 토큰 치환으로 강제됨.
- **regression 관점 (flags: regression-trap)**: test_patch가 회귀 가드를 명시 추가 — `model_forms.tests.ModelFormBasicTests.test_validate_foreign_key_uses_default_manager`(P2P)는 폼이 queryset을 교체하지 **않으면** default manager 필터가 폼 choice 레벨에서 여전히 archived를 막아 검증 실패하는지 보장한다. 즉 base manager 전환이 폼 choice 검증까지 느슨하게 만들지 않음을 증명. 추가로 P2P의 `test_limited_FK_raises_error`·`test_wrong_FK_value_raises_error`는 limit_choices_to 제약과 진짜 존재하지 않는 FK 거부가 유지되는지 잡는다 → `complex_filter` 라인을 건드리면 즉시 RED.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 파일+라인(`related.py` L917-L919)+심볼(`_default_manager`)을 직접 박아줌. `ForeignKey.validate`만 열어 `_default_manager.using(using).filter(...)` 라인을 찾으면 끝(L0). 다른 후보 탐색 불필요.
2. **픽스와 일반화 정당성**: `_default_manager` → `_base_manager` 한 토큰 치환. 이게 overfit이 아니라 올바른 일반화인 이유 — FK 검증의 불변식은 "참조 무결성(행이 DB에 존재하는가)"이고, default manager의 `get_queryset()` 오버라이드는 임의의 비즈니스 가시성 필터다. 무결성 검사에 비즈니스 필터를 섞는 것 자체가 결함이므로, base manager로 바꾸는 건 특정 테스트가 아니라 "모든 커스텀 default-manager 모델"에 대해 옳다. limit_choices_to는 명시적 FK 제약이라 `complex_filter` 라인은 그대로 둬 의도된 제약을 보존.
3. **regression 안전**: 깨지 말아야 할 P2P — (a) `test_validate_foreign_key_uses_default_manager`: queryset 미교체 폼은 여전히 archived를 막아야 함(폼 choice 검증은 별개 레이어이므로 base 전환과 독립, 그래서 안전). (b) `test_limited_FK_raises_error`·`test_wrong_FK_value_raises_error`: limit_choices_to와 진짜 부재 FK 거부 유지 → `complex_filter`/존재성 검사 자체는 손대지 않으므로 안전. base manager는 필터만 안 걸 뿐 존재하지 않는 pk엔 여전히 빈 결과 → ValidationError 정상.
4. **함정 회피**: 오라클 없는 에이전트의 오답 지점 — (1) "검증을 느슨하게 하면 진짜 잘못된 FK도 통과하는 것 아닌가"라는 과교정 의심으로 `if/else`로 base/default를 분기하거나 limit_choices_to 로직을 손댐 → P2P 회귀. 방어: base manager도 존재성 검사는 그대로라 무결성은 안 깨짐을 이해. (2) 결함을 forms 레이어(`ModelChoiceField`)에서 고치려는 오인 → hints가 명시("change here is ORM rather than forms per se"). 방어: 검증 책임이 모델 레이어(`ForeignKey.validate`)에 있음을 스펙에서 확정. (3) `complex_filter` 라인까지 base 관련으로 함께 수정 → limit_choices_to 제약 소실. 방어: 수정은 manager 선택 1토큰으로 최소화.
