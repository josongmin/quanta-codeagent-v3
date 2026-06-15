---
instance_id: django__django-15368
repo: django/django
base_commit: e972620ada4f9ed7bc57f28e133e85c85b0a7b20
version: 4.1
difficulty: <15 min fix
created_at: 2022-01-27T13:44:35Z
fail_to_pass: 1
pass_to_pass: 29
gold_files: [django/db/models/query.py]
---

# django__django-15368

## 문제 요약
모델 인스턴스 필드에 평범한 `F('...')` 표현식을 할당한 뒤 `bulk_update()`로 저장하면, F()가 컬럼명으로 resolve되지 않고 `F(name)`라는 문자열 repr 그대로 SQL에 박혀버린다. 즉 `SET "c8" = 'F(name)'` 같은 잘못된 UPDATE가 생성된다. 사용자는 `o.c8 = F('name')` 후 bulk_update하면 c8 컬럼이 name 컬럼 값으로 갱신되길 기대했다.

## 유형 분류
- 버그 카테고리: API-contract / 타입(너무 좁은 isinstance 체크)
- 서브시스템: django ORM query (`QuerySet.bulk_update`)
- 증상 타입: silent-wrong (예외 없이 잘못된 SQL/데이터 생성)
- 로컬라이제이션 신호: problem_statement가 GitHub 퍼머링크로 `django/db/models/query.py` L673의 type check를 직접 지목하고, 해결책으로 `hasattr(attr, 'resolve_expression')` 또는 `isinstance(attr, (Expression, F))`까지 제시한다 — 거의 fully-localized.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/query.py` : `QuerySet.bulk_update()`
- 근본 원인: bulk_update는 각 객체의 필드 값을 When절로 감싸기 전에 "이미 표현식이면 Value로 감싸지 말자"를 판단한다. 그 판단을 `isinstance(attr, Expression)`로 했는데, `F`는 `Expression`의 서브클래스가 아니다(`F`는 별도 클래스). 따라서 `F('name')`이 표현식이 아닌 일반 값으로 간주되어 `Value(F('name'), output_field=field)`로 감싸지고, F의 문자열 repr이 리터럴로 들어간다.
- 수정 요지: 좁은 nominal 타입 체크를 duck-typing으로 교체. `if not isinstance(attr, Expression):` → `if not hasattr(attr, 'resolve_expression'):`. resolve_expression을 가진 모든 객체(F, Expression, Func 등 ORM 표현식 전반)를 Value 래핑에서 제외한다. 이제 불필요해진 `Expression` import도 상단 import 줄에서 제거했다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_f_expression (queries.test_bulk_update.BulkUpdateTests)`
- 테스트가 어떻게 픽스를 증명하는지: `note='test_note', misc='test_misc'`인 Note 10개를 만든 뒤 각 인스턴스의 `note.misc = F('note')`로 설정하고 `bulk_update(notes, ['misc'])` 실행. 픽스 전에는 misc에 `'F(note)'` 리터럴이 들어가지만, 픽스 후 misc 컬럼이 note 컬럼 값(`'test_note'`)으로 갱신된다. `assertCountEqual(Note.objects.filter(misc='test_note'), notes)`로 10개 전부 misc가 실제 note 값으로 resolve됐음을 확인한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `bulk_update` 본문에서 `when_statements`/`Case`/`When`을 구성하는 루프를 찾고, 값을 `Value(...)`로 감쌀지 결정하는 가드 조건을 본다. 거기서 `isinstance(..., Expression)`가 범인.
- 함정/난이도 메모: 단일 파일·단일 라인 핵심 수정이라 난이도는 낮다. 함정은 (1) `F`를 명시적으로 추가하는 `isinstance(attr, (Expression, F))` 방식도 테스트는 통과하지만, 골드는 더 일반적인 duck-typing(`resolve_expression`)을 택했다 — 다른 표현식 타입까지 견고하게 커버. (2) 수정 후 `Expression` import가 미사용이 되므로 함께 제거해야 lint/관용에 맞는다(테스트 통과엔 무관).
- 우리 에이전트 관점: problem_statement에 파일·라인·해결책이 다 주어져 막힐 여지는 거의 없다. 유일한 분기점은 두 후보 수정(`hasattr` vs `isinstance (Expression, F)`) 중 무엇을 고르느냐인데, 둘 다 FAIL_TO_PASS를 통과시키므로 채점상 동등. import 정리를 빠뜨려도 테스트는 green이다.
