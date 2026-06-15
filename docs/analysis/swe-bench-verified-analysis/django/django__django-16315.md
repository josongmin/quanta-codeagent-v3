---
instance_id: django__django-16315
repo: django/django
base_commit: 7d5329852f19c6ae78c6f6f3d3e41835377bf295
version: "4.2"
difficulty: 15 min - 1 hour
created_at: 2022-11-22T09:44:54Z
fail_to_pass: 1
pass_to_pass: 42
gold_files: [django/db/models/query.py, django/db/models/sql/compiler.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-16315

## 문제 요약
`db_column`으로 컬럼명을 지정한 모델에서 `bulk_create(..., update_conflicts=True, unique_fields=..., update_fields=...)`를 호출하면 생성되는 `ON CONFLICT ... DO UPDATE SET` SQL이 실제 DB 컬럼명(`"BlacklistID"`) 대신 파이썬 필드명(`"blacklistid"`)을 사용한다. INSERT 절은 `db_column`을 올바르게 반영하는데 ON CONFLICT 절만 필드명을 박아서, 필드명과 db_column이 다를 때 PostgreSQL이 `column "blacklistid" does not exist` 구문 오류를 낸다. 커밋 `0f6946495a8`(upsert 기능 도입)에서 들어온 회귀이며, 이슈 본문에 잘못된 SQL과 기대 SQL이 둘 다 적혀 있어 의도가 명확하다.

## 유형 (정형화)

- **L (Localization) = L3** — 이슈가 증상(`ON CONFLICT`가 필드명 사용)은 정확히 짚지만, 올바른 픽스는 **`compiler.py`(SQL 생성 지점)와 `query.py`(필드명→Field 객체 변환 지점)가 함께** 바뀌어야 성립한다. compiler 한 곳만 `.column`을 읽게 고치면 그 시점엔 `self.query.update_fields`가 아직 문자열이라 동작하지 않는다. 즉 두 사이트의 조율이 본질이라 단일파일 L1이 아니라 multi-site L3. (단 hints_text가 두 파일·라인을 지목해주는 건 별개의 easiness 신호 — 오라클 없는 에이전트는 이 조율을 스스로 발견해야 한다.)
- **S (Repair Strategy) = S2 (+S6)** — 후보를 마구 던져 테스트로 거르는 G&V가 아니라, "필드명 문자열 ≠ db_column"이라는 **불변식을 추론으로 합성**해 올바른 표현(`f.column`)을 도출하는 constraint-reasoning(S2)이 dominant. 동시에 변환 책임을 `_check_bulk_create_options` 내부에서 `bulk_create` 본문으로 **끌어올리고**(collect-then-process), 컴파일러는 Field 객체를 받는다는 계약으로 재배치하는 작은 **구조 변경(S6)**이 보조로 필요하다. 한 줄 상수교체가 아니라 "어디서 문자열이 Field로 승격되는가"를 옮기는 일이라 S6가 따라붙는다.
- **K (Knowledge) = K-Domain** — Django ORM 내부 지식이 병목이다. `Model._meta.get_field(name)`이 Field 객체를 주고, `Field.column`이 `db_column`(미지정 시 필드명)을 반영하며, `pk`가 별칭이라 `opts.pk.name`으로 풀어야 한다는 것, 그리고 SQL insert compiler가 받는 게 컬럼이어야 한다는 계약 — 이 사슬을 알아야 한다. 일반 파이썬 추론(K-Gen)으로는 `.column` 추상화에 도달 못 한다.

**Primary type = T-DomainBound** — 진짜 난점이 "어디인지 찾기"(L2 diffuse가 아님, hints가 위치를 줌)도 아니고 overfit 위험(S4)도 아니다. `db_column`/`Field.column`/`_meta.get_field`/`pk` 별칭이라는 Django ORM 내부 계약을 정확히 다뤄야 픽스가 성립한다는 점에서 K-Domain이 dominant. T-DiffuseLoc 후보였으나(L3) localize는 이슈 신호로 쉬워서 탈락, 구조변경(S6)도 작아 T-DesignRefactor는 아니다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 difficulty 라벨 "15 min - 1 hour"(prior로 T3~T4 경계)와 정합적이되, 다음 구조적 피처가 T4로 민다:

- **multi-site 조율(L3)**: 2파일·3헌크(query.py 2헌크 + compiler.py 1헌크)가 **함께** 바뀌어야 하고, 한쪽만 고치면 작동 안 하거나 깨진다. 단일파일·<5줄(≈48% solve)이 아니다.
- **변환 위치 이동(S6) + 중복 제거**: `_check_bulk_create_options` 안의 기존 `get_field` 변환 두 줄을 **반드시 제거**해야 한다. 안 그러면 이미 Field 객체가 된 입력에 다시 `get_field`를 호출해 깨진다. "추가"가 아니라 "이동"이라 난도가 한 단계 위.
- **도메인 지식(K-Domain)**: `.column` 추상화·`pk` 별칭·`get_field`를 알아야 함.
- **넓은 P2P trap(regression-trap)**: PASS_TO_PASS 42개가 모두 같은 `BulkCreateTests`라 변환 경로를 잘못 옮기면 광범위 회귀. 특히 `test_update_conflicts_pk_in_update_fields`, `test_update_conflicts_invalid_*`, `test_update_conflicts_no_update_fields`가 가드/별칭/검증 순서를 직접 친다.

T5까지 안 가는 이유: 패치가 ~10줄로 작고, overfit 고위험(S4)이 아니며, localize가 hints로 쉽다. has-repro(이슈에 잘못된 SQL·기대 SQL 명시)도 easiness 쪽 신호라 T4에서 멈춘다.

## 골드패치 분석
- **건드린 파일/함수**
  - `django/db/models/query.py` — `QuerySet.bulk_create()`, `_check_bulk_create_options()`
  - `django/db/models/sql/compiler.py` — `SQLInsertCompiler.as_sql()`
- **근본 원인**: `unique_fields`/`update_fields`가 컴파일러까지 파이썬 **필드명 문자열**로 전달됐고, `on_conflict_suffix_sql()`이 그 문자열을 그대로 컬럼명으로 SQL에 박았다. INSERT 절은 별도 경로로 `db_column`을 쓰지만 ON CONFLICT 절만 필드명을 써서, `db_column`이 다르면 존재하지 않는 컬럼을 참조한다.
- **수정 요지**
  1. `bulk_create()` 본문에서 `unique_fields`를 `[self.model._meta.get_field(opts.pk.name if name == "pk" else name) for name in unique_fields]`로, `update_fields`를 `if update_fields:` 가드 하에 `[self.model._meta.get_field(name) for name in update_fields]`로 **미리 Field 객체로 변환**(pk 별칭 해소 포함).
  2. 이에 맞춰 `_check_bulk_create_options()` 안의 **중복 변환 두 줄**(`update_fields`/`unique_fields`를 `get_field`로 매핑하던 코드)을 제거 — 이제 검증 시점에 이미 Field 객체.
  3. `compiler.py`의 `as_sql()`에서 `on_conflict_suffix_sql()`에 넘길 때 `self.query.update_fields`/`unique_fields`(Field 객체)에서 `(f.column for f in ...)`로 **`.column`(db_column 반영값)을 전달**.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_update_conflicts_unique_fields_update_fields_db_column` — `supports_update_conflicts` + `supports_update_conflicts_with_target` 둘 다 있는 DB에서만 실행(`skipUnlessDBFeature`).
- **동작**: 신규 모델 `FieldsWithDbColumns`(`rank = IntegerField(unique=True, db_column="rAnK")`, `name = CharField(..., db_column="oTheRNaMe")`)로 필드명과 db_column이 **대소문자 섞여 일부러 다르게** 잡혀 있다. rank 1/2 두 행 삽입 후, 같은 rank로 충돌하는 객체를 `update_conflicts=True, unique_fields=["rank"], update_fields=["name"]`로 bulk_create.
- **픽스 증명**: 픽스 전엔 ON CONFLICT가 `"rank"`/`"name"`을 써서 DB 오류. 픽스 후엔 `"rAnK"`/`"oTheRNaMe"`로 정상 upsert → `count == 2`(새 행 없음) & `values("rank","name")`가 `{rank:1,name:"c"}`/`{rank:2,name:"d"}`로 갱신됨을 `assertCountEqual`로 확인. db_column이 다른 행을 쓴 게 핵심 판별.
- **overfit 관점**: 픽스가 `.column` 추상화를 쓰므로 db_column 미지정(=필드명과 동일) 케이스도 자동으로 올바르다. 테스트는 db_column이 다른 1개 케이스만 보지만, 픽스는 special-case 분기가 아니라 일반 변환이라 overfit-risk 낮음(그래서 flag에 미포함).
- **regression 관점**: PASS_TO_PASS 42개가 동일 `BulkCreateTests`. 변환을 `bulk_create` 본문으로 옮기면서 `pk` 별칭·`if update_fields:` 빈 가드·`_check_bulk_create_options`의 검증 순서를 유지해야 `*_pk_in_update_fields`/`*_invalid_*`/`*_no_update_fields`가 안 깨진다 → regression-trap.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 잘못된 SQL 문자열 `ON CONFLICT(... DO UPDATE SET ...)`를 키워드로 `on_conflict_suffix_sql` 호출 지점 → `SQLInsertCompiler.as_sql()`(`compiler.py`)을 찾는다. 거기서 인자로 넘기는 `self.query.update_fields`/`unique_fields`가 **무엇**(필드명 문자열 vs Field 객체)인지 역추적하면 `QuerySet.bulk_create()`(`query.py`)와 `_check_bulk_create_options()`로 이어진다. hints_text가 두 파일·라인을 직접 지목하므로 검증용 확인 정도.

2. **픽스와 올바른 일반화**: 컴파일러는 컬럼명을 써야 하므로 `(f.column for f in ...)`로 바꾼다. 단 그 전에 `update_fields`/`unique_fields`가 Field 객체여야 하므로, **변환을 `bulk_create` 본문으로 끌어올린다**(`get_field` + `pk`→`opts.pk.name` 별칭 해소). `Field.column`은 db_column이 있으면 그 값, 없으면 필드명을 주므로 **모든 모델에 대해 올바른 일반화** — db_column 미지정 케이스도 그대로 통과한다(special-case 아님). INSERT 절이 이미 `.column`을 쓰던 것과의 대칭을 회복하는 것이 핵심 직관.

3. **regression 안전**: `_check_bulk_create_options`의 기존 변환 두 줄을 **제거**해야 한다(이동이지 추가가 아님) — 안 그러면 Field 객체에 `get_field` 재호출로 `*_invalid_*`/검증 테스트가 깨진다. `pk` 별칭(`*_unique_fields_pk`), 빈 `update_fields` 가드(`*_no_update_fields`), pk-in-update 거부(`*_pk_in_update_fields`)를 유지하면 P2P 42개가 보존된다.

4. **함정 회피**: 오라클 없는 에이전트가 흔히 빠지는 곳 — (a) `compiler.py` 한 줄만 `.column`으로 고치고 끝내면, 그 시점 `update_fields`는 아직 문자열이라 `.column` AttributeError 또는 무동작. **반드시 query.py 선행 변환과 묶어야** 한다. (b) `_check_bulk_create_options`의 기존 변환을 안 지우면 이중 `get_field`로 깨짐 → "추가"가 아니라 "위치 이동"임을 인지해야 함. (c) `pk` 별칭과 `if update_fields:` 빈 가드를 빠뜨리기 쉬움. (d) `Field.name`이 아니라 `Field.column`을 써야 db_column이 반영된다는 ORM 계약을 모르면 잘못된 속성으로 또 필드명을 박는다.
