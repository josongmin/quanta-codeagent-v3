---
instance_id: django__django-15278
repo: django/django
base_commit: 0ab58c120939093fea90822f376e1866fc714d1f
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-01-03T20:01:32Z
fail_to_pass: 1
pass_to_pass: 138
gold_files: [django/db/backends/sqlite3/schema.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-15278

## 문제 요약
SQLite에서 nullable `OneToOneField`를 `migrations.AddField`로 추가하면 `OperationalError: Cannot add a UNIQUE column`으로 크래시한다. Django가 `ALTER TABLE "..." ADD COLUMN "..." bigint NULL UNIQUE REFERENCES ...`를 발행하는데 SQLite은 UNIQUE 컬럼을 ALTER TABLE로 추가하는 것을 허용하지 않는다. 사용자는 nullable O2O 필드가 (다른 백엔드처럼) 정상 추가되길 기대했다. 이슈 본문에 실패 쿼리·네이티브 스택트레이스·재현 마이그레이션 스니펫이 모두 있고, hints가 회귀 커밋 `2f73e5406d54...`(#33355 sqlite3 리팩터)까지 지목한다. 즉 4.0→main 사이에 들어간 회귀다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable).** 이슈가 정확한 함수 심볼을 적어주진 않지만, "SQLite 한정" + "ALTER TABLE ADD COLUMN ... UNIQUE 실패" + 회귀 커밋 해시라는 세 단서가 `django/db/backends/sqlite3/schema.py`의 단일 후보로 거의 결정적으로 수렴한다. grep 한 방(L0)은 아니고 백엔드 디렉터리에서 `add_field`/`_remake_table` 분기를 짚는 약간의 탐색이 필요해 L1.
- **S (Repair Strategy) = S2 (Constraint-Reasoning).** 고칠 지점(분기 조건)은 명확하지만, 올바른 술어를 추론으로 합성해야 한다. 증상은 UNIQUE 제약인데 기존 가드는 default/null만 본다. "어떤 컬럼이 ALTER TABLE ADD COLUMN으로 못 만들어지나 → PK·UNIQUE·default·NOT NULL"이라는 불변식을 따져 `field.primary_key or field.unique`를 OR로 추가해야 한다. 테스트를 난사해 수렴하는 G&V(S3/S4)가 아니라, 결함 클래스(누락된 분기 항)를 의미적으로 메우는 한 줄짜리 조건 보강이라 S2가 dominant. 정형 None-가드/상수 변경 템플릿으로 기계적으로 매칭되는 S1은 아니다 — "O2O는 내부적으로 unique=True"라는 의미 연결이 들어가야 하기 때문.
- **K (Knowledge) = K-Domain.** django SQLite 스키마 에디터의 `add_field` vs `_remake_table` 폴백 모델, ALTER TABLE에 대한 SQLite의 DDL 제약, 그리고 `OneToOneField`가 `unique=True`로 매핑된다는 ORM 내부지식이 병목. 일반 파이썬 추론(K-Gen)으로는 "왜 nullable인데 터지나"를 못 풀고, 공개 API 시그니처 호환(K-API) 문제는 아니다.
- **Primary type = T-ConstraintReason.** 위치는 비교적 명확(L1)하나 진짜 일은 "올바른 폴백 조건식을 합성"하는 데 있다(S2). L2/L3 확산 로컬라이즈(T-DiffuseLoc)도, 구조 변경(T-DesignRefactor)도 아니고, 도메인지식이 *유일* 병목인 T-DomainBound이라기보다 조건 추론이 본질이라 T-ConstraintReason.

## 난이도 티어
**Tier = T3 (중간).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 경계).

이 티어로 미는 구조적 피처:
- **수정 범위 = 최소(1파일 / 1함수 / +5 -3줄, 사실상 한 조건문).** scope만 보면 T1~T2급(1파일·<5줄 ≈ 48% solve 구간).
- **has-repro = 강한 easiness 신호.** 실패 쿼리·OperationalError·회귀 커밋 해시가 다 주어져 로컬라이즈가 거의 공짜.

T2가 아니라 T3로 올리는 요인:
- **S2 추론의 비자명성.** 증상(UNIQUE)과 코드(default/null만 검사) 사이에 "O2O ⇒ unique" 의미 다리가 필요하다. 기존 주석이 "Fields with default values..."로 default 쪽에 시선을 고정시켜 `null`/`effective_default` 분기를 잘못 건드리는 함정이 크다. localize는 쉬워도 *올바른 픽스 식*은 도메인 추론을 요구.
- **regression-trap = P2P 138개가 같은 `SchemaTests` 안에 밀집.** `add_field` 분기를 잘못 넓히면 `test_add_field_default_nullable`, `test_add_field_db_collation`, FK/O2O alter 계열 등 인접 동작을 대거 깨뜨릴 수 있다. 안전한 픽스는 기존 OR 항을 보존한 채 항만 추가하는 것.

종합하면 scope/repro는 쉬움 쪽, 추론 비자명성+넓은 P2P trap이 중간 쪽 → 공식 라벨 하단보다 약간 위인 **T3**가 적정.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/backends/sqlite3/schema.py` → `DatabaseSchemaEditor.add_field`.
- **근본 원인:** SQLite은 `ALTER TABLE ADD COLUMN`으로 PK/UNIQUE 컬럼을 만들 수 없어, 그런 케이스는 `_remake_table`(테이블 재생성) 폴백을 타야 한다. 기존 가드는 default 처리 불가 케이스(`not field.null or self.effective_default(field) is not None`)만 검사했고 **`field.primary_key`/`field.unique`를 빠뜨렸다**. `OneToOneField`는 `unique=True`라 nullable이어도(`field.null=True`, default 없음) 이 가드를 통과해 `super().add_field` → 직접 `ALTER TABLE ... ADD COLUMN ... UNIQUE` 발행 → `Cannot add a UNIQUE column` 크래시.
- **수정 요지:** 폴백 조건을 다음으로 확장.
  ```python
  if (
      # Primary keys and unique fields are not supported in ALTER TABLE
      # ADD COLUMN.
      field.primary_key or field.unique or
      # Fields with default values cannot by handled by ALTER TABLE ADD
      # COLUMN statement because DROP DEFAULT is not supported in
      # ALTER TABLE.
      not field.null or self.effective_default(field) is not None
  ):
      self._remake_table(model, create_field=field)
  else:
      super().add_field(model, field)
  ```
  즉 PK 또는 unique 컬럼이면 항상 `_remake_table` 경로로 강제. 기존 default/null 항은 그대로 OR로 보존(회귀 방지). PK는 다른 경로로 안 올 수도 있으나 골드는 방어적으로 함께 포함.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_add_field_o2o_nullable (schema.tests.SchemaTests)`.
- **동작:** `Author`/`Note` 모델 생성 → `new_field = OneToOneField(Note, CASCADE, null=True)` 만들고 `new_field.set_attributes_from_name('note')`로 이름 바인딩 → `editor.add_field(Author, new_field)` 호출. 픽스 전이면 여기서 `OperationalError`. 픽스 후엔 `_remake_table` 경로로 정상 추가.
- **픽스 증명:** `columns = self.column_classes(Author)` 후 `self.assertIn('note_id', columns)`로 컬럼 실존을, `self.assertTrue(columns['note_id'][1][6])`로 nullable 플래그가 True임을 확인. unique 컬럼이 ALTER가 아닌 테이블 재생성으로 정상 생성됐고 null 속성도 보존됐음을 동시에 검증.
- **overfit 관점:** F2P 1개라 얇아 보이지만, 픽스가 "O2O 특수처리"가 아니라 `field.unique`/`field.primary_key`라는 *일반 술어*를 추가하는 것이라 overfit 위험은 낮다. nullable O2O뿐 아니라 모든 unique/PK 컬럼 add 경로를 올바르게 커버. 다만 special-case로 `isinstance(field, OneToOneField)` 같은 좁은 가드를 넣으면 overfit이 되어 unique=True인 다른 필드(예: `CharField(unique=True)`)는 여전히 깨진다.
- **regression 관점:** P2P 138개 다수가 `SchemaTests`의 add/alter 계열. 골드가 기존 default/null OR 항을 *보존*하므로 `test_add_field_default_nullable` 등 기존 통과 케이스의 분기 결과가 변하지 않는다. 새로 추가된 OR 항은 이전엔 직접 ALTER로 (잘못) 가던 unique/PK 케이스만 `_remake_table`로 돌리므로 인접 동작을 깨지 않는다.

## 모범답안 (오라클 기반)
1. **Localize 경로:** 이슈의 (a) "SQLite 한정" + (b) 실패 쿼리 `ALTER TABLE ... ADD COLUMN ... UNIQUE` + (c) hints의 회귀 커밋 `2f73e5406d...`(#33355)을 신호로 `django/db/backends/sqlite3/schema.py`로 직행. 그 안에서 ALTER vs `_remake_table` 분기를 가진 `add_field`를 후보로 확정(L1).
2. **픽스와 왜 올바른 일반화인가:** 폴백 조건이 default/null만 검사해 unique 컬럼을 놓친다는 점을 식별하고 `field.primary_key or field.unique`를 OR로 추가. 이게 올바른 일반화인 이유 — SQLite의 ALTER TABLE ADD COLUMN 제약은 "특정 필드 타입"이 아니라 "PK/UNIQUE 컬럼"이라는 *속성*에 걸리므로, 속성(`field.unique`)으로 분기해야 O2O뿐 아니라 모든 unique/PK 필드를 한 번에 올바르게 처리한다. O2O를 타입으로 특수처리하면 동일 결함이 다른 unique 필드에서 재발.
3. **Regression 안전:** 기존 `not field.null or self.effective_default(field) is not None` 항을 *반드시 보존*하고 새 항을 OR로만 추가한다. 그래야 `test_add_field_default_nullable`, `test_add_field_db_collation`, FK/O2O alter 계열 등 138개 P2P의 기존 분기 판정이 불변. null 분기를 "수정"하려 들면 default 관련 케이스가 대거 회귀한다.
4. **함정 회피:** 오라클 없는 에이전트의 주된 오답 — (a) 기존 주석 "Fields with default values..."에 끌려 `effective_default`/`null` 쪽을 만지는 것(증상은 default가 아니라 UNIQUE). (b) "nullable인데 왜 터지나"에서 멈추는 것 — `OneToOneField`가 내부적으로 `unique=True`라는 ORM 매핑을 연결해야 풀린다. (c) `isinstance(field, OneToOneField)`로 좁게 가드해 overfit. 회피법: 에러 메시지의 "UNIQUE"를 코드의 분기 조건과 직접 대조해 "unique를 검사하지 않는다"를 발견하고, 타입이 아닌 속성(`field.unique`/`field.primary_key`)으로 일반화.
