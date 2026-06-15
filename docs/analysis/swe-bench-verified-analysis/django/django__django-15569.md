---
instance_id: django__django-15569
repo: django/django
base_commit: 884b4c27f506b3c29d58509fc83a35c30ea10d94
version: 4.1
difficulty: <15 min fix
created_at: 2022-04-08T06:55:17Z
fail_to_pass: 2
pass_to_pass: 242
gold_files: [django/db/models/query_utils.py]
---

# django__django-15569

## 문제 요약
`RegisterLookupMixin._unregister_lookup()`가 lookup을 등록 해제할 때 캐시된 lookup 테이블을 비우지 않는다. 대응되는 `register_lookup()`은 등록 후 캐시를 비우는데(`_clear_cached_lookups()` 호출), 해제 경로에만 이 처리가 빠져 있다. 그 결과 해제한 lookup이 `get_lookups()` 캐시에 그대로 남아, 테스트를 개별로 돌릴 때와 모듈 전체로 돌릴 때 결과가 달라지는(test inter-dependency) silent-wrong 버그가 생긴다.

## 유형 분류
- 버그 카테고리: 누락처리 (대칭 연산에서 캐시 무효화 누락)
- 서브시스템: django ORM — model field lookup 등록 시스템 (`RegisterLookupMixin`)
- 증상 타입: silent-wrong (예외 없이 stale 캐시로 잘못된 lookup 반환; 테스트 순서 의존성)
- 로컬라이제이션 신호: problem_statement가 파일·라인·메서드를 직접 지목한다 — `django/db/models/query_utils.py`의 `_unregister_lookup`. 게다가 짝이 되는 `register_lookup`이 캐시를 비운다는 단서까지 명시해 수정 위치가 거의 확정적이다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/query_utils.py` : `RegisterLookupMixin._unregister_lookup()`
- 근본 원인: `register_lookup()`은 `class_lookups`를 갱신한 뒤 `_clear_cached_lookups()`를 호출해 `get_lookups()`의 `@functools.lru_cache`/cached 결과를 무효화한다. 그러나 `_unregister_lookup()`은 `del cls.class_lookups[lookup_name]`만 하고 캐시는 그대로 둬서, 이미 캐시된 lookup 딕셔너리에 해제된 항목이 살아남는다.
- 수정 요지: `_unregister_lookup` 안에서 `del cls.class_lookups[lookup_name]` 다음 줄에 `cls._clear_cached_lookups()` 한 줄을 추가한다. 이로써 등록/해제가 캐시 무효화 측면에서 대칭이 되고, 해제 직후 `get_lookups()`가 새 값을 재계산한다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `custom_lookups.tests.LookupTests.test_lookups_caching` — `register_lookup(...Exactly)` 컨텍스트를 빠져나온 뒤 `self.assertNotIn("exactly", field.get_lookups())`를 추가해, 등록 해제가 캐시를 비웠는지 직접 확인한다. 픽스 없이는 `exactly`가 캐시에 남아 실패.
  - `model_fields.test_jsonfield.TestMethods.test_get_transforms` — 기존엔 `_unregister_lookup` 호출 뒤 테스트가 수동으로 `models.JSONField._clear_cached_lookups()`를 불러야 했다. test_patch는 이 수동 호출 줄을 삭제한다. 이제 `_unregister_lookup`이 알아서 캐시를 비우므로, 수동 호출 없이도 `field.get_transform("my_transform")`이 기본 `KeyTransformFactory`로 돌아가야 통과한다.
- `schema/tests.py`의 `test_func_unique_constraint_lookups`는 들여쓰기를 조정해 `register_lookup` 컨텍스트 매니저 블록 안에서 제약 검증·제거를 수행하도록 바꿨다(해제 시 캐시가 비워지므로 블록 밖에서 검증하면 lookup이 사라져 실패하던 것을 정렬).

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 파일·메서드·짝 메서드를 모두 지목하므로 `query_utils.py`의 `register_lookup`/`_unregister_lookup` 짝을 나란히 읽고 비대칭(캐시 클리어 누락)을 찾으면 끝. 한 줄 추가가 본질.
- 함정/난이도: 본 수정은 1줄이지만 멀티파일 테스트 영향이 있다. 캐시 클리어를 추가하면 그동안 "stale 캐시 덕에" 통과하던 테스트(`test_get_transforms`의 수동 `_clear_cached_lookups`, `test_func_unique_constraint_lookups`의 들여쓰기)들이 깨질 수 있어, 이 인접 테스트들을 함께 수정해야 한다. 즉 production 코드 1줄 vs 테스트 정렬 3곳.
- 우리 에이전트 관점: 핵심 1줄은 쉽게 찾지만, "왜 멀쩡하던 다른 테스트가 깨지지?"를 회귀로 오인해 픽스를 되돌리는 함정에 빠질 수 있다. 깨진 테스트가 사실 잘못된 stale 의존을 하고 있었음을 인지하고 테스트 쪽을 고치는 판단이 필요하다.
