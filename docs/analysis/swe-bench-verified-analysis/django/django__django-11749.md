---
instance_id: django__django-11749
repo: django/django
base_commit: 350123f38c2b6217c38d70bfbd924a9ba3df1289
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-09-05T21:47:44Z
fail_to_pass: 1
pass_to_pass: 34
gold_files: [django/core/management/__init__.py]
---

# django__django-11749

## 문제 요약
`call_command('my_command', shop_id=1)`처럼 required mutually exclusive group에 속한 인자를 kwargs로 넘기면 `CommandError: Error: one of the arguments --shop-id --shop is required`가 발생한다. 같은 인자를 문자열 `'--shop-id=1'`로 넘기면 정상 동작한다. 사용자는 그룹이 required면 그룹 멤버를 kwargs로 넘겼을 때도 정상 동작하길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (edge-case)
- 서브시스템: django core management / `call_command` 인자 전달
- 증상 타입: 예외 (CommandError)
- 로컬라이제이션 신호: problem_statement가 `call_command` 내부 코드 스니펫(`for opt in parser._actions if opt.required and opt.dest in options`)을 그대로 인용 — 이게 `django/core/management/__init__.py`의 해당 루프로 직결됨.

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/__init__.py:call_command`
- 근본 원인: required mutually exclusive group의 개별 멤버 action은 `opt.required == False`다(required인 것은 group이지 개별 action이 아님). 기존 코드는 `opt.required`만 보고 kwargs를 `parse_args`에 다시 넣을지 결정했기 때문에, 그룹 멤버는 kwargs로 넘겨도 `parse_args`로 전달되지 않았고, 결국 parser가 "그룹 중 하나도 안 왔다"고 판단해 에러를 던졌다.
- 수정 요지: `parser._mutually_exclusive_groups`를 순회해 `group.required`인 그룹의 멤버 action들을 모아 `mutually_exclusive_required_options` 집합을 만든다. 그리고 parse_args 재구성 조건을 `opt.required` 단독에서 `opt.dest in options and (opt.required or opt in mutually_exclusive_required_options)`로 확장한다. 즉 "개별 required" 또는 "required 그룹 소속"이면 kwargs 값을 parse_args에 주입한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_mutually_exclusive_group_required_options`. 신규 management command `mutually_exclusive_required`를 추가하는데, `add_mutually_exclusive_group(required=True)`에 `--foo-id`/`--foo-name` 두 멤버를 등록한다.
- 증명 방식: `call_command('mutually_exclusive_required', foo_id=1)`이 출력에 `'foo_id'`를 포함하고, `foo_name='foo'`도 `'foo_name'`을 포함함을 확인(=kwargs가 통과). 반대로 아무 인자 없이 호출하면 여전히 `CommandError: Error: one of the arguments --foo-id --foo-name is required`가 나야 함을 `assertRaisesMessage`로 확인 — 즉 그룹 required 강제는 유지되면서 멤버 kwargs 전달만 고쳐졌음을 증명한다.

## 공략 포인트 (뭘 조져야)
- localization: problem_statement에 인용된 코드 한 줄을 grep하면 `call_command`의 list comprehension 한 곳으로 바로 수렴한다. 단일 파일, 단일 함수.
- 함정/난이도: 개별 action의 `required` 속성만 보면 그룹 정보를 놓친다. argparse 내부 API인 `parser._mutually_exclusive_groups`와 각 group의 `_group_actions`/`required`를 알아야 한다(언더스코어 prefix private 멤버). 또한 `opt.dest in options` 가드를 빼면 안 됨 — 안 넘긴 멤버까지 주입하면 그룹 충돌이나 잘못된 강제가 생긴다.
- 우리 에이전트 관점: 막힐 만한 지점은 "왜 required 체크가 false냐"의 인과를 argparse 그룹 구조까지 파고들어야 한다는 점. 표면적으로 `opt.required = True`로 우회하려 들면 그룹의 상호배타성 강제를 깨뜨린다. 골드처럼 group-level required를 별도 집합으로 수집해 OR 조건을 추가하는 구조적 해법에 도달해야 PASS_TO_PASS(특히 기존 required-in-options 테스트들)도 함께 통과한다.
