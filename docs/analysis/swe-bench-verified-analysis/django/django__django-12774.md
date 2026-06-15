---
instance_id: django__django-12774
repo: django/django
base_commit: 67f9d076cfc1858b94f9ed6d1a5ce2327dcc8d0d
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2020-04-22T11:02:30Z
fail_to_pass: 1
pass_to_pass: 41
gold_files: [django/db/models/query.py]
---

# django__django-12774

## 문제 요약
`QuerySet.in_bulk(field_name=...)`는 지정한 필드가 `unique=True`일 때만 허용한다. 그런데 같은 필드를 `Meta.constraints`의 `UniqueConstraint`로 유니크하게 만든 경우에는, 실제로는 유니크함에도 `ValueError("in_bulk()'s field_name must be a unique field but %r isn't.")`를 던지며 거부한다. 사용자는 단일 컬럼 `UniqueConstraint`로 보장된 필드도 `in_bulk`이 받아주길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (validation) — 유니크성 판정이 `field.unique`만 보고 제약조건을 무시
- 서브시스템: django ORM query (QuerySet API)
- 증상 타입: 잘못된 예외 (정당한 호출인데 ValueError)
- 로컬라이제이션 신호: traceback이 `django/db/models/query.py`의 `in_bulk`와 정확한 에러 메시지를 직접 가리킴 → 파일/함수 특정이 매우 쉬움

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/query.py:QuerySet.in_bulk`
- 근본 원인: 유니크성 검사가 `self.model._meta.get_field(field_name).unique` 한 가지만 확인. 단일 컬럼 `UniqueConstraint`로 부여된 유니크성은 필드의 `unique` 속성에 반영되지 않으므로 누락됨.
- 수정 요지: `opts = self.model._meta`에서 `opts.total_unique_constraints`를 순회해 `len(constraint.fields) == 1`인 제약(=단일 컬럼)들의 `constraint.fields[0]`을 모아 `unique_fields` 리스트를 만든다. 거부 조건을 `field_name != 'pk' and not opts.get_field(field_name).unique and field_name not in unique_fields`로 확장. `total_unique_constraints`를 쓰므로 조건부(partial) `UniqueConstraint`나 다중 컬럼 제약은 자동 제외된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_in_bulk_meta_constraint` — `Season` 모델에 `UniqueConstraint(fields=['year'])`를 추가하고 `Season.objects.in_bulk([2011, 2012], field_name='year')`가 `{2011: season_2011, 2012: season_2012}`를 반환하는지 확인.
- 픽스 증명: 픽스 전이라면 `year`는 `unique=True`가 아니므로 ValueError. 픽스 후 단일 컬럼 제약의 필드가 `unique_fields`에 들어가 통과.
- 회귀 가드(PASS_TO_PASS의 `test_in_bulk_non_unique_meta_constaint`): partial(`condition=Q(is_active=True)`) 단일 컬럼 제약(`ean`)과 다중 컬럼 제약(`brand`,`name`)은 여전히 거부돼야 함 — `total_unique_constraints` + `len==1` 필터가 둘 다 정확히 막는지 검증.

## 공략 포인트 (뭘 조져야)
- 어디부터: traceback의 `query.py:in_bulk`와 에러 메시지 리터럴을 grep하면 즉시 도달. 단일 함수, 단일 파일 수정.
- 함정/난이도: 핵심은 "어떤 제약을 유니크로 인정할지" 경계. (1) partial UniqueConstraint(condition 있음)는 전체 행에 대한 유니크 보장이 아니므로 제외해야 하고, (2) 다중 컬럼 제약은 단일 `field_name`을 유니크하게 만들지 않으므로 제외해야 한다. `opts.unique_together`나 `opts.constraints`를 직접 뒤지면 partial 제외 로직을 직접 짜야 하지만, `total_unique_constraints` 프로퍼티가 이미 deferrable/partial을 걸러주므로 이것을 쓰는 게 정답. 이 프로퍼티의 존재를 모르면 과하거나 모자란 구현이 되기 쉽다.
- 우리 에이전트 관점: 로컬라이제이션은 쉬우나, `len(constraint.fields) == 1` 필터와 `total_unique_constraints`(vs 단순 `constraints`) 선택을 놓치면 partial/composite 케이스에서 PASS_TO_PASS 회귀 테스트가 깨진다. 즉 "통과시키기"는 쉽고 "정확히 그 범위만 통과시키기"가 난이도의 핵심.
