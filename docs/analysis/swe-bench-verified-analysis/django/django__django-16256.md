---
instance_id: django__django-16256
repo: django/django
base_commit: 76e37513e22f4d9a01c7f15eee36fe44388e6670
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-11-04T14:26:44Z
fail_to_pass: 9
pass_to_pass: 53
gold_files: [django/contrib/contenttypes/fields.py, django/db/models/fields/related_descriptors.py]
---

# django__django-16256

## 문제 요약
QuerySet에 async 인터페이스(58b27e0)가 추가되면서 관련 매니저(related manager)에도 의도치 않게 `acreate()`, `aget_or_create()`, `aupdate_or_create()`가 노출됐다. 이 메서드들은 매니저의 동기 `create()`/`get_or_create()`/`update_or_create()`(부모 인스턴스의 FK/content_type/object_id 주입 로직 포함)를 호출하지 않고, 상속받은 QuerySet 쪽 버전을 그대로 호출해 버린다. 결과적으로 관계가 제대로 설정되지 않은 객체가 생성된다. 기대 동작은 동기 매니저 메서드와 동일하게 부모 관계를 채운 채 비동기로 동작하는 것.

## 유형 분류
- 버그 카테고리: API-contract / regression (async 인터페이스 도입 후 회귀)
- 서브시스템: django ORM related managers (reverse FK / m2m / generic relations)
- 증상 타입: silent-wrong (예외 없이 관계가 누락된 객체 생성)
- 로컬라이제이션 신호: problem_statement가 커밋 58b27e0과 정확한 파일 경로(`django/db/models/fields/related_descriptors.py`)와 함수(`create_reverse_many_to_one_manager`, `create_forward_many_to_many_manager`)까지 diff 스케치로 제시. generic relation은 `contenttypes/fields.py`에 대응 매니저가 있어 함께 처리.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/fields/related_descriptors.py`: `create_reverse_many_to_one_manager`의 매니저, `create_forward_many_to_many_manager`의 `ManyRelatedManager`
  - `django/contrib/contenttypes/fields.py`: `GenericRelatedObjectManager`
- 근본 원인: 매니저가 QuerySet에서 상속한 async 메서드를 쓰면 동기 버전이 매니저 내부에 재정의해 둔 부모 관계 주입(`kwargs[self.field.name] = self.instance`, content_type/object_id 설정, through_defaults 처리)을 건너뛴다.
- 수정 요지: 각 동기 메서드(`create`/`get_or_create`/`update_or_create`) 바로 옆에 매니저 자신의 동기 버전을 `sync_to_async(self.create)(**kwargs)` 식으로 감싸는 `acreate`/`aget_or_create`/`aupdate_or_create`를 명시적으로 정의. m2m 쪽은 `through_defaults` 키워드를 그대로 전달. 모든 새 메서드에 `alters_data = True`를 달아 템플릿에서 호출 금지. 두 파일 상단에 `from asgiref.sync import sync_to_async` import 추가.

## 검증 (test_patch)
- FAIL_TO_PASS 9개가 reverse FK(`relatedmodel_set`), forward m2m(`simples`), generic(`tags`) 세 경로 × create/get_or_create/update_or_create를 커버.
- 테스트가 픽스를 증명하는 방식: 예를 들어 `test_acreate`는 `await self.mtm1.simples.acreate(field=2)` 후 `await self.mtm1.simples.aget()`로 같은 m2m 매니저에서 그 객체가 조회되는지 확인 — 관계가 실제로 연결됐음을 입증. `test_aget_or_create`/`aupdate_or_create`는 `created` 불리언과 `acount()`(중복 생성 안 됨), through_defaults/defaults 반영을 검증. reverse 테스트는 생성된 객체의 `.simple == self.s1`로 FK 주입을 확인. 픽스 전에는 QuerySet 경로라 부모 관계 누락 → 이 단언들이 실패.
- 신규 모델 `ManyToManyModel`(`tests/async/models.py`)과 새 파일 `tests/async/test_async_related_managers.py`, generic은 기존 `generic_relations/tests.py`에 async 케이스 3개 추가.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 파일/함수/diff가 거의 그대로 주어져 있으므로 그 지점을 찾아 동기 메서드 옆에 async 래퍼를 붙이는 게 핵심. 단, generic relations 파일은 본문에 직접 명시되지 않아 누락 위험 — `GenericRelatedObjectManager`도 같은 패턴을 가지므로 함께 고쳐야 FAIL_TO_PASS의 generic 3개를 통과.
- 함정/난이도 메모: (1) 멀티파일(2개 src) + 3개 매니저 팩토리 × 3개 메서드라 반복 누락 쉬움. (2) m2m의 `acreate`는 키워드-온리 `*, through_defaults=None` 시그니처를 보존해야 함. (3) `sync_to_async`로 동기 매니저 메서드를 감싸야지, QuerySet의 async 메서드를 호출하면 같은 버그 재현. (4) `alters_data = True` 누락은 테스트는 통과해도 보안 계약 위반.
- 우리 에이전트 관점: 난이도는 낮지만 "전수 커버리지"가 관건. 한 파일만 고치고 끝내거나 generic 매니저를 빠뜨리면 부분 실패. 동기 메서드 위치를 grep으로 모두 찾아 빠짐없이 미러링하는 체계적 접근이 필요.
