---
instance_id: django__django-15732
repo: django/django
base_commit: ce69e34bd646558bb44ea92cecfd98b345a0b3e0
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-05-24T12:58:31Z
fail_to_pass: 1
pass_to_pass: 125
gold_files: [django/db/backends/base/schema.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-15732

## 문제 요약
단일 필드에 `unique_together = (('id',),)`처럼 이미 `unique=True`(또는 primary key)인 컬럼과 겹치는 unique_together 제약이 걸려 있으면, 이를 제거하는 마이그레이션이 실패한다. `alter_unique_together`가 해당 컬럼의 unique 제약을 찾을 때 정확히 1개만 있을 거라 가정하는데, PK 제약과 unique_together 제약 2개가 잡혀서 `ValueError: Found wrong number (2) of constraints for foo_bar(id)`로 크래시한다. 이슈에는 PostgreSQL에서 makemigrations/migrate로 재현하는 절차와 실제 traceback이 첨부돼 있고, unique_together 제약(`<table>_<field>_<hash>_uniq`)과 unique=True 제약(`<table>_<field>_key`)이 이름 규칙으로 구분 가능하다는 핵심 단서까지 제보자가 제공한다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable).** 이슈에 네이티브 traceback이 있고, `db/backends/schema.py`의 `alter_unique_together`와 "Found wrong number ... of constraints" 문자열을 직접 지목한다. L0(grep 한 방)에 가깝지만, 골드 픽스가 그 가드 줄 자체가 아니라 호출 체인 위(`alter_unique_together`의 인자)와 신규 헬퍼(`_unique_constraint_name`)에 걸쳐 있어 약간의 상향 추적이 필요 → L1.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S6 Design-Refactor).** 고칠 함수는 명확하나, "후보 제약이 2개일 때 어느 것이 unique_together의 것인가"라는 **식별 조건을 추론으로 합성**해야 한다(S2). 단순 가드 추가가 아니라, Django가 unique_together에 부여하는 **기본 이름 규칙을 재구성**해 일치 항목만 좁히는 의미론적 추론이 본질. 이를 가능케 하려고 `_create_unique_sql` 내부 `create_unique_name` 클로저를 `_unique_constraint_name(table, columns, quote)` 메서드로 추출(quote=False raw 이름 재사용)하는 소규모 구조 변경이 동반되므로 S6 보조.
- **K (Knowledge) = K-Domain.** django migrations / schema editor 내부 지식이 병목이다. `_constraint_names`의 동작, `allows_multiple_constraints_on_same_fields` feature flag의 존재와 의미, unique_together 이름 해시 규칙, `IndexName`/`_create_index_name`의 quote 분기 — 모두 ORM·DDL 백엔드 내부 지식. 일반 파이썬 추론으로는 도달 불가.
- **primary type = T-DomainBound.** 진짜 병목은 "어디를 고치나"(L1로 쉬움)도, 후보 다수 탐색(L2/L3)도 아니라, **프레임워크 내부 규약(제약 이름 생성 + feature flag + raw vs quoted 이름)을 정확히 알아야** 올바른 식별 조건을 쓸 수 있다는 점이다. 그래서 K-Domain이 dominant → T-DomainBound. (T-ConstraintReason도 후보지만, S2의 추론 내용 자체가 도메인 규약 재구성이라 K-Domain이 우선한다.)

## 난이도 티어 — **T4 (약간 어려움)**
이 티어로 미는 구조적 피처:
- **단일 파일·단일 함수 아님 → 3-site 조율.** 같은 파일(`base/schema.py`) 안이지만 `alter_unique_together`(인자 변경) + `_delete_composed_index`(필터 추가) + `_create_unique_sql`/신규 `_unique_constraint_name`(헬퍼 추출) 세 군데가 **함께** 맞아야 통과한다. 이름 비교가 quote 때문에 어긋나면 픽스 전체가 무력화되는 cross-site 의존.
- **K-Domain 병목.** feature flag 게이팅과 이름 규칙 재사용은 도메인 지식 없이는 휴리스틱(이름 LIKE 패턴)으로 빠지기 쉬움. T4의 "도메인지식 또는 소규모 refactor 중 하나" 프로파일에 정확히 부합하며, 여기선 둘 다 해당.
- **넓은 P2P trap.** PASS_TO_PASS 125개가 전부 마이그레이션 operation 동작(add/remove constraint, unique constraint 변형, alter_unique_together_remove 등) — 인접 동작을 하나라도 깨면 안 되는 regression-trap. 특히 `allows_multiple_constraints_on_same_fields` 미지원 백엔드(Oracle만 `oracle/features.py:63`에서 `False`로 override; SQLite는 `base/features.py:291`의 기본값 `True`를 상속해 신규 필터 분기를 탄다)에서 기존 경로가 그대로 유지돼야 한다.
- **공식 라벨 = "15 min - 1 hour"** (개발자 구현시간 기준 T2~T3급). 본 분석은 이를 prior로 쓰되, **localize 쉬움(repro·traceback)에도 불구하고** 올바른 식별 조건이 도메인 규약(quote·feature flag·이름 해시) 재구성에 달려 있고 휴리스틱 오답 유혹이 크다는 점, 넓은 P2P trap을 근거로 **T4로 상향**한다. 공식 라벨이 못 잡는 "도메인지식 병목 + overfit성 휴리스틱 회피"가 에이전트 난이도를 올린다.

## 골드패치 분석
- **건드린 파일·함수** (`django/db/backends/base/schema.py`):
  - `alter_unique_together` — 삭제 분기에서 `_delete_composed_index` 호출 시 `constraint_kwargs`를 `{"unique": True}` → `{"unique": True, "primary_key": False}`로 변경.
  - `_delete_composed_index` — `_constraint_names` 결과 필터링 로직 신규 추가.
  - `_create_unique_sql` — 내부 `create_unique_name` 클로저 제거, `name = self._unique_constraint_name(table, columns, quote=True)`로 대체.
  - `_unique_constraint_name` (신규 메서드) — quote 여부에 따라 `IndexName(table, columns, "_uniq", ...)`를 생성.
- **근본 원인:** 단일 필드 unique_together 제약은 같은 컬럼의 `unique=True`/PK 제약과 **컬럼 집합만으로는 DB에서 구분되지 않는다.** 그래서 `_constraint_names(..., unique=True)`가 2개를 반환하고 `_delete_composed_index`의 `if len(constraint_names) != 1: raise ValueError(...)` 가드에서 크래시한다.
- **수정 요지:**
  1. **헬퍼 추출(S6):** `_create_unique_sql`에 박혀 있던 `create_unique_name` 클로저를 `_unique_constraint_name(table, columns, quote)`로 빼내 unique_together 기본 이름을 **raw(quote=False)로도** 재계산할 수 있게 함.
  2. **식별 필터(S2):** `_delete_composed_index`에서 `constraint_kwargs.get("unique") is True`이고 후보가 여럿이며 `self.connection.features.allows_multiple_constraints_on_same_fields`가 True면, `_unique_constraint_name(model._meta.db_table, columns, quote=False)`로 만든 `default_name`이 후보에 있으면 `constraint_names = [default_name]`로 좁힘.
  3. **PK 배제:** `alter_unique_together` 삭제 호출에 `"primary_key": False`를 추가해 PK 제약을 후보 단계에서부터 제외.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_remove_unique_together_on_unique_field` — `name`에 `unique=True`가 있고 동시에 `unique_together={("name",)}`인 Pony 모델 생성 후 `AlterUniqueTogether("Pony", set())`로 제약을 비운다. `@skipUnlessDBFeature("allows_multiple_constraints_on_same_fields")`로 게이팅(PostgreSQL 등에서만 실행).
- **픽스 증명:** 적용 후 `<table>_name_key`(unique=True 제약)는 **여전히 존재**해야 하고(`assertConstraintExists`), `<table>_name_694f3b9f_uniq`(unique_together 제약)는 **사라져야** 한다(`assertConstraintNotExists`). 즉 두 제약 중 unique_together 것만 정확히 골라 드롭됐음을 확인 — 픽스 전엔 ValueError로 둘 다 못 건드리고 죽었다. PK 변형인 `test_remove_unique_together_on_pk_field`는 PASS_TO_PASS에 들어가 있다.
- **overfit 관점:** FAIL_TO_PASS가 unique-field 케이스 1개라 얇아 보이지만, 골드가 **이름 LIKE 같은 휴리스틱이 아니라 Django의 기본 이름 생성기를 재사용**해 식별하므로 hash·테이블명이 다른 임의 케이스로 일반화된다. special-case 하드코딩이 아니라 overfit 위험이 낮다.
- **regression 관점:** PASS_TO_PASS 125개 마이그레이션 operation이 그대로 통과. 핵심 안전장치는 (a) 후보가 원래 1개인 정상 경로(후보 1개)가 바이트 동일하게 유지되는 점, (b) `primary_key: False`가 PK 케이스만 분리하는 점이다. feature flag 게이팅으로 보호되는 미지원 백엔드는 SQLite가 아니라 Oracle(`oracle/features.py:63`만 `False`)이며, SQLite는 기본값 `True`를 상속하므로 신규 필터 분기를 타고 FAIL_TO_PASS 테스트도 기본 SQLite 하네스에서 실제로 실행된다(스킵 아님).

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 traceback에서 `alter_unique_together` → `_delete_composed_index`로 내려가는 프레임을 보고, "Found wrong number ... of constraints" 문자열을 grep해 `if len(constraint_names) != 1: raise ValueError` 가드에 즉시 도달. 제보자가 명시한 이름 규칙 차이(`_uniq` vs `_key`)를 핵심 식별 단서로 채택.
2. **픽스와 올바른 일반화:** "2개 중 하나 드롭"을 임의 휴리스틱(이름 LIKE `%_uniq`)으로 처리하지 않는다. 대신 Django가 unique_together에 부여하는 **결정적 기본 이름**을 같은 생성기(`IndexName`/`_create_index_name`)로 재계산해(`_unique_constraint_name`, quote=False) 후보 중 그 이름과 일치하는 것만 좁힌다. 이름 생성과 식별이 **동일 SSOT**를 쓰므로 임의 테이블/해시에 일반화되며 overfit이 아니다. 추가로 `primary_key: False`로 PK 제약을 후보에서 사전 배제해 의도(unique_together만 제거)를 정확히 반영.
3. **regression 안전:** 필터를 `unique is True` + 후보 다수 + `allows_multiple_constraints_on_same_fields`로 3중 게이팅해, 후보가 원래 1개인 정상 경로와 다중 제약 미지원 백엔드(Oracle — `oracle/features.py:63`만 이 flag를 `False`로 override)는 **기존 동작을 그대로** 보존한다. SQLite는 이 flag를 끄지 않고 `base/features.py:291`의 기본값 `True`를 상속하므로 신규 필터 분기를 타며, 그래서 `test_alter_unique_together_remove`, `test_alter_index_together_remove_with_unique_together` 등 125개 P2P가 안 깨진다.
4. **함정 회피:** (a) raw 이름 비교를 안 하면 quote 차이로 매칭이 어긋난다 — `_create_unique_sql`의 클로저를 **메서드로 추출해 quote=False 경로를 만드는 리팩터를 빼먹으면** 식별이 실패한다. (b) feature flag 게이팅을 생략하면 다중 제약 미지원 백엔드에서 회귀. (c) 가장 흔한 오답은 "이름 패턴 LIKE 매칭" 휴리스틱 — 동작은 비슷해 보여도 Django 내부 규약과 어긋나 fragile하고 overfit. 정답은 **생성기 재사용**이라는 점을 잡는 것이 관건.
