---
instance_id: django__django-15561
repo: django/django
base_commit: 6991880109e35c879b71b7d9d9c154baeec12b89
version: "4.1"
difficulty: 15 min - 1 hour
created_at: 2022-04-01T18:29:04Z
fail_to_pass: 1
pass_to_pass: 141
gold_files: [django/db/backends/base/schema.py, django/db/models/fields/__init__.py]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-15561

## 문제 요약
SQLite 백엔드에서 `choices`만 추가/변경하는 것처럼 컬럼 정의에 영향이 없는 마이그레이션조차 불필요한 SQL(new table + insert + drop + rename, 즉 테이블 재생성)을 생성한다. 동일한 변경이 PostgreSQL/MySQL/Oracle에서는 noop(SQL 0건)인데, SQLite는 대부분의 ALTER를 테이블 재생성으로 처리하기 때문에 `_field_should_be_altered`가 "변경 필요"로 판정하면 곧바로 DDL이 발생한다. 사용자는 `AlterField`로 `choices`만 바꿀 때 어떤 백엔드에서도 DB 변경이 없어야(noop) 한다고 기대한다.

## 유형 (정형화)

**L (Localization) = L3 — Multi-site.**
픽스가 두 파일에 **함께** 걸쳐야 한다: `django/db/backends/base/schema.py`의 `_field_should_be_altered`(소비처)와 `django/db/models/fields/__init__.py`의 `Field`(새 `non_db_attrs` 속성 정의처). 단순 진입점 찾기(`_field_should_be_altered`)는 hints가 거의 지목해줘 쉽지만, **올바른 골드는 한 곳이 아니라 정의-소비 두 site의 조율 변경**이라 L3로 본다. naive 단일-site 픽스(리스트에 `'choices'` 한 줄)도 존재하므로, localize "직접성"은 높지만 정답 site 집합은 분산되어 있다.

**S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning).**
한 줄 상수 추가가 아니라 **"메서드 내 하드코딩 리스트 → 필드 클래스의 확장 가능한 클래스 속성"으로의 구조 변경**이 본질이다(collect-then-process가 아니라 책임 재배치/확장점 도입 = S6). 보조로 S2: "`choices`는 컬럼 정의에 영향 없는 속성인가?"라는 불변식을, "단, 서드파티 enum 필드(django-mysql `EnumField`)는 `choices`가 실제 DB 타입에 영향을 줄 수 있다"는 반례까지 따져 합성해야 한다. 즉 올바른 조건은 "전역으로 `choices`=non-db"가 아니라 "**필드 클래스가 자기 non-db 속성을 선언**한다"이다 — 이 추론이 S2의 몫이다.

**K (Knowledge) = K-Domain.**
django migrations/schema-editor 내부 동작 지식 필요: SQLite가 ALTER를 테이블 재생성으로 처리한다는 점, `_field_should_be_altered`가 old/new `deconstruct()` kwargs 차이로 alter 여부를 판정한다는 점, `choices`가 DDL에 무관하다는 ORM 도메인 사실, 그리고 서드파티 커스텀 필드의 회귀 가능성까지. 일반 파이썬 추론으로는 닿지 않는다.

**Primary type = T-DesignRefactor.**
dominant 축이 S6(조율된 소규모 구조 변경)이기 때문이다. T-DirectMap이 아닌 이유: 정답이 "가드/상수/기본값 추가" 템플릿이 아니라 확장점(클래스 속성) 도입을 요구한다. T-DomainBound가 아닌 이유: 도메인 지식은 필요하나 그것이 *유일* 병목이 아니고, 진짜 델타는 "어떻게 회귀 없이 일반화할 구조를 짤 것인가"이다.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 `15 min - 1 hour`(T2~T3 prior)이고 패치 자체는 작지만(2파일, 순삭+추가 합쳐 ~30줄, 헌크 단순), 다음 구조적 피처가 T4로 민다:

- **regression-trap(P2P 141개):** schema editor의 alter/migration 동작 전반(`test_alter_*`, `test_m2m_*`, FK/O2O/PK 변환 등 광범위)을 하나도 깨면 안 된다. `non_db_attrs`에서 `choices`를 잘못 분류하면 인접 동작이 줄줄이 깨질 수 있다.
- **cross-file-dep / L3:** gold가 2파일 조율(정의처 + 소비처). 단일파일 픽스로 수렴하기 쉬운 구조라 골드 매칭이 어긋날 위험.
- **overfit 유혹:** FAIL_TO_PASS 단일 테스트는 "리스트에 `choices` 한 줄 추가"라는 naive 픽스로도 통과한다. 즉 테스트가 구조 변경(확장점 도입) 동기를 *과소명세*한다 — 정답에 닿으려면 hints_text의 서드파티 회귀 논의를 읽고 설계 의도를 복원해야 한다.

공식 라벨(개발자 시간)과 다른 이유: 정답을 *아는* 개발자에겐 30분 작업이지만, **에이전트 관점에선 "어떤 구조가 회귀 없이 올바른 일반화인가"를 테스트가 안 알려준다.** 이 spec gap + P2P trap이 시간라벨엔 안 잡혀 한 단계 올린다.

## 골드패치 분석
- **건드린 파일/함수:**
  - `django/db/backends/base/schema.py` — `BaseDatabaseSchemaEditor._field_should_be_altered`
  - `django/db/models/fields/__init__.py` — `Field` 클래스에 클래스 속성 `non_db_attrs` 신설
- **근본 원인:** `_field_should_be_altered`가 "스키마에 영향 없는 속성"을 메서드 내부에 하드코딩한 `non_database_attrs` 리스트로 들고 있었고, 그 리스트에 `choices`가 빠져 있었다(`#25253` 작업에서 누락). 그래서 `choices`만 바뀐 경우에도 old/new kwargs가 달라 "alter 필요"로 판정 → SQLite는 테이블 재생성 DDL을 생성했다.
- **수정 요지:**
  1. `Field`에 클래스 속성 `non_db_attrs` 튜플을 신설하고 거기에 기존 11개 속성(`blank`, `db_column`, `editable`, `error_messages`, `help_text`, `limit_choices_to`, `on_delete`, `related_name`, `related_query_name`, `validators`, `verbose_name`) + **`choices`** = 총 12개를 담는다.
  2. `_field_should_be_altered`에서 메서드-로컬 `non_database_attrs` 리스트를 삭제하고, 루프를 `for attr in old_field.non_db_attrs: old_kwargs.pop(...)` / `for attr in new_field.non_db_attrs: new_kwargs.pop(...)`로 바꿔 **old/new 각 필드의 클래스 속성**을 참조하게 한다.
  이로써 (a) `choices`가 noop 처리되고, (b) hints가 우려한 서드파티 enum 필드(django-mysql `EnumField`)는 자기 서브클래스에서 `non_db_attrs`를 좁게 오버라이드해 회귀를 막을 **확장점**을 얻는다. old/new를 각각 그 필드 자신의 `non_db_attrs`로 pop하는 것이 핵심 — 필드 타입별로 무시 속성이 달라질 수 있게 하는 설계다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_alter_field_choices_noop (schema.tests.SchemaTests)`
- **동작:** `Author` 모델을 만든 뒤 `name` 필드(`old_field`)와 `choices`만 추가된 동등 `CharField(max_length=255, choices=(("Jane","Jane"),("Joe","Joe")))`(`new_field`, `set_attributes_from_name("name")`)를 준비한다. `editor.alter_field(Author, old_field, new_field, strict=True)`를 `old→new`, `new→old` **양방향**으로 호출하면서 각각 `assertNumQueries(0)` 컨텍스트로 감싼다 → choices만 바뀌면 SQLite에서도 발생 SQL이 0건이어야 함을 단언. 픽스 전엔 테이블 재생성 쿼리가 나가 0건 단언이 깨진다.
- **픽스 증명:** `choices`가 `Field.non_db_attrs`에 들어가 양쪽 kwargs에서 동일하게 pop되면 old/new kwargs가 일치 → `_field_should_be_altered`가 False(컬럼명 동일) → alter 스킵 → 0 queries. 양방향 호출이 추가/제거 대칭성까지 커버.
- **overfit 관점:** FAIL_TO_PASS가 단 1개이고 `choices` 케이스만 검사하므로 **테스트는 픽스를 과소명세**한다. "리스트에 `'choices'` 한 줄"만 추가해도 이 테스트는 green이지만, 그건 클래스-속성 확장점이 없어 골드와 구조가 다르고 서드파티 회귀를 막지 못한다 → 전형적 plausible-but-overfit. 정답 일반화는 "필드가 자기 non-db 속성을 선언"이라는 구조에 있다.
- **regression 관점:** P2P 141개가 alter/migration 동작 전반을 고정한다. `non_db_attrs`에 DDL에 *영향 있는* 속성을 잘못 넣으면 `test_alter_field_*`/`test_alter_text_field_*`/FK·O2O·PK 변환 테스트가 깨진다. 골드는 기존 11속성을 그대로 유지하고 `choices` **하나만** 추가해 총 12개로 만들었기에 P2P를 보존한다.

## 모범답안 (오라클 기반)

**1) Localize 경로.**
problem_statement의 "noop", "still generates sql (new table + insert + drop + rename)" + "on postgres ... no sql"에서 백엔드별 차이를 만드는 지점을 찾는다. SQLite가 ALTER를 테이블 재생성으로 처리한다는 도메인 사실(또는 hints의 `#32502` 언급)로, 진짜 공통 판정 로직이 백엔드별 SQL 생성이 아니라 그 **앞단의 "alter가 필요한가" 판정**임을 안다 → `BaseDatabaseSchemaEditor._field_should_be_altered`. 거기서 `non_database_attrs` 화이트리스트가 old/new kwargs를 비교 전에 제거하는 구조를 발견하고, `choices`가 빠진 것을 본다. hints가 이 위치를 직접 지목하므로 localize 자체는 빠르다.

**2) 픽스 — 왜 올바른 일반화인가.**
naive 픽스("리스트에 `'choices'` 추가")는 FAIL_TO_PASS는 통과시키지만 **전역적으로** `choices`를 무시하게 만들어, `choices`를 실제 DB enum 타입으로 매핑하는 서드파티 필드(django-mysql `EnumField`)에서 마이그레이션 누락 회귀를 낸다. 올바른 일반화는 "무시 가능 속성"을 *필드 타입의 책임*으로 끌어올리는 것: `Field.non_db_attrs` 클래스 속성으로 만들고 `_field_should_be_altered`가 `old_field.non_db_attrs`/`new_field.non_db_attrs`를 참조하게 한다. 그러면 기본 `Field`는 `choices`를 무시하되, 서브클래스가 좁게 오버라이드해 옵트아웃할 수 있다 — `choices` 케이스를 풀면서 동시에 회귀 출구를 막는, 테스트 너머로 일반화된 구조다.

**3) Regression 안전.**
P2P 141개(특히 `test_alter_field_*`, alter/migration 전반)를 깨지 않으려면 기존 11개 non-db 속성 집합을 그대로 보존하고 `choices`만 추가해 총 12개로 만들어야 한다. `non_db_attrs`를 튜플로 두어 불변 클래스 속성으로 노출하고, old/new를 *각 필드 자신의* 속성으로 pop해 필드 타입별 차이를 존중한다. DDL에 영향 있는 속성(max_length, db_column 실제 컬럼명 등)은 절대 넣지 않는다 — `_field_should_be_altered` 말미의 `quote_name(old_field.column) != quote_name(new_field.column)` 컬럼명 비교는 유지되어 진짜 컬럼 변경은 여전히 alter를 트리거한다.

**4) 함정 회피.**
오라클 없는 에이전트의 전형적 실패: (a) hints 1번 답대로 `_field_should_be_altered`의 리스트에 `'choices'` 한 줄만 추가 → FAIL_TO_PASS green이지만 `django/db/models/fields/__init__.py`를 안 건드려 gold_files 불일치 + 서드파티 회귀 미해결. (b) "SQLite에서만 `_field_should_be_altered`를 오버라이드"하는 백엔드 국소 픽스(hints 후반 제안) → 동작은 맞지만 골드의 필드-속성 확장 설계와 다름. 회피법: **FAIL_TO_PASS 1개에 만족하지 말고 hints_text의 "서드파티 enum 필드 회귀" 토론을 읽어 설계 의도를 복원**할 것. 단일 테스트가 정답을 과소명세하는 신호(P2P가 넓고 도메인 회귀 우려가 명시됨)를 잡으면, "전역 무시"가 아니라 "필드 클래스가 선언하는 확장점"이라는 올바른 구조에 도달한다.
