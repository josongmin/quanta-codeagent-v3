---
instance_id: django__django-13028
repo: django/django
base_commit: 78ad4b4b0201003792bfdbf1a7781cbc9ee03539
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-06-05T19:49:04Z
fail_to_pass: 2
pass_to_pass: 276
gold_files: [django/db/models/sql/query.py]
---

# django__django-13028

## 문제 요약
`filterable`라는 이름의 `BooleanField`를 가진 모델 인스턴스를 다른 쿼리의 필터 값(RHS)으로 넘기면 `NotSupportedError: <Model> is disallowed in the filter clause.`가 발생한다. 예: `ProductMetaData.objects.filter(metadata_type=self.brand_metadata)`에서 `metadata_type`이 `filterable=False` 필드를 가진 모델을 가리키면 터진다. 사용자는 단순 FK 필터가 정상 동작하기를 기대했지만, 모델의 `filterable` 컬럼이 우연히 Django 내부 제약 플래그와 충돌해 크래시한다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (필드명 충돌에 대한 타입 가드 누락)
- 서브시스템: django ORM query 빌드 (`django/db/models/sql/query.py`)
- 증상 타입: 예외 (`NotSupportedError`로 정상 필터가 크래시)
- 로컬라이제이션 신호: problem_statement에 traceback이 그대로 들어 있어 `query.py`의 `check_filterable` → `build_filter` 경로가 직접 지목된다. "disallowed in the filter clause" 문구로 grep하면 바로 해당 함수에 도달한다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py:Query.check_filterable`
- 근본 원인: `check_filterable`은 표현식(expression)이 WHERE 절에 못 들어가는 경우를 막으려고 `getattr(expression, 'filterable', True)`를 검사한다. 그런데 RHS가 표현식이 아니라 **일반 모델 인스턴스**일 때, 그 모델이 `filterable`라는 이름의 필드를 가지고 있으면 `getattr`이 그 모델 인스턴스 속성(예: `False`)을 잡아채서 Django 내부 플래그로 오인한다. 즉 사용자 데이터 필드명과 ORM 내부 메타 속성의 네임스페이스가 충돌한다. (regression: 커밋 4edad1ddf6203326e0be4bdb105beecb0fe454c4)
- 수정 요지: 가드 조건 앞에 `hasattr(expression, 'resolve_expression')`를 추가해, **실제 Django expression일 때만** `filterable` 속성을 검사하도록 좁혔다. 모델 인스턴스는 `resolve_expression`을 갖지 않으므로 우연한 `filterable` 필드가 있어도 더 이상 disallow되지 않는다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_field_with_filterable`(신규), `test_ticket8439`(기존, 데이터 fixture 변경으로 재검증).
- 테스트가 어떻게 픽스를 증명하는지: `tests/queries/models.py`의 `ExtraInfo` 모델에 `filterable = BooleanField(default=True)` 필드를 추가하고, fixture에서 `e2`를 `filterable=False`로 생성한다. 그 뒤 `test_field_with_filterable`이 `Author.objects.filter(extra=self.e2)`를 실행 — 픽스 전이라면 `e2.filterable == False` 때문에 `NotSupportedError`로 터지지만, 픽스 후에는 정상적으로 `[a3, a4]`(extra가 e2인 저자들)를 반환한다. 즉 "filterable 필드를 가진 모델을 RHS로 필터"하는 정확한 재현 시나리오를 단언한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: traceback이 `query.py:1131 check_filterable`을 직접 가리킨다. 이 한 함수만 읽으면 `getattr(expression, 'filterable', True)`가 모델 인스턴스에도 무차별 적용된다는 걸 알 수 있다.
- 함정/난이도 메모: 핵심은 "왜 모델 인스턴스에 `filterable` 속성이 있는가"를 이해하는 것 — 사용자 필드명과 ORM 내부 플래그의 충돌이라는 비직관적 원인. `resolve_expression`을 가드로 쓰는 건 Django에서 "이게 진짜 표현식인가"를 판별하는 관용 패턴이라는 도메인 지식이 필요. 수정은 1파일 3줄짜리 단순 패치지만, 가드 조건을 `filterable` 검사보다 **앞에** 두는 순서가 핵심(AND 단락 평가).
- 우리 에이전트 관점: 막힐 만한 지점은 "정상 필터를 어떻게 막지 않으면서 진짜 disallow는 유지하느냐". 단순히 `try/except`로 삼키거나 `filterable` 검사를 통째로 제거하면 PASS_TO_PASS(특히 slice/QuerySet을 필터에 못 쓰게 하는 케이스)가 깨진다. `resolve_expression` 유무로 표현식과 모델 인스턴스를 구분하는 정확한 가드를 찾아야 회귀 없이 통과한다. hints_text에 거의 정답에 가까운 diff가 들어 있어 난이도는 낮은 편.
