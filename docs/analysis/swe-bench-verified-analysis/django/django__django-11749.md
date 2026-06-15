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
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-11749

## 문제 요약
`call_command('my_command', shop_id=1)`처럼 required mutually exclusive group에 속한 인자를 kwargs로 넘기면 `CommandError: Error: one of the arguments --shop-id --shop is required`가 발생한다. 같은 인자를 문자열 `'--shop-id=1'`로 넘기면 정상 동작한다. 이슈 본문은 원인 코드(`for opt in parser._actions if opt.required and opt.dest in options`)까지 직접 인용하며, required인 것은 개별 action이 아니라 group인데 `call_command`가 그룹을 전혀 보지 않는다고 지적한다. has-repro: 이슈에 재현 호출과 정확한 에러 메시지·픽스 commit 힌트까지 포함.

## 유형 (정형화)
- **L0 (Pinpointed)** — 이슈가 `parser._actions if opt.required` 루프를 verbatim 인용. grep 한 방으로 `django/core/management/__init__.py:call_command`의 list comprehension 한 군데로 직결. 탐색 노력 사실상 0.
- **S2 (Constraint-Reasoning)** — 고칠 지점은 자명하나, 올바른 조건식 합성이 비자명. "개별 action의 `required`만으로는 group required를 못 잡는다"는 불변식을 이해하고, `opt.required OR opt ∈ (required group 멤버)`라는 술어를 추론으로 만들어야 한다. 후보를 마구 시도해 통과시키는 G&V가 아니라, argparse의 required 의미를 따져 식을 짜는 semantic repair. APR 관점에서 이건 SemFix/Angelix류의 조건식 합성: 결함 위치는 고정, 올바른 가드 술어를 의미론적으로 도출하는 문제다. 단순 None-가드/상수변경(S1)이 아니라 술어 자체를 새로 합성하므로 S2.
- **K-Domain (Domain-bound)** — argparse/Django management 내부 지식 필요. `parser._mutually_exclusive_groups`, `group._group_actions`, `group.required` 같은 언더스코어 private 멤버 구조를 알아야 그룹 required를 멤버 단위로 환원할 수 있다. 일반 파이썬 추론만으론 "왜 멤버의 required가 False인가"의 인과에 도달하기 어렵다.
- **primary = T-ConstraintReason** — 위치는 명확(L0)하나 픽스가 기계적 템플릿(T-DirectMap)이 아니라, required 그룹 의미를 반영한 조건식을 추론 합성해야 하는 게 본질. K-Domain이 거들지만 병목은 "어디"가 아니라 "어떤 술어로 고치냐"이므로 T-DomainBound보다 T-ConstraintReason이 dominant.

## 난이도 티어
**T3 (중간)**. 미는 피처:
- 단일 파일·단일 함수, gold 패치 +8/-2줄 수준의 소규모 → scope는 작아 상한이 낮음.
- localize는 L0로 trivial하지만, S2 조건식 합성 + K-Domain(argparse private 그룹 API) 추론이 실질적으로 필요 → T2를 넘어 T3.
- regression-trap: PASS_TO_PASS 34개 중 `test_call_command_with_required_parameters_in_options`, `..._in_mixed_options`, `test_call_command_option_parsing`, subparser 계열이 인접 동작. `opt.required` 분기를 잘못 일반화하면(예: `opt.dest in options` 가드 제거, 또는 무조건 모든 멤버 주입) 이들이 깨진다. P2P가 넓진 않지만 핵심 경로를 정확히 보존해야 함.
- 깊은 cross-file 데이터플로우(L2/L3)나 멀티헌크 조율(S6), overfit 고위험(S4)은 없음 → T4 이상은 아님.
- 공식 라벨 "15 min - 1 hour"(개발자 구현시간)와 대체로 일치. 다만 그 라벨은 argparse 그룹 내부구조를 "이미 아는 Django 코어 개발자" 기준이라 K-Domain 비용을 과소평가; 도메인지식 없는 에이전트엔 약간 더 어렵게 작동할 수 있어 하한 T2가 아닌 T3로 본다.

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/__init__.py` 의 `call_command`.
- 근본 원인: required mutually exclusive group의 개별 멤버 action은 `opt.required == False`다(required인 주체는 group이지 개별 action이 아니다). 기존 코드는 `opt.required`만으로 "이 kwargs를 `parse_args`에 재주입할지"를 결정했기 때문에, 그룹 멤버는 kwargs로 넘겨도 `parse_args`로 전달되지 않았고, 결과적으로 parser가 "그룹에서 아무것도 안 왔다"고 판단해 `CommandError`를 던졌다.
- 수정 요지: `parser._mutually_exclusive_groups`를 순회하여 `group.required`인 그룹의 `_group_actions`를 모아 `mutually_exclusive_required_options` 집합을 만든다. 이어 parse_args 재구성 컴프리헨션의 술어를 `opt.required and opt.dest in options`에서
  `opt.dest in options and (opt.required or opt in mutually_exclusive_required_options)`
  로 확장한다. 즉 "개별 required" 또는 "required 그룹 소속"인 멤버가 실제로 kwargs(`options`)에 들어온 경우에만 `'{opt}={val}'`로 parse_args에 주입한다.

## 검증 (test_patch)
- FAIL_TO_PASS (1): `test_mutually_exclusive_group_required_options (user_commands.tests.CommandTests)`. 신규 management command `mutually_exclusive_required`를 추가하는데, `add_mutually_exclusive_group(required=True)`에 `--foo-id`(int)/`--foo-name`(str) 두 멤버를 등록하고 `handle`이 들어온 옵션 키를 출력한다.
- 픽스 증명: `call_command('mutually_exclusive_required', foo_id=1)` 출력에 `'foo_id'`가, `foo_name='foo'`엔 `'foo_name'`이 포함됨을 확인(=그룹 멤버 kwargs가 parser까지 통과). 동시에 **아무 인자 없이** 호출하면 여전히 `CommandError: Error: one of the arguments --foo-id --foo-name is required`가 나야 함을 `assertRaisesMessage`로 확인 — group-required 강제는 그대로 유지되고 "멤버 kwargs 전달"만 고쳐졌음을 양방향으로 증명한다.
- overfit 관점: FAIL_TO_PASS가 1개라 얇아 보이지만, 같은 테스트가 (a)두 멤버 각각 통과 + (b)무인자 실패라는 **paired control**을 담고 있어 special-case로 우회하기 어렵다. `opt.required = True`로 멤버를 강제 변조하는 식의 overfit 해법은 (b)의 그룹 상호배타성/required 강제를 깨므로 통과하지 못한다.
- regression 관점: `opt.dest in options` 가드를 술어 앞으로 끌어올린 덕에 "넘어오지 않은 멤버"는 절대 주입되지 않는다. 이로써 `test_call_command_with_required_parameters_in_options`/`..._in_mixed_options` 등 기존 required-주입 경로가 byte 단위로 보존된다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 인용한 `for opt in parser._actions if opt.required and opt.dest in options` 한 줄을 그대로 grep → `django/core/management/__init__.py`의 `call_command` 안 parse_args 재구성 컴프리헨션 단일 지점으로 즉시 수렴(L0). 추가 탐색 불필요.
2. **픽스와 일반화 근거**: 핵심 통찰은 "required의 주체가 action이 아니라 group일 수 있다"는 것. 따라서 `opt.required` 단일 술어를 "개별 required ∪ required-group 멤버"로 확장한다. `parser._mutually_exclusive_groups`에서 `group.required`인 그룹의 `_group_actions`를 모아 집합으로 만들고 `opt in mutually_exclusive_required_options`를 OR로 더한다. 이는 특정 테스트 케이스가 아니라 argparse가 정의한 "required" 의미 전체(개별 + 그룹)를 커버하는 올바른 일반화 — 어떤 required 그룹/멤버 조합에도 성립한다.
3. **regression 안전**: `opt.dest in options` 가드를 OR 묶음의 **바깥**(AND 앞)에 두는 게 결정적. 이래야 "넘기지 않은 그룹 멤버"는 주입되지 않아 그룹 상호배타성·required 강제가 살아있고, 기존 `..._in_options`/`..._in_mixed_options`/`option_parsing`/subparser 계열 P2P가 안 깨진다. 가드를 안쪽에 잘못 배치하거나 빼면 안 넘긴 멤버까지 `None`으로 주입돼 그룹 충돌·오강제가 발생한다.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답은 (a)증상만 보고 멤버 action에 `required=True`를 박아 그룹 상호배타성을 깨뜨림, (b)그룹 정보를 모른 채 "모든 옵션을 무조건 주입"해 안 넘긴 멤버를 강제로 채워버림, (c)가드 위치 오배치로 P2P 회귀. 회피법: 표면 증상이 아니라 "왜 멤버의 `required`가 False인가"의 인과를 argparse 그룹 구조(`_mutually_exclusive_groups`/`_group_actions`/`group.required`)까지 파고들어, group-level required를 멤버 집합으로 환원한 뒤 **OR 확장 + 진입 가드 보존**이라는 골드의 구조적 해법에 도달하는 것.
