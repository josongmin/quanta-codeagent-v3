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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13658

## 문제 요약
`ManagementUtility.__init__`은 전달받은 `argv`(전역 `sys.argv`가 아님)로부터 `self.prog_name`을 계산해 둔다(`__main__.py`면 `python -m django`로 특수처리까지 포함). 그런데 `execute()`에서 `--settings`/`--pythonpath`를 미리 파싱하려고 `CommandParser`를 만들 때 `prog`를 넘기지 않아, argparse가 `prog`를 `sys.argv[0]`의 basename으로 채운다. 결과적으로 usage 문자열의 `%(prog)s`가 공들여 계산한 `self.prog_name`이 아니라 전역 `sys.argv[0]`을 가리킨다. 사용자는 `execute_from_command_line(argv)`에 자기 argv를 넘기면 프로그램명이 그 argv 기준으로 동작하길 기대했지만, 임베디드 환경에서 `sys.argv[0]`이 `None`이면 예외가 터진다. 이슈 본문이 결함 위치와 수정 코드까지 그대로 적어주었다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 `ManagementUtility`, `CommandParser`, `self.prog_name`, `--pythonpath/--settings`를 직접 지목하고 정확한 생성 호출 한 줄을 인용한다. grep 한 방으로 도달 — 사실상 좌표가 박혀 있음.
- **S (Repair Strategy) = S1 (Direct-Map / template)**: 이슈가 픽스를 사실상 명세한다("This can fixed as follows: `prog=self.prog_name` 추가"). "전달된 값 대신 전역 디폴트를 쓰는 누락 인자" 결함클래스에 기계적으로 매칭 — 키워드 인자 하나 추가. 추론으로 식·조건을 합성할 필요(S2)도, 후보 다수에서 테스트로 선택(S3)도 없다.
- **K (Knowledge) = K-Domain**: 왜 이게 버그인지를 이해하려면 argparse의 디폴트 `prog` 동작(미지정 시 `os.path.basename(sys.argv[0])`)과 django management 진입점(`execute_from_command_line` → `ManagementUtility.execute`)의 내부 구조를 알아야 한다. 일반 파이썬 추론(K-Gen)만으론 "왜 prog 누락이 sys.argv 의존을 유발하나"를 못 짚는다. 다만 K-Domain이 병목(dominant)은 아니며 — 이슈가 메커니즘을 설명해줘서 지식 장벽이 사실상 해소된다 — 그래서 T-DomainBound이 아니다.
- **Primary type = T-DirectMap**: 위치 명확(L0) + S1 기계적 픽스(누락 인자 추가)의 정의에 정확히 부합. T-LocTrivial(K-Gen 전제)보다 도메인 색이 있고, T-ConstraintReason(S2 추론합성)·T-DomainBound(지식 병목)·T-GenValidate(overfit 위험 핵심)는 모두 이 문제의 본질이 아니다.
- **왜 이 strategy인가 (APR 관점)**: APR template-based repair(PAR/TBar)의 전형 — "결함 위치는 주어졌고 fix 패턴이 정형(누락 키워드 인자 주입)"이라 합성·탐색·테스트 반복 없이 단일 변환으로 푼다. 이슈 본문이 곧 oracle 패치에 가까워 generate 단계가 거의 사라진다.

## 난이도 티어
**Tier = T2 (쉬움)**. 구조적 피처:
- **파일/줄수**: 1파일(`django/core/management/__init__.py`), 골드 헌크 1개, 실질 변경은 키워드 인자 1개 추가(`prog=self.prog_name`). T1~T2의 "1파일 소규모" 프로파일.
- **localize 직접성 (L0)**: 이슈가 심볼·줄·수정코드를 다 줌. T1 후보로 끌어내리는 강한 신호.
- **repro (has-repro)**: 이슈에 명확한 재현 시나리오(임베디드에서 `sys.argv[0]=None`)가 있고, 골드 테스트가 그걸 `mock.patch('sys.argv', [None]+args)`로 그대로 재현. repro는 가장 강한 easiness 신호.
- **T1이 아닌 이유 (T2로 미는 것)**: ① K-Domain — argparse 디폴트 `prog` 동작과 management 진입점 구조를 알아야 "왜 버그인지" 이해. T1은 K-Gen 전제. ② **regression-trap (넓은 P2P)** — PASS_TO_PASS가 181개로 매우 광범위(`admin_scripts.tests` 전반: runserver/startproject/settings 핸들링/CommandTypes 등). 같은 파일·같은 진입 경로의 인접 동작을 하나도 깨면 안 됨. ③ 같은 파일에 `CommandParser`/argparse 생성 지점이 여럿이라 "옵션 선파싱용 그 한 군데"만 정확히 골라야 함.
- **공식 라벨과의 정합**: 공식 difficulty가 "15 min - 1 hour"(T2~T3 prior). 코드 변경 자체는 T1급이지만 hints_text가 "regression test is crucial"이라고 명시했듯 회귀 안전 입증(넓은 P2P + mock 기반 테스트 작성)이 시간을 먹는다. 구조피처로 재조정해 **T2** — 공식 라벨 하한과 일치하며, 넓은 P2P trap이 T1 강등을 막는다.

## 골드패치 분석
- **건드린 파일·함수**: `django/core/management/__init__.py` → `ManagementUtility.execute`
- **근본 원인**: `execute()` 안에서 옵션 선파싱용
  `parser = CommandParser(usage='%(prog)s subcommand [options] [args]', add_help=False, allow_abbrev=False)`
  를 만들 때 `prog`를 생략. argparse는 `prog`가 없으면 `os.path.basename(sys.argv[0])`로 채우므로, `__init__`에서 전달 argv로 계산해 둔 `self.prog_name`이 무시되고 전역 `sys.argv`에 종속된다. `sys.argv[0]`이 `None`인 환경에선 basename 계산에서 예외까지 발생.
- **수정 요지**: 동일 `CommandParser` 생성 호출에 `prog=self.prog_name` 키워드 인자 한 개 추가. 이제 usage의 `%(prog)s`가 전달된 argv 기반 프로그램명을 쓰고, `sys.argv[0]`이 `None`이어도 더 이상 의존하지 않는다. 다른 로직·시그니처 변경 없음.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_program_name_from_argv (admin_scripts.tests.ExecuteFromCommandLine)`
- **동작**: 신규 테스트 클래스 `ExecuteFromCommandLine`가 `execute_from_command_line`을 import하고, `args=['help','shell']`에 대해 `mock.patch('sys.argv', [None] + args)`로 전역 `sys.argv[0]`을 `None`으로 만든 뒤 `execute_from_command_line(['django-admin'] + args)`를 호출한다. `captured_stdout/captured_stderr`로 출력을 캡처.
- **픽스 증명**: 단언은 `self.assertIn('usage: django-admin shell', out.getvalue())` + `self.assertEqual(err.getvalue(), '')`. 패치 전엔 `prog`가 `sys.argv[0]=None`에서 유도되어 usage가 틀리거나 basename 계산에서 예외→stderr 비어있지 않음. 패치 후엔 전달된 `'django-admin'`이 `self.prog_name`으로 흘러 usage에 그대로 찍히고 stderr가 빔. 이 테스트는 "전역 sys.argv가 아니라 전달 argv가 prog를 결정한다"는 정확한 불변식을 관찰(real effect)하므로 picky하게 fix를 증명한다.
- **overfit 관점**: FAIL_TO_PASS가 1개라 얇아 보이나, special-case 통과가 어려운 구조다 — assertion이 "전달된 prog 문자열이 usage에 반영"이라는 일반 동작을 직접 본다. 골드처럼 `prog=self.prog_name`을 넘기는 일반 해가 가장 자연스럽고, 테스트만 만족시키는 꼼수(예: usage 문자열 하드코딩)는 다른 prog 값에서 즉시 깨진다. overfit 위험 낮음.
- **regression 관점**: PASS_TO_PASS 181개가 같은 진입 경로(`admin_scripts.tests` 전반)를 광범위하게 커버한다. 특히 `test_program_name_in_help (MainModule)`, 수많은 settings/runserver/startproject 케이스가 `self.prog_name`/usage 출력에 의존. `prog=self.prog_name`은 정상 실행에서 `self.prog_name == basename(sys.argv[0])`이라 기존 동작을 보존 — 그래서 181개가 안 깨진다. regression-trap이 실재하지만 골드 픽스가 그 위를 통과.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `ManagementUtility`/`CommandParser`/`self.prog_name`/`--pythonpath`·`--settings`를 직접 명명한다. `execute_from_command_line` → `ManagementUtility.execute` → 옵션 선파싱용 첫 `CommandParser(usage='%(prog)s ...', add_help=False, allow_abbrev=False)` 생성부로 grep 한 번에 수렴(L0). `self.prog_name`이 `__init__`에서 전달 argv로 계산되고 `__main__.py`→`python -m django` 특수처리됨을 같은 파일에서 확인하면 fix 위치가 확정된다.
2. **픽스와 일반화 정당성**: 그 `CommandParser(...)` 호출에 `prog=self.prog_name`을 추가. 올바른 일반화인 이유 — 버그의 본질은 "이미 계산한 prog를 전역 디폴트(sys.argv[0])로 덮어쓰게 둠"이다. 전달된 값을 명시적으로 주입하는 것은 argparse 계약을 그대로 따르는 정공법이라, 특정 테스트 입력이 아니라 **모든 argv 입력**에 대해 일관되게 동작한다. usage 문자열을 손대거나 sys.argv를 전역 보정하는 방식은 부분해/안티패턴.
3. **regression 안전**: 정상 실행 경로에선 `self.prog_name == os.path.basename(sys.argv[0])`이므로 prog 명시가 기존 출력을 바꾸지 않는다. 따라서 `test_program_name_in_help`을 비롯한 181개 P2P(runserver/settings/startproject/CommandTypes/help·version 처리 전반)가 그대로 통과해야 하고 통과한다. 깨면 안 되는 핵심은 "usage·prog 표기를 쓰는 모든 인접 동작"이다.
4. **함정 회피**: 오라클 없는 에이전트의 실패 지점 — ① argparse 디폴트 `prog` 동작(미지정 시 sys.argv[0] basename)을 모르면 "왜 prog 누락이 sys.argv 의존을 만드나"를 못 짚어 엉뚱한 곳(예: `__init__`의 prog_name 계산)을 건드린다. ② 같은 파일에 `CommandParser`/argparse 생성 지점이 여러 곳이라(서브커맨드 파싱 등) "옵션 선파싱용 그 한 군데"가 아닌 곳을 고치면 FAIL_TO_PASS는 통과해도 의미가 어긋나거나 P2P를 깬다. ③ hints_text가 경고하듯 재현이 까다로워(`sys.argv` mock + `captured_stdout/stderr` 필요) 테스트를 스스로 구성하지 못하면 픽스 정당성을 증명 못 한다 — `mock.patch('sys.argv', [None]+args)`로 None 시나리오를 재현하는 게 정석.
