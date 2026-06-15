---
instance_id: django__django-12663
repo: django/django
base_commit: fa5e7e46d875d4143510944f19d79df7b1739bab
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2020-04-04T18:58:49Z
fail_to_pass: 1
pass_to_pass: 135
gold_files: [django/db/models/sql/query.py]
---

# django__django-12663

## 문제 요약
중첩된 Subquery 어노테이션을 `filter()`에 `SimpleLazyObject`(예: `request.user` 같은 지연 모델 인스턴스)와 함께 쓰면 `TypeError: int() argument must be ... not 'SimpleLazyObject'`로 깨진다. 커밋 35431298 이전에는 동작했으므로 회귀(regression)다. 사용자는 `.filter(user=request.user)`처럼 lazy 객체가 FK 룩업에서 자동으로 모델 인스턴스로 변환되길 기대했다.

## 유형 분류
- 버그 카테고리: regression (FK 룩업의 lazy→instance 변환이 깨진 logic 버그)
- 서브시스템: django ORM query / Subquery·OuterRef 표현식의 output_field 해석
- 증상 타입: 예외 (TypeError, get_prep_value에서 int() 변환 실패)
- 로컬라이제이션 신호: traceback이 `sql/query.py`의 `build_lookup` → `lookups.py`의 `get_prep_lookup` → `self.lhs.output_field`를 가리키고, hints가 `Query.output_field`의 `self.select[0].field`(L235-236) 줄을 직접 지목한다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py` : `Query.output_field` (property)
- 근본 원인: select가 단일 컬럼일 때 `output_field`로 `self.select[0].field`를 반환했다. `Col.field`는 `Expression.field`(= `output_field`의 별칭)이며 일반 필드를 돌려준다. FK를 가리키는 경우라도 일반 IntegerField류로 취급되어, 룩업이 RHS(SimpleLazyObject)를 정수로 강제 변환하려다 실패한다. lazy 객체를 모델 인스턴스로 풀어주는 related-field 룩업 변환은 `Col.target`(실제 대상 필드, 즉 ForeignKey)에서만 동작한다.
- 수정 요지: `self.select[0].field` 대신 `getattr(select, 'target', None) or select.field`를 반환하도록 변경. select 원소가 `target` 속성(Col)을 가지면 그 target(진짜 FK 필드)을 output_field로 쓰고, 없으면 기존 `.field`로 폴백한다. 이로써 외곽 filter가 FK 룩업으로 인식되어 SimpleLazyObject가 모델 인스턴스로 변환된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_subquery_filter_by_lazy (expressions.tests.BasicExpressionsTests)`
- 테스트가 어떻게 픽스를 증명하는지: `tests/expressions/models.py`에 `Manager` 모델과 `Employee.manager` FK를 추가한다. 테스트는 `Employee.objects.filter(lastname=OuterRef('ceo__lastname')).values('manager')`로 FK 컬럼을 select하는 Subquery를 만들고, RHS로 `SimpleLazyObject(lambda: Manager.objects.get(...))`를 넘겨 `Company`를 `.filter(ceo_manager=max_manager)`로 거른다. 픽스 전이면 `output_field`가 일반 필드라 lazy를 int로 변환하다 TypeError가 났지만, 픽스 후엔 `Col.target`(FK)이 output_field가 되어 lazy가 인스턴스로 풀리고 `qs.get() == self.gmbh`가 성립한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback 최하단의 `output_field` 접근부터 역추적. `int(value)`가 SimpleLazyObject를 못 받는다는 메시지 → lhs의 output_field가 잘못된 타입(FK가 아니라 정수 필드)이라는 의미. `Query.output_field` property가 단일 진앙.
- 함정/난이도: 핵심은 `Col.field`와 `Col.target`의 미묘한 차이다. `field`는 output_field 별칭(표현식 결과 타입)이고 `target`이 실제 참조 필드(FK)다. 이 구분을 모르면 lookups.py나 fields/__init__.py의 `get_prep_value`를 고치려는 잘못된 곳으로 새기 쉽다. 멀티파일 아님 — 프로덕션 수정은 한 줄.
- 우리 에이전트 관점: SimpleLazyObject가 비공개 API라 재현 테스트를 직접 짜기 어렵고(힌트가 제공), `field` vs `target` 구분이 도메인 지식이라 패치 위치는 맞춰도 "왜 target인가"를 놓치면 폴백(`or select.field`) 없이 `.target`만 써서 비-Col select(annotation, aggregate)를 깨뜨릴 위험. 132개 PASS_TO_PASS 회귀를 통과하려면 `getattr(... 'target', None) or` 폴백이 필수다.
