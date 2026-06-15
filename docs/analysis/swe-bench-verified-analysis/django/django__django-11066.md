---
instance_id: django__django-11066
repo: django/django
base_commit: 4b45b6c8e4d7c9701a332e80d3b1c84209dc36e2
version: 3.0
difficulty: <15 min fix
created_at: 2019-03-09T13:03:14Z
fail_to_pass: 1
pass_to_pass: 3
gold_files: [django/contrib/contenttypes/management/__init__.py]
---

# django__django-11066

## 문제 요약
`RenameModel` 마이그레이션을 default가 아닌 다른 데이터베이스(`--database` 지정)에 대해 실행하면, content type rename 과정에서 `no such table: django_content_types` 같은 OperationalError가 발생한다. `RenameContentType._rename()`이 `transaction.atomic(using=db)`로 감싸긴 했지만 실제 `content_type.save()`는 `using`을 안 받아 라우터/default DB로 흘러가 잘못된 DB에 쿼리를 날린다. 사용자는 `schema_editor.connection.alias`로 지정된 DB에 저장되길 기대했다.

## 유형 분류
- 버그 카테고리: logic (잘못된 DB 라우팅) / 누락처리 (`using` kwarg 누락)
- 서브시스템: django contenttypes management (마이그레이션 RenameContentType operation)
- 증상 타입: 예외 (OperationalError / no such table) — 멀티-DB 환경에서만 발현
- 로컬라이제이션 신호: problem_statement가 파일·라인·코드 스니펫을 직접 지목한다(`django/contrib/contenttypes/management/__init__.py`, `content_type.save(update_fields={'model'})`). 사실상 fix까지 제안되어 있음.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/contenttypes/management/__init__.py` : `RenameContentType._rename()`
- 근본 원인: `transaction.atomic(using=db)`는 트랜잭션을 어느 connection에 열지만 정하고, 그 안의 쿼리를 그 DB로 라우팅하지 않는다. `save()`에 `using`을 안 주면 DB 라우터(`db_for_write`)나 default DB로 쿼리가 보내져, 정작 마이그레이션이 도는 `db`가 아닌 곳에 저장을 시도한다.
- 수정 요지: `content_type.save(update_fields={'model'})` → `content_type.save(using=db, update_fields={'model'})`. `using=db`(= `schema_editor.connection.alias`)를 명시해 save가 라우팅을 건너뛰고 올바른 DB에 직접 쓰도록 한다. 한 줄 변경.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_existing_content_type_rename_other_database` — `'other'` DB에 'foo' content type을 만들고 `migrate ... --database other`로 RenameModel을 실행했을 때 'other' DB에서 'foo'가 'renamedfoo'로 바뀌는지, 그리고 역방향(`migrate ... zero`)으로 되돌아가는지 확인.
- 증명 방식: 테스트는 `databases = {'default', 'other'}`를 켜고 `db_for_write`가 항상 'default'를 반환하는 `TestRouter`를 `DATABASE_ROUTERS`로 주입한다. fix 전이면 save가 라우터 따라 'default'로 가서 'other'의 content type이 안 바뀌어 assert 실패. `using=db`가 들어가면 라우터를 무시하고 'other'에 저장되어 통과. 라우터가 일부러 엉뚱한 DB를 가리키게 해 routing-skip을 강제 검증하는 게 핵심.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 파일·라인·수정안이 그대로 박혀 있어 탐색은 거의 불필요. `_rename` 내 `content_type.save(...)` 호출 한 곳만 보면 된다.
- 함정/난이도 메모: 진짜 함정은 "`transaction.atomic(using=db)`로 이미 DB를 지정했으니 save도 그 DB로 갈 것"이라는 착각. atomic의 `using`은 트랜잭션 connection 선택일 뿐 쿼리 라우팅이 아니라는 Django 멀티-DB 의미론을 알아야 한다(hints의 SO 논의도 이 지점). 단일 파일·한 줄 수정.
- 우리 에이전트 관점: 코드 위치는 즉시 찾지만, 같은 함수의 `transaction.atomic(using=db)`을 보고 "이미 DB 지정됨"이라 판단해 fix를 건너뛸 위험. save 레벨 routing-skip 개념을 모르면 다른 곳(라우터 설정, atomic 인자)을 잘못 건드릴 수 있다. 테스트 작성 시 의도적으로 잘못된 라우터를 꽂아야 회귀를 잡는다는 점도 놓치기 쉽다.
