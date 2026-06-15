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
---

# django__django-16315

## 문제 요약
`db_column`으로 컬럼명을 지정한 모델에서 `bulk_create(..., update_conflicts=True, unique_fields=..., update_fields=...)`를 호출하면 생성되는 `ON CONFLICT ... DO UPDATE SET` SQL이 실제 DB 컬럼명(`"BlacklistID"`) 대신 파이썬 필드명(`"blacklistid"`)을 사용한다. INSERT 절은 `db_column`을 올바르게 쓰는데 ON CONFLICT 절만 필드명을 써서 PostgreSQL이 `column "blacklistid" does not exist` 구문 오류를 낸다. 사용자는 양쪽 모두 실제 컬럼명을 쓰길 기대했다.

## 유형 분류
- 버그 카테고리: logic / regression (커밋 0f6946495a8ec955b471ca1baaf408ceb53d4796 에서 도입된 회귀)
- 서브시스템: django ORM — bulk_create / SQL insert compiler (ON CONFLICT upsert)
- 증상 타입: 예외 (DB가 잘못된 SQL에 ProgrammingError, 구문 오류)
- 로컬라이제이션 신호: "ON CONFLICT uses the field name and not the db_column", 정확한 잘못된 SQL 문자열, `update_conflicts`/`unique_fields`/`update_fields` 키워드. 힌트 텍스트가 두 파일과 라인까지 지목.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/models/query.py`: `QuerySet.bulk_create()`, `_check_bulk_create_options()`
  - `django/db/models/sql/compiler.py`: `SQLInsertCompiler.as_sql()`
- 근본 원인: `unique_fields`/`update_fields`가 컴파일러까지 파이썬 **필드명 문자열**로 전달됐고, `on_conflict_suffix_sql()`이 이 문자열을 그대로 컬럼명처럼 SQL에 박았다. 따라서 `db_column`으로 실제 컬럼명이 다른 경우 ON CONFLICT 절이 존재하지 않는 컬럼을 참조.
- 수정 요지:
  1. `query.py`에서 `bulk_create()` 본문이 `unique_fields`/`update_fields`를 `self.model._meta.get_field(name)`로 미리 **Field 객체로 변환**(단, `update_fields`는 `if update_fields:` 가드 추가, `unique_fields`는 `"pk"` 별칭을 pk 이름으로 풀어준 뒤 변환).
  2. 이에 따라 `_check_bulk_create_options()` 안에 있던 중복 변환(`update_fields`/`unique_fields`를 get_field로 매핑하던 두 줄)을 제거 — 이제 들어올 때 이미 Field 객체.
  3. `compiler.py`의 `as_sql()`에서 `on_conflict_suffix_sql()`에 넘길 때 필드명 대신 `(f.column for f in self.query.update_fields)`, `(f.column for f in self.query.unique_fields)`로 **`.column`(= db_column 반영)** 을 전달.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_update_conflicts_unique_fields_update_fields_db_column` (`supports_update_conflicts` + `supports_update_conflicts_with_target` 둘 다 있는 DB에서만).
- 새 모델 `FieldsWithDbColumns`: `rank = IntegerField(unique=True, db_column="rAnK")`, `name = CharField(..., db_column="oTheRNaMe")` — 필드명과 db_column이 일부러 대소문자 섞어 다르게.
- 재현: rank 1/2 두 행 삽입 후, 같은 rank로 충돌하는 객체를 `update_conflicts=True, unique_fields=["rank"], update_fields=["name"]`로 bulk_create. 픽스 전엔 `"rAnK"`/`"oTheRNaMe"` 대신 `"rank"`/`"name"`을 ON CONFLICT에 써 DB 오류. 픽스 후엔 정상 upsert.
- 기대 출력: count는 여전히 2(새 행 추가 없음), 값은 `{rank:1,name:"c"}`, `{rank:2,name:"d"}`로 업데이트됨을 `assertCountEqual`로 확인.

## 공략 포인트 (뭘 조져야)
- 어디부터: 잘못된 SQL의 `ON CONFLICT`/`DO UPDATE SET`을 키로 `compiler.py`의 `SQLInsertCompiler`와 `on_conflict_suffix_sql` 호출 지점을 찾는 게 시작점. 거기서 `self.query.update_fields`/`unique_fields`가 무엇(필드명 vs Field 객체)인지 역추적하면 `query.bulk_create`로 이어진다.
- 함정/난이도:
  - 멀티파일(2파일) 수정. compiler 한 곳만 `.column`으로 고치면 그 시점엔 아직 문자열이라 동작 안 함 — query.py에서 Field 객체로 변환하는 선행 작업이 필요.
  - `_check_bulk_create_options` 안의 기존 변환을 제거하지 않으면 Field 객체에 다시 get_field를 호출해 깨진다(중복 변환). 변환 위치 이동이 핵심.
  - `unique_fields`의 `"pk"` 별칭 처리와 `update_fields`의 빈 값 가드를 빠뜨리기 쉬움.
- 우리 에이전트 관점: INSERT는 멀쩡한데 ON CONFLICT만 틀린 "대칭 불일치"를 잡으려면 `.column` vs 필드명 추상화를 이해해야 함. compiler 한 줄짜리로 끝내려다 query.py 선행 변환을 놓치면 회귀(`_check_bulk_create_options`의 검증 로직이 Field 객체 가정)와 충돌할 수 있어, 두 파일을 일관되게 묶는 게 관건.
