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
---

# django__django-15278

## 문제 요약
SQLite에서 nullable `OneToOneField`를 `migrations.AddField`로 추가하면 `OperationalError: Cannot add a UNIQUE column`으로 크래시한다. Django가 `ALTER TABLE ... ADD COLUMN ... UNIQUE`를 발행하는데 SQLite은 UNIQUE 컬럼을 ALTER TABLE로 추가하는 것을 허용하지 않는다. 사용자는 nullable O2O 필드가 (다른 백엔드처럼) 정상적으로 추가되길 기대했다. `#33355` 관련 sqlite3 변경 이후 4.0→main 사이에서 발생한 회귀다.

## 유형 분류
- 버그 카테고리: regression / 누락처리 (edge-case 미커버)
- 서브시스템: django migrations / SQLite schema editor (DDL 생성)
- 증상 타입: 예외 (OperationalError 크래시)
- 로컬라이제이션 신호: 에러 메시지 `Cannot add a UNIQUE column`과 쿼리 `ALTER TABLE ... ADD COLUMN ... UNIQUE`, hints의 회귀 커밋 `2f73e5406d...`, 그리고 SQLite 한정 증상이 곧장 `sqlite3/schema.py`의 `add_field`를 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/backends/sqlite3/schema.py`:`DatabaseSchemaEditor.add_field`
- 근본 원인: `add_field`는 ALTER TABLE ADD COLUMN으로 처리 못 하는 케이스에서 `_remake_table`(테이블 재생성) 폴백을 타야 한다. 기존 조건은 default 값 관련(`not field.null or self.effective_default(field) is not None`)만 검사했고, **primary_key/unique 컬럼**은 ALTER TABLE ADD COLUMN으로 못 만든다는 SQLite 제약을 빠뜨렸다. O2O 필드는 `unique=True`라 nullable이어도 이 가드를 통과해 직접 ALTER를 시도 → 크래시.
- 수정 요지: 폴백 조건에 `field.primary_key or field.unique`를 OR로 추가. 이 둘 중 하나면 `_remake_table(model, create_field=field)`로 라우팅하고, 아니면 기존대로 `super().add_field`. 즉 unique/PK 컬럼은 항상 테이블 재생성 경로로 강제.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_add_field_o2o_nullable (schema.tests.SchemaTests)` — nullable `OneToOneField` 추가가 크래시 없이 성공하고 컬럼이 실제로 생성되는지.
- 테스트 증명 방식: `Author`/`Note` 모델 생성 후 `OneToOneField(Note, CASCADE, null=True)`를 만들어 `set_attributes_from_name('note')`로 이름 부여, `editor.add_field(Author, new_field)` 호출. 픽스 전이면 여기서 OperationalError. 픽스 후엔 `column_classes(Author)`에 `note_id`가 존재(`assertIn`)하고 nullable 플래그(`columns['note_id'][1][6]`)가 True인지 확인 → unique 컬럼이 _remake_table 경로로 정상 추가됨을 증명.

## 공략 포인트 (뭘 조져야)
- localization 전략: "SQLite 한정 + ALTER TABLE ADD COLUMN UNIQUE 실패"라는 두 단서로 `backends/sqlite3/schema.py`의 `add_field`를 바로 찾는다. ALTER vs `_remake_table` 분기 조건이 핵심.
- 함정/난이도 메모: 단일 파일·단일 조건문 수정이라 난이도는 낮은 편. 다만 "왜 nullable인데도 터지나"를 놓치기 쉽다 — O2O는 내부적으로 `unique=True`라는 점이 빠진 가드의 본질. PK는 이미 다른 경로로 안 올 수도 있지만 골드는 방어적으로 `primary_key`도 포함시켰다. default 조건만 보고 `null` 분기를 만지면 오답(143개 PASS_TO_PASS 회귀 위험).
- 우리 에이전트 관점: 기존 default 관련 주석에 끌려 `effective_default`/`null` 쪽만 손대면 막힌다. 증상이 UNIQUE 제약인데 unique를 명시적으로 검사하지 않는 점을 코드에서 직접 연결해야 하며, O2O→unique 매핑을 모르면 "왜 unique 검사가 필요한가"에서 헤맬 수 있다.
