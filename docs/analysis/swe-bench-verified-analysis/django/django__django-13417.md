---
instance_id: django__django-13417
repo: django/django
base_commit: 71ae1ab0123582cc5bfe0f7d5f4cc19a9412f396
version: 3.2
difficulty: <15 min fix
created_at: 2020-09-14T07:49:15Z
fail_to_pass: 2
pass_to_pass: 280
gold_files: [django/db/models/query.py]
---

# django__django-13417

## 문제 요약
`Meta.ordering`이 정의된 모델에서 `annotate(Count(...))` 같이 GROUP BY를 유발하는 쿼리를 만들면, 실제 생성되는 SQL에는 ORDER BY 절이 없는데도 `QuerySet.ordered` 프로퍼티가 여전히 `True`를 반환한다. 사용자는 결과가 정렬되지 않으므로 `ordered`가 `False`이기를 기대했다. Django는 0ddb4ebf 커밋 이후 `Meta.ordering`이 GROUP BY 쿼리에 영향을 주지 않도록 바꿨는데, `ordered` 프로퍼티가 그 변경을 반영하지 못해 거짓을 보고하는 버그다.

## 유형 분류
- 버그 카테고리: logic / edge-case (GROUP BY 케이스 누락처리)
- 서브시스템: django ORM query (QuerySet 프로퍼티)
- 증상 타입: silent-wrong (예외 없이 잘못된 boolean 반환)
- 로컬라이제이션 신호: 문제 진술이 명시적으로 `QuerySet.ordered` 프로퍼티와 `query.default_ordering`을 언급하고, hints가 "We should adjust QuerySet.ordered"라고 직접 지목 → `query.py`의 `ordered` 프로퍼티가 정확한 타깃.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/query.py` : `QuerySet.ordered` 프로퍼티 (약 1224행)
- 근본 원인: `ordered`의 분기 조건이 `self.query.default_ordering and self.query.get_meta().ordering`만 검사했다. 하지만 `annotate`로 GROUP BY가 걸리면 `Meta.ordering`은 SQL에 반영되지 않으므로(0ddb4ebf 이후 동작), 이 조건이 참이어도 실제로는 ORDER BY가 생성되지 않는다.
- 수정 요지: `elif` 조건에 `and not self.query.group_by`를 추가했다. 즉 default ordering + Meta.ordering이 있더라도 쿼리에 `group_by`가 설정돼 있으면 `ordered`를 `True`로 보지 않는다. 명시적 `order_by`/`extra_order_by` 경로는 그대로라 사용자가 직접 정렬을 걸면 여전히 `True`다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_annotated_default_ordering`, `test_annotated_values_default_ordering` (둘 다 `queries.tests.QuerysetOrderedTests`)
- 테스트가 어떻게 픽스를 증명하는지: `Tag`는 `Meta.ordering`을 가진 모델. `Tag.objects.annotate(num_notes=Count('pk'))`(및 `.values('name').annotate(...)`)로 GROUP BY 쿼리를 만든 뒤 `qs.ordered`가 `False`임을 단언한다(픽스 전엔 `True` → 실패). 이어서 `.order_by('name')`으로 명시적 정렬을 추가하면 `ordered`가 `True`가 되는지도 확인 → group_by 가드가 명시적 ordering 경로까지 망가뜨리지 않았음을 보장.

## 공략 포인트 (뭘 조져야)
- localization 전략: 문제 진술이 `QuerySet.ordered`를 직접 호명하므로 `django/db/models/query.py`에서 `def ordered` 프로퍼티를 찾는 게 1순위. SQL 생성 쪽(`sql/compiler.py`)을 파고들 필요 없이 프로퍼티의 조건식만 보면 됨.
- 함정/난이도: 단일 파일·1줄 수준 수정이지만, "왜 group_by면 Meta.ordering이 무시되는가"는 0ddb4ebf 히스토리를 알아야 직관이 선다. `query.group_by`는 truthy 리스트일 수도 빈 값일 수도 있어, `not self.query.group_by`로 검사하는 게 정확. 명시적 `order_by` 경로를 건드리면 PASS_TO_PASS(`test_annotated_ordering` 등)가 깨지므로, 반드시 default-ordering `elif` 가지에만 가드를 추가해야 함.
- 우리 에이전트 관점: 막힐 지점은 "ordered가 왜 틀린가"의 인과를 SQL 차원에서 재구성하는 부분. 자칫 `default_ordering`을 끄거나 compiler를 손대는 과한 수정으로 흐를 수 있는데, 골드는 프로퍼티 조건에 group_by 가드 한 줄만 더하는 최소 수정이다. 252개 PASS_TO_PASS 회귀를 피하려면 변경 범위를 좁게 유지하는 판단이 핵심.
