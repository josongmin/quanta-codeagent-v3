---
instance_id: django__django-15563
repo: django/django
base_commit: 9ffd4eae2ce7a7100c98f681e2b6ab818df384a4
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-04-06T02:48:01Z
fail_to_pass: 2
pass_to_pass: 29
gold_files: [django/db/models/sql/compiler.py, django/db/models/sql/subqueries.py]
---

# django__django-15563

## 문제 요약
다중 상속(MTI: 여러 구체 부모 클래스를 상속한 자식 모델)에서 `Child.objects.update(field_otherbase=...)`를 호출하면, 두 번째 부모(`OtherBase`)의 필드가 자식 인스턴스가 아니라 엉뚱한 `OtherBase` 인스턴스에 적용된다. 이는 update 시 자식의 PK(첫 번째 부모 `Base`의 base_ptr_id) 값을 그대로 두 번째 부모 테이블의 WHERE 절(`otherbase_id IN (...)`)에 재사용하기 때문이다. 사용자는 자식 행에 연결된 부모 행만 갱신되길 기대했으나, 무관한 부모 행이 망가지고 자식은 변경되지 않았다.

## 유형 분류
- 버그 카테고리: logic / edge-case (concrete MTI 다중 상속 특수 케이스)
- 서브시스템: django ORM query — SQLUpdateCompiler / UpdateQuery (related updates)
- 증상 타입: silent-wrong (예외 없이 잘못된 행을 갱신, 데이터 손상)
- 로컬라이제이션 신호: problem_statement의 SQL 트레이스가 결정적 — `SELECT base_ptr_id FROM child` 후 `UPDATE otherbase WHERE otherbase_id IN (1,2)`. 부모 PK 선택과 related update 필터링 로직이 핵심이며, hints_text가 `UpdateQuery.related_ids`와 `SQLUpdateCompiler.pre_sql_setup`을 직접 지목한다.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/sql/compiler.py`:`SQLUpdateCompiler.pre_sql_setup`
  - `django/db/models/sql/subqueries.py`:`UpdateQuery.get_related_updates`
- 근본 원인: `related_ids`가 단일 리스트였고, 모든 related parent update가 동일한 자식 PK 리스트를 `pk__in` 필터로 공유했다. PK 체인으로 연결되지 않은 두 번째 부모(`OtherBase`)는 자기 고유 PK(`otherbase_id`)가 아닌 자식의 base_ptr_id 값으로 필터링되어 무관한 행을 갱신했다.
- 수정 요지:
  - `pre_sql_setup`에서 PK 한 개만 select하던 것을, `related_updates` 각 부모에 대해 `meta.get_path_to_parent(related)`로 PK 체인 여부를 검사. 체인이 전부 primary_key면 인덱스 0(공유 pk) 재사용, 아니면 해당 부모의 `pk.name`을 select 필드에 추가하고 인덱스를 기록(`related_ids_index`).
  - 실행 결과를 `collections.defaultdict(list)`에 부모별로 분리 수집(`r[index]`)하고, `self.query.related_ids`를 단일 리스트가 아닌 `dict[Model, list]`로 저장.
  - `get_related_updates`는 `query.add_filter("pk__in", self.related_ids)` → `self.related_ids[model]`로 변경해 부모별 올바른 PK 집합으로 필터링.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_mti_update_parent_through_child`, `test_mti_update_grand_parent_through_child` (model_inheritance_regress.tests.ModelInheritanceTest)
- 테스트가 픽스를 증명하는 방식: 무관한 부모 인스턴스(`Politician.objects.create()`)를 먼저 만들어 PK 오염을 노출시킨 뒤, `Congressman`/`Senator`(MTI 자식)를 생성하고 `update(title="senator 1")`를 실행한다. 버그가 있으면 무관한 Politician 행이 갱신되고 자식은 그대로라 `Congressman.objects.get().title`이 기대값과 달라진다. 픽스 후엔 부모별 정확한 PK로 필터링되어 자식을 통해 부모/조부모 필드가 올바르게 갱신됨을 `assertEqual`로 확인. grand_parent 케이스는 2단계 조상 체인까지 커버.

## 공략 포인트 (뭘 조져야)
- 어디부터: `SQLUpdateCompiler.pre_sql_setup`(compiler.py ~1836줄)의 `query.add_fields([pk.name])` + 그 아래 MULTI 실행 루프에서 `idents`/`related_ids`를 만드는 부분. 그리고 짝이 되는 `subqueries.py`의 `get_related_updates`. 두 곳은 `related_ids` 자료구조로 강하게 결합돼 있어 동시에 봐야 한다.
- 함정/난이도: (1) 단순히 `related_ids`만 dict로 바꾸면 `pre_sql_setup`이 부모별 PK를 select하지 않아 KeyError/잘못된 값. select 필드 확장과 인덱스 매핑까지 일관되게 해야 함. (2) PK 체인으로 연결된 부모(공유 pk 재사용 가능)와 비-체인 부모(별도 select 필요)를 `get_path_to_parent` + `join_field.primary_key`로 구분하는 게 핵심 통찰 — 모든 부모에 새 필드를 추가하면 불필요하고 회귀(PASS_TO_PASS의 단순 MTI update) 위험.
- 우리 에이전트 관점: 버그 재현은 쉽지만 올바른 일반 해법(PK 체인 vs 비-체인 분기)을 도출하려면 MTI parent_link 메커니즘과 `get_path_to_parent` 내부를 이해해야 함. 멀티파일 동기 수정 + `defaultdict` 인덱스 부킹이라 부분 패치로는 PASS_TO_PASS 회귀를 깨기 쉬운 지점.
