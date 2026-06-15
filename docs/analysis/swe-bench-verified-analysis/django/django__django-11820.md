---
instance_id: django__django-11820
repo: django/django
base_commit: c2678e49759e5c4c329bff0eeca2886267005d21
version: 3.1
difficulty: <15 min fix
created_at: 2019-09-26T08:37:14Z
fail_to_pass: 2
pass_to_pass: 61
gold_files: [django/db/models/base.py]
---

# django__django-11820

## 문제 요약
`Meta.ordering`에 관계 필드를 따라가는 `__pk` lookup(예: `option__pk`)을 넣으면 시스템 체크가 잘못된 `models.E015`("'ordering' refers to the nonexistent field, related field, or lookup ...") 오류를 발생시킨다. `pk`는 모델의 primary key 별칭으로 정상 lookup인데도 거부된다. 사용자는 `parent__pk` 같은 ordering이 에러 없이 통과되길 기대한다. 커밋 440505cb2cadbe1a5b9fba246bcde6c04f51d07e에서 들어온 회귀(regression)다.

## 유형 분류
- 버그 카테고리: regression / edge-case (validation 로직의 `pk` 별칭 누락처리)
- 서브시스템: django ORM model system checks (`Model._check_ordering`)
- 증상 타입: 잘못된 출력 (정상 모델에 대해 가짜 `E015` 체크 에러)
- 로컬라이제이션 신호: problem_statement이 정확히 `models.E015`와 회귀 커밋 해시를 지목한다. E015는 `_check_ordering`에서만 추가되므로 곧바로 `django/db/models/base.py`의 해당 메서드로 좁혀진다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/base.py` : `Model._check_ordering` (classmethod, lookup 분해 루프)
- 근본 원인: ordering 문자열을 `LOOKUP_SEP`(`__`)로 쪼개 각 part마다 `_cls._meta.get_field(part)`를 호출하는데, `pk`는 실제 필드명이 아니라 별칭이라 `get_field('pk')`가 `FieldDoesNotExist`를 던진다. 또한 관계가 아닌 필드 다음에 추가 part가 이어질 때 `_cls`가 직전 관계 모델로 남아 있어 잘못된 컨텍스트로 해석이 이어지는 문제가 있었다.
- 수정 요지: part가 `'pk'`이면 `get_field` 대신 `_cls._meta.pk`를 직접 사용하도록 분기를 추가. 그리고 해석된 `fld`가 관계(`is_relation`)가 아니면 `_cls = None`으로 끊어서, 비관계 필드 뒤에 또 lookup이 붙는 케이스(`parent__field1__field2`)는 다음 루프에서 `get_field`가 실패해 정상적으로 `E015`가 나도록 만든다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_ordering_pointing_to_related_model_pk`: `Child.Meta.ordering = ('parent__pk',)`인 모델이 `Child.check()` 결과로 빈 리스트(`[]`)를 반환해야 한다 — 더 이상 가짜 E015가 나오면 안 됨.
  - `test_ordering_pointing_multiple_times_to_model_fields`: `ordering = ('parent__field1__field2',)`처럼 비관계 필드(`field1`) 뒤에 또 part가 붙은 잘못된 lookup은 여전히 `E015`를 내야 한다.
- 테스트가 어떻게 픽스를 증명하는지: pk 별칭 케이스는 false-positive 제거(빈 결과)를 확인하고, 비관계 필드 체이닝 케이스는 `_cls = None` 끊기 로직 덕분에 정당한 에러가 유지됨을 확인한다. 즉 패치가 정상은 통과시키고 진짜 오류는 계속 잡는다는 양방향 보장을 동시에 검증한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `E015`/`'ordering' refers to` 문자열을 grep → `django/db/models/base.py`의 `_check_ordering` 단일 지점에 도달. 회귀 커밋이 명시돼 있어 `git blame`/diff로 변경된 루프를 바로 특정 가능.
- 함정/난이도 메모: 단일 파일·짧은 수정이지만 두 가지를 동시에 고쳐야 한다. (1) `pk` 별칭 처리만 추가하면 `test_ordering_pointing_multiple_times_to_model_fields`가 깨질 수 있다 — 비관계 필드 뒤 `_cls` 끊기(`else: _cls = None`)를 빠뜨리면 false-positive를 못 잡는다. `pk`만 보고 `is_relation` 분기를 무시하면 절반만 맞는 패치가 된다.
- 우리 에이전트 관점: 막힐 만한 지점은 "왜 `pk`가 `get_field`로 안 잡히나"라는 ORM 내부 별칭 지식과, 추가 part 체이닝 시 `_cls` 상태 관리. pk만 특수처리하고 끝내면 PASS_TO_PASS 회귀 테스트(`test_ordering_pointing_to_two_related_model_field` 등)나 신규 multi-field 테스트에서 잡힐 위험이 있다.
