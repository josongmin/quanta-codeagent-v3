---
instance_id: django__django-13033
repo: django/django
base_commit: a59de6e89e8dc1f3e71c9a5a5bbceb373ea5247e
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-06-07T14:52:19Z
fail_to_pass: 1
pass_to_pass: 26
gold_files: [django/db/models/sql/compiler.py]
---

# django__django-13033

## 문제 요약
자기참조(self-referential) ForeignKey를 따라 `order_by("record__root_id")`처럼 `_id` 컬럼으로 정렬하면, ORM이 명시한 정렬을 무시하고 대상 모델의 `Meta.ordering` 기본 정렬을 끼워 넣는다. 그 결과 불필요한 추가 JOIN(`LEFT OUTER JOIN ... T3`)이 생기고, 정렬 방향이 `OneModel.Meta.ordering = ("-id",)`를 따라 예상과 반대(DESC)로 나온다. 사용자는 `_id` 필드로 정렬했으니 단일 INNER JOIN에 `ORDER BY ... root_id ASC`를 기대했다.

## 유형 분류
- 버그 카테고리: edge-case (self-referential FK + `_id` attname 매칭 실패)
- 서브시스템: django ORM query compilation (`sql/compiler.py`의 ordering resolution)
- 증상 타입: silent-wrong (잘못된 SQL/정렬 결과, 예외는 없음)
- 로컬라이제이션 신호: "default sort order on the OneModel class" + "unnecessary extra join" + `order_by("record__root_id")` vs `order_by("record__root__id")`의 SQL 차이 → ordering이 relation default를 append할지 결정하는 분기. `find_ordering_name`의 attname 비교가 핵심.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/compiler.py:find_ordering_name`
- 근본 원인: relation 필드의 default ordering을 append할지 판단할 때 `getattr(field, 'attname', None) != name`으로 비교한다. 여기서 `name`은 점경로 전체(`record__root_id`)인데 `field.attname`은 마지막 조각(`root_id`)이다. 일반(비-self) FK에서는 우연히 동작했지만, self-referential FK 경로에서는 `attname != name`이 항상 참이 되어 "attname으로 지정한 것이 아니다"로 오판 → default ordering을 끌어와 여분의 JOIN과 역방향 정렬을 발생시킴.
- 수정 요지: 비교 대상을 전체 `name`이 아니라 경로의 마지막 조각 `pieces[-1]`로 바꿨다. 즉 `getattr(field, 'attname', None) != pieces[-1]`. 이러면 `record__root_id`의 마지막 조각 `root_id`가 `field.attname`과 일치하므로 default ordering append 분기를 건너뛰고, 단일 JOIN에 명시한 `_id` 컬럼으로 정렬한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_order_by_self_referential_fk` — `tests/ordering/models.py`의 `Author`에 self FK `editor = ForeignKey('self', ...)`를 추가하고, 그 관계로 정렬.
- 증명 방식: `Article.objects.filter(...).order_by('author__editor')`는 관계 자체 정렬이라 대상 모델 default ordering(`Author.Meta.ordering = ('-pk',)`)을 따라 `['Article 2', 'Article 1']`(역순)이 기대값. 반면 `order_by('author__editor_id')`는 `_id` attname 직접 정렬이라 `['Article 1', 'Article 2']`(정순)을 기대. 두 케이스를 같은 테스트에서 대비시켜, `_id` 경로가 더 이상 default ordering으로 새지 않음을 검증한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `compiler.py`에서 ordering append를 결정하는 주석("append the default ordering for that model unless it is the pk shortcut or the attribute name")이 달린 `find_ordering_name` 단일 조건문이 정확한 지점. `pieces`(점경로 split 결과)와 `name`의 차이를 인지하는 것이 핵심.
- 함정/난이도: 비-self FK에서는 버그가 안 보여서 재현 모델 설계가 까다롭다(self FK 필수). 또 `order_by("record__root")`와 `order_by("record__root_id")`가 같은 SQL을 내는 점이 혼란을 키운다 — 진짜 차이는 attname 매칭 한 줄. 멀티파일 아님(코어 패치는 1파일 1조건).
- 우리 에이전트 관점: `name`이 이미 마지막 조각이라고 가정하고 `pieces[-1]`로의 교체 필요성을 놓치기 쉽다. 힌트 텍스트에 등장하는 "전체 테스트 스위트에서 이 분기 변화가 reproducer에서만 트리거됨" 검증(scope 확인)을 재현하지 못하면 회귀 우려로 과도하게 보수적인 수정을 할 위험이 있다.
