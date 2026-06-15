---
instance_id: django__django-16454
repo: django/django
base_commit: 1250483ebf73f7a82ff820b94092c63ce4238264
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-01-15T09:23:24Z
fail_to_pass: 1
pass_to_pass: 45
gold_files: [django/core/management/base.py]
---

# django__django-16454

## 문제 요약
Django management command는 에러 포매팅을 개선하기 위해 `argparse.ArgumentParser`의 서브클래스인 `CommandParser`를 쓰는데, `CommandParser`가 받는 추가 인자(`called_from_command_line` 등)가 `add_subparsers().add_parser()`로 만들어진 서브파서로 전달되지 않는다. 그 결과 서브파서 레벨에서 인자 누락/타입 오류가 나면 사용자 친화적 usage 메시지 대신 raw stack trace(`CommandError`)가 CLI에 그대로 노출된다. 사용자는 최상위 파서와 동일하게 깔끔한 `manage.py ... : error: ...` 형태를 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (서브파서 생성 시 부모 파서의 설정 전파 누락)
- 서브subsystem: django core management / argparse 통합 (CLI command framework)
- 증상 타입: 예외 (raw stack trace 누출, silent-wrong한 UX)
- 로컬라이제이션 신호: problem_statement가 명시적으로 `CommandParser`, `CommandParser.add_subparsers().add_parser()`, 그리고 `django/core/management/base.py` line 72의 `error()`를 traceback에 찍어준다. 사실상 파일·클래스·메서드가 모두 지목됨.

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/base.py` → `CommandParser.add_subparsers()` (신규 메서드 오버라이드), 상단에 `from functools import partial` import 추가
- 근본 원인: `argparse`의 기본 `add_subparsers()`는 `_SubParsersAction`을 만들고, 거기서 `add_parser()`가 새 파서를 만들 때 `parser_class`를 그냥 인스턴스화한다. `CommandParser`는 `__init__`에서 `called_from_command_line`, `missing_args_message` 같은 추가 kwargs를 받아 `error()` 동작을 바꾸는데, 서브파서 생성 경로엔 이 kwargs가 주입될 자리가 없었다. 따라서 서브파서는 기본 `CommandParser()`(또는 vanilla `ArgumentParser`)로 만들어지고 부모의 에러 핸들링 설정을 상속하지 못함.
- 수정 요지: `CommandParser.add_subparsers()`를 오버라이드해서, `parser_class`(기본값 `type(self)`)가 `CommandParser`의 서브클래스이면 그것을 `functools.partial(parser_class, called_from_command_line=self.called_from_command_line)`로 감싼 뒤 `super().add_subparsers(**kwargs)`에 넘긴다. 이렇게 하면 `add_parser()`가 서브파서를 만들 때 부모의 `called_from_command_line` 값이 자동으로 전파되어 `error()`가 일관된 usage 메시지를 출력한다. `parser_class`가 `CommandParser` 계열이 아니면(예: vanilla `argparse.ArgumentParser`) 감싸지 않고 그대로 위임해 호환성을 유지한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_subparser_error_formatting` — 기존 `subparser` 커맨드를 `["subparser", "foo", "twelve"]`로 실행(서브파서 `foo`의 `bar` 인자에 int가 아닌 `twelve` 전달). stderr가 정확히 2줄이고 둘째 줄이 `"manage.py subparser foo: error: argument bar: invalid int value: 'twelve'"`여야 한다 — 즉 traceback이 아니라 포맷된 usage error.
- 또한 신규 fixture `subparser_vanilla.py`(서브파서를 `parser_class=argparse.ArgumentParser`로 명시)를 추가하고 `test_subparser_non_django_error_formatting`(PASS_TO_PASS)으로, vanilla parser_class를 줘도 부모의 에러 포매팅이 깨지지 않고 동일한 2줄 포맷이 나오는지 회귀 검증한다.
- 증명 방식: 픽스 전엔 `bar`의 int 변환 실패가 `CommandError` traceback으로 터졌으나, 픽스 후엔 서브파서가 `called_from_command_line=True`를 상속해 `error()`가 stderr에 usage 라인 + error 라인 2줄만 출력 → assert로 정확히 검사.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement traceback이 `base.py`의 `CommandParser.error()`를 직접 지목하므로 `CommandParser` 클래스 정의로 바로 진입. 핵심은 "error를 어디서 고치냐"가 아니라 "서브파서가 왜 다른 설정으로 만들어지냐"를 추적해 `add_subparsers`/`add_parser` 경로를 보는 것.
- 함정/난이도: 잘못된 진입은 `error()` 자체를 패치하려는 것(서브파서가 부모 설정을 상속 못 하는 게 진짜 원인). argparse 내부 `_SubParsersAction.add_parser`가 `parser_class(**kwargs)`로 인스턴스화한다는 점을 알아야 `partial` 주입 트릭이 떠오른다. 또 `parser_class` 기본값 처리(`type(self)` vs 사용자가 vanilla `ArgumentParser`를 명시한 경우)를 구분 안 하면 non-django parser_class에 잘못된 kwargs를 넘겨 깨질 수 있음 — `issubclass` 가드가 필수.
- 우리 에이전트 관점: 단일 파일·~10줄짜리라 localization은 쉽지만, "에러 메시지를 고쳐라"는 표면 증상에 끌려 `error()`나 출력 레이어를 만지면 vanilla parser 회귀 테스트에서 막힌다. argparse 서브파서 생성 메커니즘(누가 어떤 kwargs로 파서를 인스턴스화하는가)을 이해해야 `partial` 기반 해법에 수렴 가능.
