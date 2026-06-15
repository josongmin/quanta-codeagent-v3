---
instance_id: django__django-13658
repo: django/django
base_commit: 0773837e15bb632afffb6848a58c59a791008fa1
version: "3.2"
difficulty: 15 min - 1 hour
created_at: 2020-11-09T20:50:28Z
fail_to_pass: 1
pass_to_pass: 181
gold_files: [django/core/management/__init__.py]
---

# django__django-13658

## 문제 요약
`ManagementUtility`는 생성자에서 전달받은 `argv`(sys.argv가 아님)로부터 `self.prog_name`을 계산해 둔다. 그런데 `--settings`/`--pythonpath`를 미리 파싱하려고 `CommandParser`를 만들 때는 `prog`를 넘기지 않아 usage 문자열의 `%(prog)s`가 `sys.argv[0]`을 가리키게 된다. 사용자는 `execute_from_command_line(argv)`에 자기 argv를 넘기면 프로그램 이름이 그 argv 기준으로 동작하길 기대했지만, 임베디드 환경에서 `sys.argv[0]`이 `None`이면 예외가 터진다.

## 유형 분류
- 버그 카테고리: API-contract (전달된 argv 대신 전역 sys.argv를 암묵적으로 사용)
- 서브시스템: django core management / CLI 진입점 (execute_from_command_line)
- 증상 타입: silent-wrong (usage에 잘못된 프로그램명) + 크래시 (sys.argv[0]=None일 때)
- 로컬라이제이션 신호: problem_statement가 `ManagementUtility`, `CommandParser`, `self.prog_name`, `--pythonpath/--settings`를 직접 지목하고 수정 코드까지 제시한다. 거의 좌표가 찍혀 있음.

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/__init__.py` : `ManagementUtility.execute`
- 근본 원인: `execute()` 안에서 옵션 선파싱용 `CommandParser(usage='%(prog)s subcommand ...', add_help=False, allow_abbrev=False)`를 만들 때 `prog`를 생략. argparse는 `prog`가 없으면 `sys.argv[0]`의 basename으로 채우므로, `__init__`에서 공들여 계산한 `self.prog_name`이 무시되고 전역 `sys.argv`에 의존하게 된다.
- 수정 요지: 동일 `CommandParser` 생성 호출에 `prog=self.prog_name` 인자를 추가. 이제 usage의 `%(prog)s`가 전달된 argv 기반 프로그램명을 쓰며, `sys.argv[0]`이 `None`이어도 더 이상 거기에 의존하지 않는다. 한 줄짜리 인자 추가가 핵심.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_program_name_from_argv (admin_scripts.tests.ExecuteFromCommandLine)`
- 테스트는 `execute_from_command_line`을 import한 뒤, `sys.argv`를 `[None] + args`로 mock 패치(즉 `sys.argv[0]`을 None으로)한 상태에서 `execute_from_command_line(['django-admin'] + args)`를 호출한다(`args=['help','shell']`).
- 재현 입력 → 기대 출력: stdout에 `'usage: django-admin shell'`이 포함되어야 하고(전역 sys.argv의 None이 아니라 전달된 `'django-admin'`이 prog로 쓰임), stderr는 빈 문자열이어야 한다. 패치 전에는 prog가 sys.argv[0]=None에서 유도되어 usage가 틀리거나 예외가 발생한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `execute_from_command_line` → `ManagementUtility.execute` → 첫 `CommandParser(...)` 생성부. problem_statement가 심볼을 다 줘서 grep 한 번이면 도달한다.
- 함정/난이도 메모: 단일 파일·단일 인자 추가라 난이도는 낮음. 다만 같은 파일에 `CommandParser`/argparse 생성 지점이 여러 곳(서브커맨드 파싱 등)이라 "옵션 선파싱용 그 한 군데"만 고쳐야 한다. self.prog_name이 `__init__.py`에서 어떻게 계산되는지(`__main__.py` → `python -m django` 특수처리 포함)를 확인하면 fix 위치가 명확해진다.
- 우리 에이전트 관점: 실제 코드 수정은 사소하나, hints_text가 경고하듯 "재현/회귀 테스트가 핵심". 에이전트가 `sys.argv` mock과 `captured_stdout/stderr`를 동원한 테스트 시나리오를 스스로 구성하지 못하면 검증 단계에서 픽스의 정당성을 증명하기 어렵다. 또 argparse 기본 `prog` 동작(미지정 시 sys.argv[0] basename)을 모르면 "왜 버그인지"를 놓치고 엉뚱한 곳을 건드릴 위험이 있다.
