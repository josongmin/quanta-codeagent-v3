---
instance_id: django__django-11885
repo: django/django
base_commit: 04ac9b45a34440fa447feb6ae934687aacbfc5f4
version: 3.1
difficulty: 1-4 hours
created_at: 2019-10-08T15:22:07Z
fail_to_pass: 1
pass_to_pass: 43
gold_files: [django/contrib/admin/utils.py, django/db/models/deletion.py]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, overfit-risk]
---

# django__django-11885

## 문제 요약
`on_delete=models.CASCADE`를 흉내내는 `deletion.Collector`가 fast-delete 경로(`DELETE FROM table WHERE fk_id IN ...`)를 탈 때, 같은 테이블을 여러 FK로 가리키는 관계들을 각각 별도 쿼리로 실행한다. 예를 들어 `Entry`가 `created_by`/`updated_by` 두 FK로 `User`를 참조하면 `user.delete()` 시 `entry`에 대해 2개의 DELETE가 나간다. 이슈는 이런 경우 같은 테이블에 대한 쿼리를 `OR`로 묶어(`DELETE FROM entry WHERE created_by_id = :id OR updated_by = :id`) DB 왕복 횟수를 줄이기를 요구한다. 동작 자체는 정확하므로 결함은 "예외/오답"이 아니라 **쿼리 수 과다(성능)**다.

## 유형 (정형화)

**L (Localization) = L3 (Multi-site).** 이슈 본문이 `deletion.Collector` / "fast queries" / "combine such queries by table" / "single one by using OR"로 타깃 모듈(`django/db/models/deletion.py`)을 직접 지목하는 점은 L0급 신호다. 그러나 실제 픽스는 단일 함수가 아니라 `Collector.collect`(수집 루프 전체) + `Collector.related_objects`(시그니처 변경) + `Collector.get_del_batches`(시그니처 변경) + `Collector.can_fast_delete`(호출 규약 변경) + `Collector.__init__`이 **함께** 바뀌어야 하고, 게다가 `related_objects`를 오버라이드하는 `django/contrib/admin/utils.py:NestedObjects.related_objects`까지 동기 수정이 강제된다. 진입점은 쉽게 찾지만 수정이 ≥2 파일·다수 함수에 조율되어 걸쳐 있으므로 L3.

**S (Repair Strategy) = S6 (Design-Refactor) +S2.** 단순 가드/상수 변경이 아니라 제어흐름을 재배치하는 구조 변경이다 — fast-delete 가능한 관계를 발견 즉시 실행하던 것을, `model_fast_deletes = defaultdict(list)`에 `related_model`별 필드를 **collect-then-process**로 누적한 뒤 모델 단위로 일괄 실행하도록 루프를 뒤집어야 한다. 동시에 단일 필드 API(`related`)를 복수 필드 API(`related_fields`)로 일반화해 파라미터를 도입한다. 이 collect-then-process + 파라미터 도입이 전형적 S6 신호. 보조로 S2가 붙는 이유는, 결합 predicate를 단순 문자열로 만들 수 없고 `reduce(operator.or_, Q(...) for ...)`로 여러 필드의 `Q` 객체를 `OR`로 합성하는 **올바른 식을 추론**해야 하기 때문(불변식: N개 필드여도 의미적으로 동일한 `__in` 집합이어야 함).

**K (Knowledge) = K-Domain.** django ORM 내부 지식이 병목이다 — Collector의 cascade 삭제 lifecycle, `get_candidate_relations_to_delete`, `_base_manager.using(...).filter(predicate)`, `query_utils.Q`의 `|` 합성, `bulk_batch_size`가 필드명 **리스트**를 받는다는 점, fast-delete 판정을 인스턴스가 아닌 `related_model` 타입으로 해야 한다는 미묘함까지. 일반 파이썬 추론으로는 결합의 정당성과 안전성을 보장할 수 없다.

**Primary type = T-DesignRefactor.** 위치는 명확(이슈가 모듈을 적어줌)하나 진짜 난점은 "한 줄"이 아니라 수집 루프의 조율된 구조 변경이라는 점 — 라이프사이클 재배치 + API 일반화 + cross-file 오버라이드 동기화가 핵심이다. L3이라 T-DiffuseLoc 후보도 있으나, 어려움이 "어디인지 찾기"가 아니라 "어떻게 구조를 재배치하나"에 있으므로 T-DesignRefactor가 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 공식 라벨 "1-4 hours"(T4 prior)보다 한 단계 위로 올린다. 이를 미는 구조적 피처:
- **멀티파일·멀티헌크(L3 + S6):** gold patch가 2파일에 걸쳐 있고 deletion.py 안에서만 5개 함수가 바뀐다. 루브릭 구조컷상 멀티파일·다수헌크는 T5 구간.
- **cross-file-dep:** `related_objects` 시그니처 `(related, objs)` → `(related_model, related_fields, objs)` 변경은 오버라이드 `admin/utils.py:NestedObjects.related_objects`를 함께 안 고치면 admin 삭제 경로가 런타임에 깨진다. 이 의존이 암묵적(PASS_TO_PASS에 admin 테스트가 직접 안 잡힘)이라 더 위험.
- **결함이 성능형:** 예외/오답이 아니라 동작이 이미 "정상"이라, 테스트가 `assertNumQueries`로만 실패를 드러낸다. 에이전트가 목표를 "고장 고치기"가 아니라 "쿼리 카운트 회귀"로 정확히 프레이밍해야 시작점을 잡는다 — has-repro 없는 성능 리팩터링.
- **regression-trap:** PASS_TO_PASS 43건(`test_fast_delete_fk/m2m/inheritance/revm2m`, `OnDeleteTests` 18건, `DeletionTests` 등)이 cascade 시맨틱을 광범위하게 검증. 결합이 단 하나의 cascade 경로라도 의미를 바꾸면 즉시 깨진다.
- **overfit-risk:** FAIL_TO_PASS가 단 1건(`assertNumQueries(2)`)이라, "이 특정 2-FK 케이스만 OR로 묶는" special-case로도 통과 가능 — 진짜 일반화(임의 N 필드)와 구별이 약하다.

T6까지 가지 않는 이유: 패치 규모가 >100줄/≥7파일 수준의 대형 design은 아니고, 도메인 지식이 ORM 한 서브시스템에 국한되며 진입점이 명확하기 때문.

## 골드패치 분석
- **건드린 파일·함수:**
  - `django/db/models/deletion.py` — `Collector.__init__`, `Collector.add`, `Collector.add_field_update`, `Collector.can_fast_delete`, `Collector.get_del_batches`, `Collector.collect`, `Collector.related_objects` (+ 상단 import `operator`/`defaultdict`/`partial`/`reduce`/`query_utils`)
  - `django/contrib/admin/utils.py` — `NestedObjects.related_objects` (오버라이드 동반 수정)
- **근본 원인:** `related_objects(related, objs)`와 fast-delete 수집이 **단일 `related`(=단일 필드)** 단위로만 동작했다. 동일 모델을 가리키는 여러 FK가 각각 독립적으로 `related_objects`를 호출해 테이블당 N개의 DELETE를 생성했다. 결합할 자리(predicate 합성)도, 결합할 타이밍(필드를 모았다가 한 번에)도 코드 구조상 없었다.
- **수정 요지:**
  1. `related_objects` 시그니처를 `(related_model, related_fields, objs)`로 일반화하고, 본문을 `predicate = reduce(operator.or_, (query_utils.Q(**{'%s__in' % related_field.name: objs}) for related_field in related_fields))` → `related_model._base_manager.using(self.using).filter(predicate)`로 바꿔 여러 필드를 단일 `OR` predicate로 결합.
  2. `collect`에서 fast-delete 가능 관계를 즉시 실행하지 않고 `model_fast_deletes = defaultdict(list)`에 `related_model`별로 필드를 누적(`can_fast_delete(related_model, from_field=field)` → `model_fast_deletes[related_model].append(field)`)한 뒤, 루프 종료 후 모델 단위로 한 번에 `related_objects(related_model, related_fields, batch)`를 호출해 `fast_deletes`에 추가. (가독성 위해 `if not collect_related: return` early-return으로 들여쓰기 평탄화 동반.)
  3. `get_del_batches(objs, field)` → `(objs, fields)`로 복수 필드를 받아 `field_names = [field.name for field in fields]`를 `bulk_batch_size`에 전달.
  4. `can_fast_delete` 진입에서 `model = type(objs)` → `model = objs._meta.model`로 정정(타입 기준 판정), 그리고 호출측이 인스턴스 대신 `related_model` 타입을 넘기도록 정리.
  5. `__init__`의 `data`/`field_updates`/`dependencies`를 `defaultdict`로 전환해 `add`/`add_field_update`/`add`의 `setdefault` 보일러플레이트 제거 — **본질이 아닌 부수적 정리(cosmetic)**.
  6. `admin/utils.py:NestedObjects.related_objects` 오버라이드를 새 시그니처에 맞춰 `qs.select_related(*[related_field.name for related_field in related_fields])`로 갱신.

## 검증 (test_patch)
- **FAIL_TO_PASS (1건):** `test_fast_delete_combined_relationships (delete.tests.FastDeleteTests)` — `Origin`/`Referrer`(+`SecondReferrer`가 `referrer_id`와 `unique_field` 두 경로로 참조) 구조에서 `referer.delete()`를 호출하고 `with self.assertNumQueries(2)`로 단정.
- **픽스 증명:** 패치 전이면 동일 테이블(`SecondReferrer`)에 대한 cascade fast-delete가 필드별로 쪼개져 쿼리가 더 나간다. 패치 후엔 `referrer_id OR unique_field`로 결합되어 cascade fast-delete 1 + 본체 delete 1 = 정확히 2 쿼리. `assertNumQueries`가 카운트 회귀를 정량 단정하므로 결합이 실제 일어났음을 직접 증명.
- **overfit 관점:** FAIL_TO_PASS가 단 1건·필드 2개 케이스라, "정확히 2-FK일 때만 OR" 같은 special-case 패치도 녹색으로 통과한다(루브릭 S4-스러운 underspecification). 골드처럼 `reduce(operator.or_, Q for N fields)`로 임의 N에 일반화해야 진짜 정답 — 테스트만 보고 짠 패치는 overfit 위험.
- **regression 관점:** PASS_TO_PASS 43건이 결합이 cascade **시맨틱**을 안 깨는지 보장한다. `test_fast_delete_fk/m2m/inheritance/revm2m`(fast-delete 경로별 정합), `OnDeleteTests` 18건(CASCADE/SET_NULL/PROTECT/DO_NOTHING 등 on_delete 동작), `test_only_referenced_fields_selected`/`test_proxied_model_duplicate_queries`(deferred/only 최적화와의 상호작용), `test_delete_with_keeping_parents*`(keep_parents 경로)가 핵심 가드. 특히 결합 predicate가 `__in` 집합의 합집합과 의미적으로 동일해야 하고, fast-delete 불가 관계(signal/select_related)는 결합 대상에서 빠져 기존 경로를 타야 함을 이들이 감시한다.

## 모범답안 (오라클 기반)

1. **localize 경로:** 이슈가 `deletion.Collector` + "fast queries" + "combine such queries by table" + "single one by using OR"로 명시 → `grep -n "fast_delete\|related_objects\|get_candidate_relations" django/db/models/deletion.py`로 `Collector.collect`의 `for related in get_candidate_relations_to_delete(model._meta):` 루프와 `related_objects`에 즉시 수렴. 진입점은 L0급으로 쉽다 — 함정은 그 다음.

2. **픽스(올바른 일반화인 이유):** 두 축을 같이 바꿔야 한다. (a) **데이터 모델:** `related_objects`가 단일 필드 대신 `related_fields` 리스트를 받아 `reduce(operator.or_, Q(...) for f in related_fields)`로 OR predicate를 합성 — 임의 N 필드에 대해 닫혀 있어 "2-FK만 처리"하는 overfit과 다르다. (b) **타이밍:** collect-then-process — fast-delete 후보를 `model_fast_deletes[related_model]`에 모았다가 모델 단위로 일괄 실행해야 비로소 같은 테이블 쿼리가 한 번으로 합쳐진다. 즉시 실행 구조로는 결합이 원리적으로 불가하므로 루프 재배치가 필연. `can_fast_delete`를 `related_model`(타입)로 호출하도록 바꾸는 것도 "인스턴스별이 아니라 모델별로 묶기" 위한 필수 변경.

3. **regression 안전:** PASS_TO_PASS 43건을 깨면 안 된다. 결합은 **fast-delete 가능한** 관계에만 적용하고, signal listener가 있거나 `select_related`가 걸린 관계는 기존 per-field 경로(`field.remote_field.on_delete(...)`)를 그대로 타야 한다(`OnDeleteTests`/`test_only_referenced_fields_selected`가 감시). OR predicate가 각 필드 `__in`의 합집합과 의미동일해야 `test_fast_delete_fk/m2m/revm2m`가 산다. keep_parents 경로(`test_delete_with_keeping_parents*`)도 early-return 평탄화 과정에서 누락하면 안 된다.

4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (i) **목표 오인:** 동작이 정상이라 "버그가 없다"고 판단하거나, 단일 함수 한 줄 패치로 끝내려 함. 실제론 `assertNumQueries` 회귀가 목표이고 멀티포인트 리팩터링이 필요. (ii) **cross-file 누락:** `related_objects` 시그니처를 바꾸고 `admin/utils.py:NestedObjects.related_objects` 오버라이드를 안 고치면 admin 삭제가 런타임에 깨진다(PASS_TO_PASS에 직접 안 잡혀도 회귀) — 시그니처 변경 시 반드시 호출자·오버라이더 전수 grep. (iii) **overfit:** FAIL_TO_PASS 1건만 보고 "2개 필드 OR" 하드코딩으로 통과시키면 임의 N 일반화 실패. (iv) **매몰 함정:** `__init__`의 `defaultdict` 전환은 선택적 정리(본질 아님)이므로 거기에 시간을 쓰지 말고 collect 루프 재구조화 + predicate 합성 + cross-file 동기화에 집중.
