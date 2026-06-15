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
primary_type: T-DirectMap
tier: T3
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-15569

## 문제 요약
`RegisterLookupMixin._unregister_lookup()`이 lookup을 등록 해제할 때 캐시된 lookup 테이블을 비우지 않는다. 대응되는 `register_lookup()`은 등록 후 `_clear_cached_lookups()`를 호출해 캐시를 비우는데, 해제 경로(`_unregister_lookup`)에만 이 무효화가 빠져 있다. 그 결과 해제한 lookup이 `get_lookups()` 캐시에 그대로 남아, 테스트를 개별로 돌릴 때와 모듈 전체로 돌릴 때 결과가 달라지는(test inter-dependency) silent-wrong 버그가 생긴다. 이슈 작성자가 재현 시나리오("개별 실행과 일괄 실행이 다른 결과")와 짝 메서드(`register_lookup`), 정확한 파일·라인(L212), 심지어 캐시 클리어를 도입한 과거 PR(#6906)까지 본문에 명시했다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 파일(`django/db/models/query_utils.py`)·메서드(`_unregister_lookup`)·라인·짝 메서드(`register_lookup`)를 전부 직접 지목한다. grep 한 방, 사실상 탐색 0.
- **S (Repair Strategy) = S1 (Direct-Map / template)**: 이슈가 픽스를 사실상 명세한다 — "register_lookup이 하는 것처럼 캐시를 비워라". 정형 결함클래스 = **대칭 연산의 무효화 누락**(register/unregister 페어에서 한쪽만 cache-bust). 추론 합성 없이 짝 메서드의 한 줄(`cls._clear_cached_lookups()`)을 미러링하면 끝나는 기계적 픽스.
- **K (Knowledge) = K-Domain**: 한 줄짜리지만 *어떤* 한 줄인지 알려면 django의 lookup 등록/캐시 메커니즘(`class_lookups` 딕셔너리 ↔ `get_lookups()`의 cached 결과, `_clear_cached_lookups()`의 역할)을 이해해야 한다. 순수 파이썬 추론(K-Gen)으로는 "왜 del만으로 부족한가"가 안 보인다. ORM 내부 캐싱 계약이 병목.
- **primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적(S1, 짝 메서드 미러링)이다. K-Domain이 끼지만 dominant 축은 "위치 확정 + 템플릿 픽스"이므로 T-DomainBound이 아니라 T-DirectMap. T-LocTrivial은 K-Gen 전제라 배제.
- **왜 S1인가 (APR 관점)**: SemFix/Angelix류 constraint-reasoning(S2)이 불필요하다 — 합성할 식·조건이 없다. PAR/TBar의 fix-template "missing-call-on-symmetric-path"에 정확히 매칭된다. 후보 패치가 다수도 아니라 G&V(S3)/CEGIS(S4)도 아니다. 픽스는 결정적이고 단일하다.

## 난이도 티어
**Tier = T3 (중간)**. 공식 라벨은 `<15 min fix`(T1~T2 prior)이지만 한 단계 올려 T3로 둔다. 근거:

- **T1/T2로 미는 피처**: production 변경은 1파일 1줄(`+cls._clear_cached_lookups()`), L0 localize, has-repro(이슈에 재현 서사 + 과거 PR 레퍼런스). 개발자 구현시간 기준으론 정말 15분짜리.
- **T3로 끌어올리는 피처 (구조적)**:
  1. **regression-trap (멀티파일 테스트 정렬)**: 1줄 픽스를 넣으면 *기존에 통과하던* 테스트들이 깨진다. `test_get_transforms`는 수동 `_clear_cached_lookups()` 호출에 의존했고, `test_func_unique_constraint_lookups`는 들여쓰기(컨텍스트 매니저 범위)에 의존했다. 이들은 stale-cache 동작을 암묵 전제로 깔고 있어, 픽스가 그 전제를 깨뜨린다. test_patch가 3개 파일을 건드리는 이유.
  2. **인과 역전 함정**: "왜 멀쩡하던 다른 테스트가 깨지지?"를 회귀로 오인하면, 오라클 없는 에이전트는 1줄 픽스를 *되돌리는* 잘못된 결론에 도달한다. 깨진 테스트가 사실 잘못된 stale 의존을 하고 있었다는 판단(production 코드는 옳고 테스트가 틀렸다)이 비자명하다.
  3. **K-Domain**: 캐시 무효화 계약 이해가 전제.
- 즉 patch scope(production)는 T1급이지만, **올바른 픽스가 인접 테스트를 깨뜨리는 구조 + 그 깨짐을 회귀로 오판하기 쉬운 함정**이 에이전트 난이도를 T3로 민다. 공식 시간라벨은 "이미 옳은 답을 아는 개발자"의 구현시간이라 이 함정 비용을 안 잡는다(루브릭이 경고한 라벨/에이전트 괴리 사례).

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/query_utils.py` — `RegisterLookupMixin._unregister_lookup()`
- **근본 원인**: `register_lookup()`은 `cls.class_lookups[lookup_name] = lookup`으로 등록한 뒤 `cls._clear_cached_lookups()`를 호출해 `get_lookups()`가 캐싱해 둔 lookup 딕셔너리를 무효화한다. 그런데 `_unregister_lookup()`은 `del cls.class_lookups[lookup_name]`로 원본 딕셔너리에서만 제거하고 캐시는 손대지 않는다. 결과적으로 `get_lookups()`가 이미 캐시한 사본에는 해제된 lookup이 살아남아, 해제 후에도 stale lookup이 반환된다. 캐시는 클래스 레벨에 상주해 테스트 간 누수(inter-dependency)를 일으킨다.
- **수정 요지**: `_unregister_lookup`의 `del cls.class_lookups[lookup_name]` 바로 다음 줄에 `cls._clear_cached_lookups()` 한 줄을 추가한다. 이로써 등록/해제가 캐시 무효화 측면에서 **대칭**이 되고, 해제 직후 `get_lookups()`가 새 lookup 집합을 재계산한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - `custom_lookups.tests.LookupTests.test_lookups_caching` — `with register_lookup(models.ForeignObject, Exactly):` 블록을 빠져나온 직후 `self.assertNotIn("exactly", field.get_lookups())` 한 줄을 추가한다. 컨텍스트 매니저 종료 = `_unregister_lookup` 호출이므로, 픽스가 캐시를 비워야 이 단언이 통과한다. 픽스 없으면 `exactly`가 캐시에 남아 실패 → cache-bust를 **직접** 증명하는 단언.
  - `model_fields.test_jsonfield.TestMethods.test_get_transforms` — 기존 테스트는 `models.JSONField._unregister_lookup(MyTransform)` 뒤에 수동으로 `models.JSONField._clear_cached_lookups()`를 호출해야 했다. test_patch는 **이 수동 호출 줄을 삭제**한다. 이제 `_unregister_lookup`이 자동으로 캐시를 비우므로, 수동 호출 없이도 `field.get_transform("my_transform")`이 기본 `KeyTransformFactory`로 복귀해야 통과 → 픽스가 수동 우회를 불필요하게 만든다는 증명.
- **부수 정렬**: `schema/tests.py::test_func_unique_constraint_lookups`는 제약 검증·제거 로직을 `register_lookup` 컨텍스트 매니저 블록 **안쪽으로** 들여쓰기 이동한다. 픽스 전엔 블록을 빠져나간 뒤(=캐시 stale로 lookup 잔존) 검증해도 통과했지만, 픽스 후엔 블록 밖에서 lookup이 사라지므로 검증을 블록 안으로 옮겨야 한다.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇지 않고, 두 테스트가 서로 다른 경로(직접 assertNotIn / 수동호출 제거)에서 cache-bust를 검증한다. special-case 패치로는 둘 다 만족 불가 → overfit-risk 낮음(플래그 미부여).
- **regression 관점**: PASS_TO_PASS 242개 중 다수가 `schema.tests.SchemaTests`와 `model_fields.test_jsonfield`로, lookup/transform 캐시 경로에 인접하다. cache를 너무 자주/엉뚱하게 비우면 이들이 깨질 수 있어 regression-trap 플래그 부여. 골드는 **해제 시에만** 추가 무효화하므로 register-path 성능·정합성을 건드리지 않아 242개가 모두 유지된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `django/db/models/query_utils.py`의 `_unregister_lookup`(L212)과 짝 메서드 `register_lookup`(L202)을 직접 지목한다. 두 메서드를 나란히 열어 diff한다 → `register_lookup`은 끝에 `self._clear_cached_lookups()`(또는 `cls._clear_cached_lookups()`)를 호출하는데 `_unregister_lookup`에는 없다. 비대칭 발견 = 즉시 픽스 위치 확정.
2. **픽스와 일반화 근거**: `del cls.class_lookups[lookup_name]` 다음에 `cls._clear_cached_lookups()`를 추가. 이게 overfit이 아니라 올바른 일반화인 이유 — 특정 lookup 이름이나 특정 테스트에 하드코딩하는 게 아니라, register/unregister가 캐시 무효화에서 **대칭이어야 한다**는 클래스 불변식을 복원한다. 모든 lookup·transform·모든 호출자에 동일하게 적용되는 구조적 픽스다.
3. **regression 안전**: PASS_TO_PASS 242개(특히 register-path를 쓰는 `test_func_index_*`, `test_func_unique_constraint_*`, JSONField transform 계열)를 안 깨야 한다. 추가 무효화를 **해제 경로에만** 두고 register 동작은 그대로 두므로, 정상 등록/조회 흐름엔 영향이 없다. `_clear_cached_lookups`는 이미 존재하는 안전한 무효화 헬퍼라 새 부작용을 만들지 않는다.
4. **함정 회피**: 오라클 없는 에이전트가 빠지는 지점 — 1줄을 추가한 뒤 `test_get_transforms`·`test_func_unique_constraint_lookups`가 깨지는 걸 보고 "내 production 픽스가 회귀를 일으켰다"고 오판해 **픽스를 롤백**하는 것. 회피법: 깨진 테스트의 *원인*을 읽어라. 두 테스트는 stale-cache 동작에 **암묵 의존**(수동 `_clear_cached_lookups` 호출 / 들여쓰기로 컨텍스트 밖 검증)하고 있었다. 즉 production 코드가 옳고 테스트가 틀렸다 — 테스트 쪽을 정렬(수동 호출 삭제, 검증을 컨텍스트 안으로 이동)하는 게 정답. "테스트가 깨졌다 ≠ 내 픽스가 틀렸다"를 구별하는 게 이 문제의 본질적 난점이다.
