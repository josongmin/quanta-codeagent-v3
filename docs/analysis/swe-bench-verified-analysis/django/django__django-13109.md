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
---

# django__django-13109

## 문제 요약
`ForeignKey.validate()`가 FK 값의 존재 여부를 검사할 때 대상 모델의 `_default_manager`를 사용한다. 그런데 default manager가 `get_queryset()`을 오버라이드해 일부 행을 필터링(예: `archived=False`)하면, 폼에서 `_base_manager.all()`로 queryset을 교체해 archived 객체를 허용하려 해도 모델 검증 단계에서 항상 "Select a valid choice..."로 실패한다. 사용자는 DB에 실제 존재하는 행이므로 검증을 통과하길 기대했다.

## 유형 분류
- 버그 카테고리: API-contract (검증이 잘못된 manager를 골라 정당한 값을 거부)
- 서브시스템: django ORM / model validation (related fields) + forms 연계
- 증상 타입: 잘못된 validation 실패 (silent-wrong한 에러 메시지)
- 로컬라이제이션 신호: problem_statement가 `django/db/models/fields/related.py` L917-L919를 직접 링크하고 `_default_manager` vs `_base_manager`를 명시함. 거의 핀포인트.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/related.py` : `ForeignKey.validate()`
- 근본 원인: 검증 쿼리가 `self.remote_field.model._default_manager.using(using).filter(...)`로 작성됨. default manager가 비즈니스 레벨 필터(archived 등)를 걸면 실제 존재하는 행도 "없음"으로 판정된다. FK 검증의 목적은 DB 무결성(행 존재 여부)이지 비즈니스 필터링이 아니다.
- 수정 요지: `_default_manager`를 `_base_manager`로 한 글자 교체. `_base_manager`는 커스텀 `get_queryset()` 필터를 적용하지 않으므로 행의 실제 존재 여부만 검사한다. `limit_choices_to`를 적용하는 `complex_filter` 라인은 그대로 두어 폼 레벨 제약은 유지.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `validation.tests.BaseModelValidationTests.test_FK_validates_using_base_manager`: `AuthorManager`(archived 제외)를 가진 `Author`를 archived=True로 생성 후 `Article(author=author).full_clean()`이 `None`(검증 통과)을 반환하는지 확인.
  - `model_forms.tests.ModelFormBasicTests.test_validate_foreign_key_to_model_with_overridden_manager`: 폼에서 `self.fields['writer'].queryset = Writer._base_manager.all()`로 교체 후 archived writer를 선택하면 `is_valid()`가 True가 되고 `form.save()`로 article이 저장되는지 확인.
- 또한 회귀 방지로 `test_validate_foreign_key_uses_default_manager`(PASS_TO_PASS)가 추가됨: 폼이 queryset을 교체하지 않으면 default manager의 필터가 폼 레벨에서 여전히 archived를 막아 검증 실패하는지 보장. 즉 base_manager 전환이 폼 choice 검증까지 느슨하게 만들지 않음을 증명.
- 재현 입력 → 기대 출력: archived 객체 pk를 FK로 넘김 → 패치 전 검증 실패, 패치 후 모델 검증 통과(폼은 queryset에 따라 분기).

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement에 파일+라인+심볼이 다 박혀 있어 `related.py`의 `ForeignKey.validate`만 열면 됨. `_default_manager` 사용 지점을 찾는다.
- 함정/난이도 메모: 같은 함수 내 `complex_filter(self.get_limit_choices_to())`까지 건드리면 안 됨 — limit_choices_to는 의도된 폼 제약이라 유지해야 한다. 또 default→base 전환이 "검증 무력화"처럼 보일 수 있으나, 핵심은 DB 무결성 vs 비즈니스 필터 분리(hints의 "avoiding DB errors, not business logic errors"). 멀티파일 아님(소스 1파일).
- 우리 에이전트 관점: 난이도는 낮지만, "검증을 느슨하게 하는 게 맞나?"라는 의심으로 과교정(예: base/default 분기 조건 추가)할 위험. 정답은 1라인 치환. 오히려 회귀 테스트(default manager 경로는 폼에서 여전히 막아야 함)를 이해하지 못하면 폼 레이어까지 손대 PASS_TO_PASS를 깰 수 있다.
