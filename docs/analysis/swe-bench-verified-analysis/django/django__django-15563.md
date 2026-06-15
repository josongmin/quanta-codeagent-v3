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
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-15563

## 문제 요약
구체(concrete) 다중 상속(MTI: `Child(Base, OtherBase)`)에서 `Child.objects.update(field_otherbase=...)`를 호출하면, 두 번째 부모(`OtherBase`)의 필드가 자식 행에 연결된 부모 행이 아니라 **무관한 `OtherBase` 인스턴스**에 적용된다. 원인은 update가 related-parent 갱신 시 자식의 PK(첫 부모 `Base`의 `base_ptr_id`) 값 리스트를 **그대로** 두 번째 부모 테이블의 `WHERE otherbase_id IN (...)`에 재사용하기 때문이다. 결과적으로 자식은 안 바뀌고(`field_otherbase=0,1` 그대로), 엉뚱한 `OtherBase` 행이 55로 덮어써지는 silent data corruption이 발생한다. problem_statement에 실제 SQL 트레이스(`SELECT base_ptr_id FROM child` → `UPDATE otherbase WHERE otherbase_id IN (1,2)`)와 재현 시퀀스가 다 들어 있다.

## 유형 (정형화)

- **L (Localization) = L3 — Multi-site.** 픽스가 `compiler.py`의 `SQLUpdateCompiler.pre_sql_setup`과 `subqueries.py`의 `UpdateQuery.get_related_updates` **두 파일/함수에 조율되어 함께** 바뀌어야 한다. `related_ids` 자료구조(list→dict)를 매개로 생산자(compiler)와 소비자(subqueries)가 강결합돼 있어 한쪽만 고치면 KeyError/오필터가 난다. hints_text가 두 심볼을 직접 지목하므로 "어디"를 찾는 비용 자체는 낮지만, 정의상 ≥2 함수 동시 수정 = L3.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning).** 한 줄 가드가 아니라 **자료구조 재설계**가 본질이다: `related_ids: list[int]` → `dict[Model, list[int]]`로 바꾸고, `pre_sql_setup`이 select하는 컬럼 집합을 부모별로 확장(`related_ids_index`로 인덱스 부킹)하며, 수집 단계를 `collections.defaultdict(list)`로 부모별 분리하는 collect-then-distribute 구조. 동시에 "어느 부모에 새 PK select가 필요한가"를 `get_path_to_parent` + `join_field.primary_key`로 판별하는 불변식 추론(S2)이 들어간다 — PK 체인으로 연결된 부모는 공유 pk(index 0) 재사용, 비-체인 부모만 별도 select. 이 분기 조건을 정확히 합성해야 하므로 S6가 dominant, S2가 보조.
- **K (Knowledge) = K-Domain.** django ORM의 MTI parent_link 메커니즘, `Options.get_path_to_parent`(모델 `_meta`의 메서드; 패치는 `meta = query.get_meta()`로 얻은 `Options` 인스턴스에 `meta.get_path_to_parent(related)`로 호출 — `Query`의 메서드가 아님, 정의: django/db/models/options.py:660), `join_field.primary_key`, `add_fields`/`MULTI` execute 경로, related_updates 라이프사이클 등 query-compiler 내부 지식이 병목. 일반 파이썬 추론으로는 분기 조건을 도출할 수 없다.

**primary type = T-DesignRefactor.** 진짜 난점이 "위치 찾기"(L3지만 hints가 알려줌)나 "테스트로 수렴"(S3/S4 아님)이 아니라 **조율된 구조 변경**(list→dict + select 확장 + 부모별 수집)에 있다. T-DiffuseLoc은 localize가 어려운 게 핵심일 때인데 여기선 포인터가 명확하므로 배제, T-DomainBound은 지식이 dominant 병목일 때인데 여기선 지식이 enabler지 핵심 작업은 refactor이므로 S6 = T-DesignRefactor가 정확.

## 난이도 티어
**Tier = T5 (어려움).** 공식 라벨은 "15분-1시간"(prior로 T3~T4 시사)이지만 구조적 피처가 T5로 민다:
- **멀티파일·멀티헌크 조율 수정(L3)**: 2파일 × 4헌크, `related_ids` 계약을 list→dict로 바꾸는 cross-file 동기 변경. ICLR 2024 컷에서 멀티파일 조율은 solve-rate를 강하게 떨어뜨린다.
- **S6 design refactor + 비자명한 불변식 분기**: `get_path_to_parent` 전 경로가 `primary_key`인지로 "공유 pk 재사용 vs 별도 select"를 가르는 통찰이 없으면 부분 패치가 된다.
- **넓은 regression-trap(P2P 29개)**: `model_inheritance_regress`의 기존 단순 MTI update, `test_id_field_update_on_ancestor_change`, abstract/o2o-to-parent 등 인접 동작 다수를 안 깨야 한다. 모든 부모에 새 PK를 무조건 select하는 naive 변형은 이들을 회귀시키기 쉽다.
- **has-repro로 약간 완화**: 네이티브 SQL 트레이스 + 재현 시퀀스가 있어 "버그 인지"는 쉽다(easiness 신호). 그래서 T6(>4시간/대규모/거의 전 실패)까지는 아니다. 하지만 repro가 픽스의 **올바른 일반화**를 알려주진 않으므로 T4로 내릴 만큼은 아님 → T5 확정.

공식 difficulty와의 차이: 시간라벨은 "이 코드를 아는 django 코어 개발자의 구현시간"이라 short지만, 오라클 없는 에이전트에게는 (a)도메인 내부 API 발견 (b)분기 불변식 합성 (c)멀티파일 계약 동기화 (d)광범위 P2P 회귀 회피가 모두 걸려 있어 에이전트 난이도가 더 높다.

## 골드패치 분석
- **건드린 파일·함수**
  - `django/db/models/sql/compiler.py` : `SQLUpdateCompiler.pre_sql_setup`
  - `django/db/models/sql/subqueries.py` : `UpdateQuery.get_related_updates`
- **근본 원인**: `pre_sql_setup`이 자식의 PK 하나(`query.add_fields([meta.pk.name])`)만 select하고, 그 단일 리스트(`self.query.related_ids = idents`)를 **모든** related parent update가 `pk__in` 필터로 공유했다. PK 체인으로 연결된 부모는 자식 pk == 부모 pk라 우연히 맞지만, **PK 체인 밖의 부모**(`OtherBase`처럼 `base_ptr`가 아닌 독립 AutoField를 가진)는 자식의 `base_ptr_id` 값으로 자기 `otherbase_id`를 필터링해 무관한 행을 갱신했다.
- **수정 요지**
  1. `pre_sql_setup`: `fields = [meta.pk.name]`로 시작해, `self.query.related_updates`의 각 부모마다 `meta.get_path_to_parent(related)`의 모든 `path.join_field.primary_key`가 True면 — PK 체인 존재 — `(related, 0)`으로 공유 pk(index 0) 재사용 기록, 아니면 `(related, len(fields))`로 인덱스를 기록하고 `fields.append(related._meta.pk.name)`로 해당 부모의 PK를 select에 추가. 이 매핑을 `related_ids_index`에 모은다.
  2. MULTI 실행 루프에서 `related_ids = collections.defaultdict(list)`를 만들어, 각 row에 대해 `related_ids_index`의 `(parent, index)`별로 `r[index]`를 부모별로 분리 수집. `self.query.related_ids`를 단일 리스트가 아닌 **`dict[Model, list]`**로 저장.
  3. `get_related_updates`: `query.add_filter("pk__in", self.related_ids)` → **`self.related_ids[model]`**로 변경해 각 부모 update가 자기 부모에 맞는 PK 집합으로만 필터링.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_mti_update_parent_through_child`, `test_mti_update_grand_parent_through_child` (`model_inheritance_regress.tests.ModelInheritanceTest`).
- **픽스 증명 방식**: 두 테스트 모두 **먼저 무관한 부모/조부모 인스턴스**(`Politician.objects.create()`)를 생성해 PK 오염을 노출시킨 뒤, MTI 자식(`Congressman` / `Senator`)을 생성하고 `update(title="senator 1")`를 실행한다. 버그가 있으면 자식의 PK가 엉뚱한 Politician 행을 갱신하고 자식의 `title`은 그대로라, `Congressman.objects.get().title == "senator 1"` assertEqual이 실패한다. 픽스 후엔 부모별 정확한 PK로 필터링되어 자식을 통한 부모/조부모 필드 갱신이 성립. grand_parent 케이스는 2단계 조상 체인(`get_path_to_parent`가 다중 hop)까지 커버해 단순 1-hop만 고친 부분 패치를 적발한다.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇아 보이지만, 두 케이스가 1-hop과 2-hop 조상을 분리 검증하고 "무관 부모 오염"이라는 핵심 결함 신호를 직접 관찰하므로 special-case 통과로 회피하기 어렵다. 다만 PK 체인 밖 부모(`OtherBase` 류, 독립 AutoField)의 update 케이스는 P2P/F2P에 명시적으로 없어, `get_path_to_parent`/`primary_key` 분기를 빠뜨린 채 "모든 부모를 무조건 별도 select"하는 변형도 이 테스트는 통과할 수 있다(overfit-risk는 낮지만 0은 아님).
- **regression 관점**: P2P 29개가 `model_inheritance_regress` 전반(단순 MTI update, `test_id_field_update_on_ancestor_change`, abstract base m2m, o2o-to-parent, non-pk connector 등)을 덮는다. select 컬럼을 무조건 늘리거나 인덱스 매핑을 어긋나게 하면 기존 PK-체인 부모 update가 깨져 이 P2P가 RED가 된다 → regression-trap 강함.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement의 SQL 트레이스(`SELECT base_ptr_id FROM child` → `UPDATE otherbase WHERE otherbase_id IN (...)`)가 "자식 PK가 무관 부모 테이블 WHERE에 흘러간다"를 지목 → `update`의 related-parent 처리 경로인 `SQLUpdateCompiler.pre_sql_setup`(compiler.py ~1836, `query.add_fields([pk.name])` + MULTI 루프에서 `related_ids` 생성)과 그 소비처 `UpdateQuery.get_related_updates`(subqueries.py, `add_filter("pk__in", self.related_ids)`)로 수렴. hints_text가 이 두 심볼과 "list→dict, parent_link로 populate" 방향까지 명시하므로 localize 자체는 저비용.
2. **픽스(왜 올바른 일반화인가)**: 단일 `related_ids` 리스트가 "모든 부모는 자식 pk로 식별 가능"이라는 잘못된 가정을 인코딩한 게 근본이다. 올바른 일반화는 "부모별 식별자를 부모별로 따로 관리"하는 것 — `related_ids`를 `dict[Model, list]`로 만들고, **PK 체인 여부에 따라** 공유 pk(index 0)를 재사용하거나 부모 PK를 별도 select(`fields.append(...)` + 인덱스 부킹)한다. `get_path_to_parent` 전 경로가 `primary_key`인지 검사하는 분기가 일반화의 핵심: PK 체인 부모는 자식 pk가 곧 부모 pk라 추가 select가 불필요(성능/회귀 안전), 비-체인 부모만 자기 pk를 따로 select. 이것이 특정 테스트가 아니라 "임의 깊이의 MTI 조상 × 임의 parent_link 구성"에 대해 성립하는 이유.
3. **regression 안전**: P2P 29개 중 기존에 잘 돌던 단순 MTI(PK 체인 부모)의 update가 깨지면 안 된다. 골드는 PK 체인 부모에 대해 `(related, 0)`으로 **공유 pk를 그대로 재사용**하므로 select 컬럼·필터가 종전과 동일 → byte-동등에 가깝게 보존. `test_id_field_update_on_ancestor_change`, non-pk connector, o2o-to-parent 등도 분기 조건이 정확하면 영향 없음. `defaultdict(list)`라 비어 있는 부모 키 접근도 안전.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `related_ids`만 dict로 바꾸고 `pre_sql_setup`의 select 확장을 안 해 `r[index]`가 IndexError/잘못된 값이 됨(생산자-소비자 계약 비동기). (b) `get_path_to_parent`/`join_field.primary_key` 분기를 생략하고 **모든** 부모에 새 PK를 무조건 select → PK 체인 부모까지 컬럼이 늘어 기존 P2P 회귀, 동시에 불필요 작업. (c) compiler.py만 고치고 subqueries.py의 `self.related_ids` → `self.related_ids[model]` 동기 변경을 빠뜨려 TypeError. 회피법: 이 두 함수가 `related_ids` 자료구조로 강결합임을 먼저 인지하고 **list→dict 계약 변경을 양쪽에 동시 반영**, select 인덱스 매핑(`related_ids_index`)을 명시적으로 부킹, 그리고 "공유 pk 재사용 vs 별도 select" 분기를 `get_path_to_parent`로 도메인-정확하게 구현하는 것.
