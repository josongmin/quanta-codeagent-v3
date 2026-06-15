---
instance_id: django__django-16333
repo: django/django
base_commit: 60a7bd89860e504c0c33b02c78edcac87f6d1b5a
version: 4.2
difficulty: <15 min fix
created_at: 2022-11-27T20:09:15Z
fail_to_pass: 1
pass_to_pass: 87
gold_files: [django/contrib/auth/forms.py]
---

# django__django-16333

## 문제 요약
`contrib.auth.forms.UserCreationForm`을 ManyToManyField를 가진 커스텀 User 모델과 함께 쓰면, M2M 폼 필드(예: `ModelMultipleChoiceField`)에 입력한 데이터가 저장되지 않는다. 사용자는 `form.save(commit=True)` 호출 후 M2M 관계가 DB에 반영되기를 기대하지만, 부모 `ModelForm`과 달리 `UserCreationForm.save()`가 `self.save_m2m()`을 호출하지 않아 silent하게 누락된다.

## 유형 분류
- 버그 카테고리: 누락처리 (오버라이드한 save가 부모의 필수 후처리 단계를 빠뜨림)
- 서브시스템: django forms / contrib.auth (UserCreationForm)
- 증상 타입: silent-wrong (예외 없이 M2M 데이터가 조용히 유실)
- 로컬라이제이션 신호: problem_statement가 정확히 `UserCreationForm.save(commit=True)`와 `self.save_m2m()` 누락을 지목함. 파일은 `django/contrib/auth/forms.py`로 바로 특정 가능.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/auth/forms.py` : `UserCreationForm.save`
- 근본 원인: `UserCreationForm`이 `ModelForm.save`를 오버라이드해 password 설정 로직을 추가하면서, `commit=True`일 때 `ModelForm`이 수행하던 deferred M2M 저장(`save_m2m`) 호출을 빠뜨림. `ModelForm.save`는 `commit=False`일 때 인스턴스에 `save_m2m` 콜러블을 붙여두고 `commit=True`면 즉시 호출하는데, 오버라이드 버전은 `user.save()`만 부르고 끝냈다.
- 수정 요지: `commit` 블록 안에서 `user.save()` 직후 `if hasattr(self, "save_m2m"): self.save_m2m()`를 추가. `save_m2m`은 폼에 M2M 필드가 있을 때만 존재하므로 `hasattr` 가드로 무해하게 처리. M2M 필드가 없는 기존 사용처는 동작 변화 없음.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_custom_form_saves_many_to_many_field` — M2M 필드(`orgs`)를 포함한 커스텀 `UserCreationForm`이 저장 시 M2M 데이터를 실제로 반영하는지 검사.
- 증명 방식: 새 fixture 모델 `CustomUserWithM2M`/`Organization`(`tests/auth_tests/models/with_many_to_many.py`)을 import해, `fields`에 `"orgs"`를 추가한 폼을 만든다. `Organization` 1개 생성 후 `orgs=[str(pk)]`로 폼을 valid 검증하고 `form.save(commit=True)` 실행. 마지막에 `assertSequenceEqual(user.orgs.all(), [organization])`로 M2M 관계가 DB에 저장됐음을 확인. 픽스 전이면 `user.orgs.all()`가 비어 있어 실패.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 함수와 누락 호출까지 명시하므로 `forms.py`의 `UserCreationForm.save`만 열어 부모 `ModelForm.save`와 diff하면 끝. `save_m2m` grep으로 `forms/models.py`의 정상 패턴을 대조 확인.
- 함정/난이도 메모: `save_m2m`은 `commit=False` 경로에서만 인스턴스에 attach되므로 무조건 호출하면 AttributeError 위험 → `hasattr` 가드 또는 commit 분기 안 배치가 필수. 단일 파일·2줄 추가라 멀티파일 아님. 단, 검증 테스트는 신규 fixture 모델 파일도 필요(에이전트가 테스트까지 작성한다면).
- 우리 에이전트 관점: 이슈가 답을 거의 다 줘서 막힐 여지가 적음. 다만 `hasattr` 가드 없이 `self.save_m2m()`만 추가하면 M2M 없는 폼에서 회귀(PASS_TO_PASS의 다수 `UserCreationFormTest`가 깨짐) — 가드 누락이 유일한 함정.
