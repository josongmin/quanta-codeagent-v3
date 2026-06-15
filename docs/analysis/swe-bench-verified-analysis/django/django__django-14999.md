---
instance_id: django__django-14999
repo: django/django
base_commit: a754b82dac511475b6276039471ccd17cc64aeb8
version: "4.1"
difficulty: <15 min fix
created_at: 2021-10-16T09:31:21Z
fail_to_pass: 1
pass_to_pass: 113
gold_files: [django/db/migrations/operations/models.py]
---

# django__django-14999

## 문제 요약
이미 명시적 `db_table`이 정의된 모델에 `RenameModel` 마이그레이션 연산을 적용하면, 실제 테이블명은 바뀌지 않는데도 DB 작업이 발생한다. Postgres에서는 FK 제약을 drop 후 재생성하고, sqlite에서는 테이블을 통째로 재생성한다. 사용자는 테이블명이 그대로이므로 이 연산이 noop(아무 DB 쿼리도 발생하지 않음)이길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (early-return 가드 부재) / edge-case
- 서브시스템: django migrations operations (스키마 변경 연산)
- 증상 타입: 불필요한 DB 작업 (잘못된 부작용 — FK drop/recreate, 테이블 재생성)
- 로컬라이제이션 신호: problem_statement가 `RenameModel`과 `db_table`을 직접 지목. migrations 연산 클래스이므로 `django/db/migrations/operations/models.py`의 `RenameModel` 클래스로 곧장 연결된다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/operations/models.py` : `RenameModel.database_forwards`
- 근본 원인: `database_forwards`가 모델명만 보고 무조건 `schema_editor.alter_db_table(...)`를 호출했다. `db_table`이 명시되어 있으면 모델명을 Rider→Runner로 바꿔도 실제 db_table 값은 동일한데, 이 경우를 구분하지 않아 동일 테이블명으로 ALTER를 실행 → 백엔드별 부작용(FK drop/recreate, 테이블 재생성)이 발생.
- 수정 요지: `old_model._meta.db_table`과 `new_model._meta.db_table`을 각각 `old_db_table`/`new_db_table` 지역변수로 추출한 뒤, 두 값이 같으면 `return`으로 조기 종료(noop)한다. 같지 않을 때만 기존처럼 `alter_db_table`을 호출하고 이어서 관련 객체(related_objects)들에 대한 처리를 진행한다. `database_backwards`는 내부적으로 forwards를 swap 호출하므로 별도 수정 없이 함께 noop가 된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_rename_model_with_db_table_noop` — `db_table='rider'`로 고정된 Rider 모델(+이를 FK로 참조하는 Pony)을 만들고 `RenameModel('Rider', 'Runner')`를 수행.
- 테스트가 증명하는 방식: `database_forwards`와 `database_backwards`를 각각 실 schema_editor로 실행하면서 `assertNumQueries(0)`로 감싼다. 즉 db_table이 바뀌지 않으므로 단 한 건의 SQL도 나가면 안 된다. 패치 전에는 alter/FK 재생성 쿼리가 발생해 0이 아니어서 실패, 패치 후 조기 return으로 0건이 되어 통과.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement의 "RenameModel" + "db_table"을 키로 `operations/models.py`의 `RenameModel` 클래스 → `database_forwards` 진입. 부작용(FK drop)이 일어나는 지점인 `schema_editor.alter_db_table` 호출 직전이 가드 삽입 위치다.
- 함정/난이도 메모: 단일 파일·단일 함수의 ~5줄 가드라 난이도는 낮다. 다만 (1) `database_backwards`를 따로 고치려는 과잉수정 유혹 — 실제로는 forwards swap이라 불필요, (2) M2M 테이블/related_objects 처리 루프 위쪽에 가드를 둬야 하며 루프 내부에 두면 메인 테이블만 막고 부수 테이블 작업이 새는 점에 주의.
- 우리 에이전트 관점: noop 판정 기준을 모델명 동일성이 아니라 `_meta.db_table` 동일성으로 잡아야 한다는 통찰이 핵심. 모델명은 분명히 바뀌므로 "이름이 같으면 noop" 식 휴리스틱으로 가면 가드 조건을 잘못 작성해 통과 못 한다. 또 `assertNumQueries(0)` 계약을 만족하려면 부분적으로 쿼리를 줄이는 게 아니라 완전 0건이어야 함을 인지해야 한다.
