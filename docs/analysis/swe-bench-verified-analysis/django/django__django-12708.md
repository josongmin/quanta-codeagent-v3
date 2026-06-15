---
instance_id: django__django-12708
repo: django/django
base_commit: 447980e72ac01da1594dd3373a03ba40b7ee6f80
version: 3.1
difficulty: 1-4 hours
created_at: 2020-04-12T22:20:59Z
fail_to_pass: 1
pass_to_pass: 101
gold_files: [django/db/backends/base/schema.py]
---

# django__django-12708

## 문제 요약
동일한 필드 집합에 `unique_together`와 `index_together`가 둘 다 걸려 있을 때, `index_together`만 삭제하는 마이그레이션이 크래시한다. `_delete_composed_index()`가 해당 필드들에 대한 제약을 조회하면 `_uniq`와 `_idx` 두 개가 잡혀 `ValueError: Found wrong number (2) of constraints`가 발생한다. 사용자는 unique는 그대로 둔 채 index만 안전하게 제거되길 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (제약 조회 시 unique 제약을 배제하지 않음)
- 서브시스템: django migrations / DB backend schema editor
- 증상 타입: 예외 (마이그레이션 실행 중 ValueError 크래시)
- 로컬라이제이션 신호: problem_statement가 파일·라인·함수명을 직접 명시 — `django/db/backends/base/schema.py`, `_delete_composed_index()`, "Found wrong number (2) of constraints". 거의 핀포인트 수준.

## 골드패치 분석
- 건드린 파일/함수: `django/db/backends/base/schema.py` : `BaseDatabaseSchemaEditor.alter_index_together()`
- 근본 원인: `alter_index_together`가 삭제할 인덱스에 대해 `_delete_composed_index(model, fields, {'index': True}, ...)`를 호출하면서 제약 조회 조건에 `index=True`만 지정했다. unique 제약도 내부적으로 index 속성을 만족하므로 같은 필드 집합 위의 `_uniq` 제약까지 함께 매칭되어 2개가 잡히고, `_delete_composed_index`의 "정확히 1개" 가정을 깨뜨린다.
- 수정 요지: 조회 메타 딕셔너리를 `{'index': True}` → `{'index': True, 'unique': False}`로 확장. 이로써 unique 제약(`unique=True`)은 후보에서 제외되고 순수 index 제약 1개만 매칭되어 정상 삭제된다. `alter_unique_together` 쪽은 이미 `{'unique': True}`로 좁히고 있어 대칭이 맞춰진다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_alter_index_together_remove_with_unique_together` — 같은 필드(`pink`, `weight`)에 unique_together와 index_together를 모두 건 모델에서 index_together를 제거.
- 증명 방식: `set_up_test_model(..., unique_together=True)`로 unique 제약을 만든 뒤 `AlterIndexTogether`로 index를 추가→다시 제거한다. 픽스 전이면 제거 단계에서 ValueError로 죽고, 픽스 후에는 `assertIndexNotExists`(index 사라짐) + `assertUniqueConstraintExists`(unique는 살아있음)가 통과한다. 테스트 헬퍼도 보강됨: `assertIndexExists`가 `not c['unique']` 조건을 추가하고, 신규 `assertUniqueConstraintExists` 헬퍼가 unique 제약 생존을 별도 검증. `@skipUnlessDBFeature('allows_multiple_constraints_on_same_fields')`로 동일 필드 다중 제약을 지원하는 백엔드에서만 실행.

## 공략 포인트 (뭘 조져야)
- 시작점: problem_statement가 파일/라인/함수를 직접 줘서 로컬라이제이션은 쉽다. `_delete_composed_index` 호출부 두 곳(`alter_index_together`, `alter_unique_together`)을 비교하면 비대칭이 바로 드러난다.
- 함정/난이도: 진짜 함정은 "어디"가 아니라 "왜". `_delete_composed_index` 자체(에러를 던지는 곳)를 고치려 들기 쉽지만, 정답은 호출자가 조회 필터를 좁히는 것이다. unique 제약이 introspection 상 index로도 카운트된다는 점을 이해해야 `unique: False` 추가가 떠오른다. 단일 파일, 4줄 수정이지만 의미 이해 난이도가 "1-4 hours"를 만든다.
- 우리 에이전트 관점: `_delete_composed_index` 내부의 카운트 검증 로직을 완화하거나 try/except로 삼키는 오답에 빠지기 쉽다(증상 무마). introspection이 unique를 index로 집계하는 동작을 확인하고, 대칭 호출부(`alter_unique_together`의 `{'unique': True}`)를 참조해 최소 침습 필터링으로 수렴하는지가 관건.
