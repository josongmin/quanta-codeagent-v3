---
instance_id: django__django-11087
repo: django/django
base_commit: 8180ffba21bf10f4be905cb0d4890dc2bcff2788
version: "3.0"
difficulty: 15 min - 1 hour
created_at: 2019-03-16T22:59:57Z
fail_to_pass: 1
pass_to_pass: 41
gold_files: [django/db/models/deletion.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro, overfit-risk]
---

# django__django-11087

## 문제 요약
`.delete()`가 연쇄(cascade) 삭제 그래프를 만들 때, 관련 객체를 SELECT하면서 모델의 모든 컬럼을 가져온다. 삭제 그래프 구축에는 PK와 자식이 참조하는 FK 필드만 필요한데도 큰 `TextField` 같은 불필요한 필드까지 fetch한다. 사용자(treeherder)는 Python 3 + mysqlclient 환경에서 `text_log_error.line`의 깨진 바이트를 디코드하다 `UnicodeDecodeError`로 `.delete()`가 크래시했고(네이티브 스택트레이스 첨부), 삭제에 필요 없는 필드는 애초에 SELECT하지 말아야 한다고 요청했다. 메인테이너(charettes)가 이슈 댓글에서 직접 최적화 방향과 비교 브랜치(`ticket-30191`)까지 제시했다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)** — 네이티브 traceback이 `django/db/models/deletion.py:223 collect()`의 `elif sub_objs:` 라인을 정확히 가리키고, hints에서 메인테이너가 "deletion collector가 SELECT로 그래프를 만든다 / 참조되는 필드만 가져오면 된다"고 위치를 짚어줌. 단일 파일·단일 메서드로 빠르게 수렴하지만 L0(심볼 직지목)는 아님 — 고칠 분기는 알아도 `collect()` 내부 데이터플로우(related_objects → on_delete)를 이해해야 함.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning)** — 한 줄 가드 추가가 아니라, (a) 시그널 리스너 체크를 `_has_signal_listeners()` 헬퍼로 추출해 `can_fast_delete`와 공유하고, (b) `elif`를 `else`로 바꿔 조건부 컬럼 축소 블록을 삽입하는 **구조 변경**이 핵심이라 S6. 동시에 "어떤 필드를 deferred해도 안전한가"를 결정하려면 `get_candidate_relations_to_delete()`로 실제 참조되는 FK 필드 집합을 합성하고 시그널/`select_related` 불변식을 따져야 하므로 S2가 보조로 들어감(많이 시도해서가 아니라 도메인 불변식을 추론으로 풀어야 함).
- **K (Knowledge) = K-Domain** — django ORM deletion collector, `query.select_related`, `_meta.get_candidate_relations_to_delete`, `foreign_related_fields`, `QuerySet.only()`, deletion 시그널 모델 등 **프레임워크 내부 지식이 병목**. 일반 파이썬 추론으로는 어떤 필드가 cascade에 필요한지·시그널 receiver가 fast-delete를 막는 이유를 도출할 수 없다.
- **Primary type = T-DomainBound** — 위치(L1)는 비교적 쉽고 픽스도 ~20줄로 작지만, 진짜 병목은 "삭제 SELECT에서 안전하게 deferred 가능한 필드는 정확히 무엇이고, 어떤 조건(시그널/select_related/to_field)에서 그 최적화를 꺼야 하는가"라는 ORM 내부 계약을 정확히 아느냐에 있다. S6 refactor 자체보다 K-Domain 정확성이 정/오답을 가르므로 T-DesignRefactor보다 T-DomainBound가 dominant.

## 난이도 티어 — T5 (어려움)
- **공식 라벨(15분-1시간)과 상향 조정**: 공식 시간라벨은 charettes가 이미 동작하는 비교 브랜치를 첨부했기에 "구현시간"이 짧게 잡혔다(레시피가 주어진 상태). 하지만 오라클 없는 에이전트 난이도 기준으론 더 높다.
- **T5로 미는 구조적 피처**:
  - **regression-trap (강)**: PASS_TO_PASS 41건이 거의 전부 deletion 동작(FastDeleteTests 9 / OnDeleteTests 17 / DeletionTests 다수). fetch 컬럼을 잘못 줄이면 `to_field` FK, multi-table inheritance, m2m, `select_related` 경로에서 즉시 회귀. 최적화를 좁게 게이팅하지 못하면 광범위 회귀.
  - **overfit-risk**: FAIL_TO_PASS가 단 1건(`test_only_referenced_fields_selected`). 순진하게 `.only('id')`(PK만)로도 통과 가능한 special-case 압력이 큼 — 하지만 그건 `to_field='unique_field'` 참조를 깨므로 일반화 실패. 얇은 테스트 너머로 일반화해야 함.
  - **K-Domain 깊이**: `get_candidate_relations_to_delete` + `foreign_related_fields` 조합을 알아야 정답. 이건 모델빨/지식빨 구간.
  - 단일 파일(L1)·소규모(~20줄)라 T6(멀티파일 조율)까지는 안 가지만, S6 refactor + 깊은 도메인 + 넓은 P2P trap의 결합이 T5 전형 프로파일(L1/L2 + S6, 멀티헌크, overfit·regression 고위험 또는 깊은 도메인)과 정확히 일치.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/deletion.py`
  - `Collector._has_signal_listeners(model)` — 신규 헬퍼.
  - `Collector.can_fast_delete()` — 인라인 시그널 체크를 헬퍼 호출로 교체.
  - `Collector.collect()` — 컬럼 축소 로직 삽입.
  - 모듈 상단 `from itertools import chain` 추가.
- **근본 원인**: `collect()`가 `related_objects()`가 만든 queryset(모델 전체 필드 SELECT)을 그대로 `field.remote_field.on_delete(...)`에 넘긴다. 삭제 그래프를 그릴 때 collector는 객체 존재 여부와 참조되는 FK 값만 필요한데, 모든 컬럼(거대 `TextField` 포함)을 fetch해 불필요한 비용 + 깨진 바이트 디코드 크래시를 유발.
- **수정 요지**:
  - 시그널 리스너 존재 체크를 `_has_signal_listeners()`(신규 헬퍼, `pre_delete`/`post_delete`만 검사)로 추출해 `can_fast_delete`와 `collect`가 공유. **주의**: 골드패치는 `can_fast_delete`의 기존 3-조건 `if (pre_delete OR post_delete OR m2m_changed)`를 `self._has_signal_listeners(model)` 한 줄로 통째 교체하므로, `m2m_changed.has_listeners` 체크가 `can_fast_delete`에서 **제거**된다. 즉 동작 보존이 아니라, `m2m_changed` 리스너만 연결된 경우 기존엔 fast-delete가 차단됐던 것이 이제는 차단되지 않도록 **동작이 변경(완화)**된다.
  - `elif sub_objs:` → `else:`로 전환 후, **시그널 수신자가 없고 `sub_objs.query.select_related`도 없을 때만** `get_candidate_relations_to_delete(related_model._meta)`로 그 모델을 참조하는 모든 rel의 `field.foreign_related_fields`의 `attname`을 `chain.from_iterable`로 평탄 수집 → `sub_objs = sub_objs.only(*referenced_fields)`로 fetch 컬럼 축소.
  - 그 후 `if sub_objs:`로 존재 확인 → `on_delete(...)` 호출(기존 truthiness 단락 의미 보존).
  - 시그널 receiver가 연결되면 객체가 사용자 코드에 노출되므로 deferring 비활성(전체 필드 유지). `select_related` 동반 시도 `only()`와의 상호작용이 까다로워 의도적으로 최적화 스킵(주석으로 명시).

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_only_referenced_fields_selected (delete.tests.DeletionTests)`.
- **동작/픽스 증명**:
  - `tests/delete/models.py`에 `Origin` / `Referrer`(`unique_field` unique IntegerField, `large_field` TextField) / `SecondReferrer`(`referrer` FK + `other_referrer` FK `to_field='unique_field'`) 추가.
  - `origin.delete()` 시 캡처된 첫 SELECT SQL이 `Referrer.objects.only('id', 'unique_field')...`의 SQL과 **정확히 문자열 일치**해야 함 → `large_field`(TextField)는 SELECT되지 않음을 증명. `to_field='unique_field'` FK 덕분에 PK(`id`)뿐 아니라 `unique_field`까지 참조 필드로 포함되어야 정답.
  - 반대로 `pre_delete`/`post_delete`를 `connect`한 두 subTest에서 SQL에 `large_field`가 `assertIn`으로 포함됨을 확인 → 시그널 가드 분기 검증. `assertNumQueries(2)`로 쿼리 수도 고정.
- **overfit 관점**: 단일 FAIL_TO_PASS라 얇아 보이지만, `to_field` FK + 시그널 on/off subTest로 "PK-only 순진 해법"과 "select_related 누락 해법"을 구별하도록 설계됨 — 그래서 CEGIS급 함정은 일부 완화. 다만 `select_related` 가드 경로 자체를 직접 검증하는 테스트는 없어, 그 분기는 PASS_TO_PASS 회귀로만 간접 보호됨(미검증 입력공간 존재 → overfit-risk 플래그 유지).
- **regression 관점**: 41 PASS_TO_PASS가 fast-delete/on-delete/multi-table-inheritance/m2m 경로를 광범위 커버. 컬럼 축소가 참조 필드를 누락하면 `on_delete` 핸들러가 FK 값을 읽지 못해 후속 cascade가 깨지므로 이들이 회귀 가드 역할.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 네이티브 traceback `deletion.py:223 collect()` → `elif sub_objs:` 라인 + DB 디버그 로그(전체 컬럼 SELECT)가 직접 신호. hints의 메인테이너 설명("collector가 SELECT로 그래프를 그린다, 참조 필드만 필요")으로 `collect()` 내부의 `related_objects()` → `on_delete` 데이터플로우와 `can_fast_delete`의 시그널 게이트를 함께 읽는다. → 파일 `django/db/models/deletion.py`, 함수 `Collector.collect` / `Collector.can_fast_delete`.
2. **픽스와 올바른 일반화 이유**: `else` 분기에서 fetch 컬럼을 줄이되, **무엇이 참조되는지를 모델 메타에서 동적으로 계산**(`get_candidate_relations_to_delete` + `foreign_related_fields`)한다. PK 하드코딩이 아니라 "이 모델을 가리키는 모든 FK가 실제 참조하는 컬럼 집합"을 일반적으로 수집하기 때문에 `to_field` 같은 비-PK 참조도 자동 포함 → overfit이 아닌 올바른 일반화. 시그널 receiver가 있으면 객체가 사용자 코드에 노출되어 임의 필드 접근 가능 → 그땐 최적화를 끄는 게 의미적으로 옳음.
3. **regression 안전**: FastDeleteTests(`m2m_changed` 시그널 경로 포함)·OnDeleteTests(`to_field`/inheritance/cascade)·DeletionTests(쿼리 수 검증)를 안 깨야 한다. 헬퍼 추출 시 `can_fast_delete`의 시그널 체크가 `_has_signal_listeners()`(pre/post만) 호출로 교체되면서 `m2m_changed.has_listeners` 분기는 **보존되지 않고 제거**되는데, FastDeleteTests의 `m2m_changed` 경로가 회귀하지 않는지는 P2P로 확인된다. `only()`는 시그널·`select_related` 부재 시에만 적용해 노출 경로의 전체-필드 계약을 지킨다. `assertNumQueries` 기반 테스트들이 쿼리 수 불변을 보장하므로 분기 추가가 추가 쿼리를 내지 않도록 truthiness 단락(`if sub_objs:`)을 유지.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `.only('id')`로 PK만 남겨 `to_field` FK를 깨거나(FAIL_TO_PASS의 `unique_field` 케이스로 적발), (b) `select_related` 가드를 빼서 `only()`와 충돌해 P2P 회귀를 내거나, (c) 시그널 가드를 빼서 시그널 핸들러가 누락 필드 접근 시 추가 쿼리/오작동을 낸다. 회피법: 참조 필드를 **메타에서 동적 계산**하고, 최적화를 **세 조건(시그널 없음 ∧ select_related 없음, 그리고 시그널 receiver면 전체 유지)**으로 좁게 게이팅하는 것. 이 게이팅 재현이 난이도의 본질이다.
