---
instance_id: django__django-13568
repo: django/django
base_commit: ede9fac75807fe5810df66280a60e7068cc97e4a
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-10-19T15:20:08Z
fail_to_pass: 1
pass_to_pass: 13
gold_files: [django/contrib/auth/checks.py]
---

# django__django-13568

## 문제 요약
`USERNAME_FIELD`로 지정한 필드의 유일성을 `unique=True` 대신 `Meta.constraints`의 `UniqueConstraint(fields=["username"])`로 보장해도, 시스템 체크가 무조건 `auth.E003`("must be unique...") 에러를 띄운다. PostgreSQL에서 CharField/TextField에 `unique=True`를 쓰면 불필요한 암묵적 `*_like` 인덱스가 생기므로 `UniqueConstraint`를 선호하는 경우가 있는데, 체크가 이 합법적 패턴을 인식하지 못하는 게 문제다. 사용자는 모델 레벨 unique constraint가 있으면 E003을 건너뛰길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (validation 체크가 한 가지 유일성 표현 방식만 인지)
- 서브시스템: django.contrib.auth 시스템 체크 (system checks framework)
- 증상 타입: 잘못된 출력 (false-positive 검사 에러/경고)
- 로컬라이제이션 신호: `auth.E003`, "USERNAME_FIELD", "must be unique"라는 정확한 에러 ID/문구가 `django/contrib/auth/checks.py`의 `check_user_model`로 바로 연결됨

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/auth/checks.py:check_user_model`
- 근본 원인: username 유일성 판정이 `cls._meta.get_field(USERNAME_FIELD).unique` 한 줄에만 의존. 필드 수준 `unique=True`만 보고, 모델 메타에 선언된 `UniqueConstraint`는 전혀 고려하지 않았다.
- 수정 요지: unique 분기 조건에 보조 항을 AND로 추가. 필드가 unique가 아니어도 `cls._meta.total_unique_constraints` 중 `constraint.fields == (cls.USERNAME_FIELD,)`인 것이 하나라도 있으면 에러/경고를 건너뛴다. `total_unique_constraints`를 쓰는 게 핵심 — 이 프로퍼티는 조건부(`condition`이 있는 partial) constraint를 제외한 "전체(total)" unique constraint만 반환하므로, partial unique는 여전히 유일성 보장이 안 돼 E003이 유지된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_username_unique_with_model_constraint` — `UniqueConstraint(fields=['username'], name='username_unique')`(무조건 unique)만 가진 `CustomUserUniqueConstraint` 모델에서 기본 백엔드/커스텀 백엔드 양쪽 모두 `run_checks` 결과가 빈 리스트여야 한다.
- 증명 방식: 픽스 전에는 `unique=True`가 없어 무조건 E003이 났지만, 픽스 후 `total_unique_constraints`에 `(username,)` constraint가 잡혀 에러가 사라짐을 빈 리스트로 확인.
- 추가 회귀 테스트 `test_username_partially_unique`(PASS_TO_PASS): `condition=Q(password__isnull=False)`인 partial constraint는 `total_unique_constraints`에서 빠지므로 여전히 E003(기본 백엔드)/W004(커스텀 백엔드)가 나와야 함 — `total_` 프로퍼티 선택이 옳았음을 보장하는 음성 케이스.

## 공략 포인트 (뭘 조져야)
- localization 전략: 에러 ID `auth.E003`로 grep → `django/contrib/auth/checks.py`의 `check_user_model` 단일 함수. 단일 파일 단일 분기 수정이라 위치 잡기는 쉬움.
- 함정/난이도 메모:
  - `cls._meta.unique_constraints` vs `cls._meta.total_unique_constraints` 구분이 핵심 난이도. partial(조건부) constraint는 유일성을 보장하지 못하므로 `total_`을 써야 한다. 일반 `unique_constraints`나 `constraints`를 그냥 순회하면 partial 케이스가 잘못 통과되어 `test_username_partially_unique`가 깨진다.
  - `constraint.fields == (cls.USERNAME_FIELD,)` — 비교 대상이 단일 원소 튜플이라는 점(리스트 아님), 그리고 username만 단독으로 unique여야지 다중 필드 복합 constraint는 username 유일성을 보장 안 한다는 점.
- 우리 에이전트 관점: 한 줄짜리로 보여 `unique=True` 분기에 단순히 `or has constraint`를 넣고 끝낼 위험. partial unique constraint 의미론을 모르면 `total_unique_constraints` 대신 일반 constraints 순회를 써서 partial 케이스 회귀를 놓치기 쉽다. `total_unique_constraints` 프로퍼티의 존재 자체를 알아야 정답에 도달.
