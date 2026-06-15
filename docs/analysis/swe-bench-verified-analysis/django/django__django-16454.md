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
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

# django__django-16454

## 문제 요약
Django management command는 에러 포매팅을 개선하기 위해 `argparse.ArgumentParser`의 서브클래스인 `CommandParser`를 쓰는데, `CommandParser`가 생성자에서 받는 추가 인자(`called_from_command_line`, `missing_args_message`)가 `parser.add_subparsers().add_parser()`로 만들어진 서브파서로 전파되지 않는다. 그 결과 서브파서 레벨에서 인자 누락/타입 오류가 나면 사용자 친화적 usage 메시지 대신 raw stack trace(`CommandError`)가 CLI에 그대로 노출된다. 최상위 파서(`./manage.py cheeses`)는 깔끔한 `manage.py cheeses: error: ...`를 내는데, 서브파서(`./manage.py cheeses create`)는 traceback을 내는 비일관성이 핵심 증상이다. problem_statement에 재현 커맨드와 실제 traceback(끝이 `base.py` line 72 `error()`)이 그대로 들어 있다.

## 유형 (정형화)

**L (Localization) = L0 (Pinpointed).** problem_statement가 `CommandParser`, `CommandParser.add_subparsers().add_parser()`, 그리고 traceback의 마지막 프레임으로 `django/core/management/base.py` line 72 `error()`까지 직접 지목한다. 파일·클래스·메서드가 모두 명시되어 grep 한 방으로 진입한다. cross-file 추적 불요 — `cross-file-dep` 플래그는 코드 파일 간이 아니라 코드와 표준 라이브러리 argparse 내부 계약(`_SubParsersAction.add_parser`가 `parser_class(**kwargs)`로 인스턴스화) 사이의 암묵적 의존을 의미한다.

**S (Repair Strategy) = S2 (Constraint-Reasoning) + S6 (Design-Refactor).** 고칠 클래스(`CommandParser`)는 자명하지만 "어떻게"는 기계적 가드 추가(S1)가 아니다. 올바른 픽스는 argparse가 서브파서를 어느 호출 경로에서 어떤 kwargs로 만드는지를 추론해, 부모의 `called_from_command_line`을 그 경로에 주입하는 식을 합성해야 한다(S2). 그리고 그 주입은 한 줄 값 변경이 아니라 `add_subparsers()` 메서드를 새로 오버라이드하고 `functools.partial`로 `parser_class`를 감싸는 작은 구조 변경(S6)으로 이뤄진다 — 신규 import + 신규 메서드. 후보를 마구 생성해 테스트로 거르는 G&V(S3)가 아니라 메커니즘 이해로 "생각으로" 푸는 문제다.

**K (Knowledge) = K-Domain.** 일반 파이썬 추론(K-Gen)만으론 부족하다. (1) Django의 `CommandParser`가 무엇을 왜 커스터마이즈하는지(`error()` 오버라이드, `called_from_command_line` 플래그), (2) argparse의 서브파서 생성 내부 — `add_subparsers`가 `_SubParsersAction`을 만들고 `add_parser`가 `parser_class`를 instantiate한다는 점, (3) `parser_class` 기본값 관례를 알아야 한다. Django CLI 프레임워크 + stdlib argparse 양쪽의 내부 지식이 병목이라 K-Domain.

**Primary type = T-DomainBound.** 위치는 L0로 자명하므로 난점이 localize에 있지 않고(→ T-DiffuseLoc 아님), 픽스가 기계적이지도 않다(→ T-DirectMap 아님). 진짜 병목은 "argparse 서브파서가 어떤 kwargs로 만들어지고 거기에 어떻게 부모 설정을 끼워넣느냐"는 프레임워크/stdlib 내부지식이다. K-Domain이 dominant이므로 T-DomainBound. (S2 추론도 강하지만 그 추론 자체가 도메인 지식에 종속되어 있어 T-ConstraintReason보다 T-DomainBound가 더 정확.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(prior로 T2~T3 영역)인데 T4로 한 단계 올린다.

이 티어로 미는 구조적 피처:
- **단일 파일·~10줄(import 1 + 9줄 메서드)** — patch scope는 작아 T1~T2 쪽으로 당기는 신호이고, has-repro(재현 커맨드 + 네이티브 traceback 존재)도 강한 easiness 신호다.
- 그러나 **localize 직접성과 픽스 도출 난이도가 분리**된다. 위치는 L0로 쉽지만, 올바른 픽스는 argparse 내부 인스턴스화 경로(`parser_class(**kwargs)`)와 `partial` 주입 트릭이라는 K-Domain 추론을 요구한다. 표면 증상("에러 메시지가 이상함")에 끌려 `error()`나 출력 레이어를 만지는 오답 경로가 매력적이다.
- **regression-trap (P2P=45)** — 인접 동작이 광범위하다. 특히 `test_subparser`, `test_subparser_dest_args`, `test_subparser_dest_required_args`, `test_subparser_invalid_option` 등 기존 서브파서 동작과, vanilla `argparse.ArgumentParser`를 `parser_class`로 주는 경우(신규 fixture가 검증)를 안 깨야 한다. `issubclass` 가드 없이 무조건 `partial`로 감싸면 non-django parser_class에 잘못된 kwargs를 넘겨 회귀.

공식 라벨이 더 쉽게 본 이유: 시간 라벨은 "정답을 아는 Django 코어 개발자의 구현 시간"이라 메커니즘이 이미 머릿속에 있다. 오라클 없는 에이전트에겐 localize 쉬움 ≠ 픽스 쉬움이며, overfit 유혹(증상 레이어 패치)과 P2P trap이 시간 라벨에 안 잡힌다. 따라서 에이전트 난이도 기준 T4가 방어 가능.

## 골드패치 분석
- **건드린 파일/함수:** `django/core/management/base.py`
  - 상단에 `from functools import partial` import 추가.
  - `CommandParser`에 `add_subparsers(self, **kwargs)` 메서드 신규 오버라이드.
- **근본 원인:** stdlib `argparse`의 기본 `add_subparsers()`는 `_SubParsersAction`을 생성하고, 그 액션의 `add_parser()`가 새 서브파서를 만들 때 `parser_class(**kwargs)`로 instantiate한다. `CommandParser`는 `__init__`에서 `called_from_command_line` 등 추가 kwargs를 받아 `error()` 동작(usage 메시지 vs `CommandError` raise)을 결정하는데, 서브파서 생성 경로에는 이 kwargs를 주입할 자리가 없었다. 그래서 서브파서는 `called_from_command_line`이 빠진 기본 `CommandParser()`로 만들어져 부모의 에러 핸들링을 상속하지 못하고, 에러 시 `CommandError` traceback을 그대로 노출했다.
- **수정 요지:** `add_subparsers()`를 오버라이드해 `parser_class = kwargs.get("parser_class", type(self))`를 꺼내고, 그것이 `CommandParser`의 서브클래스이면 `functools.partial(parser_class, called_from_command_line=self.called_from_command_line)`로 감싸 `kwargs["parser_class"]`에 다시 넣은 뒤 `super().add_subparsers(**kwargs)`로 위임한다. 결과적으로 `add_parser()`가 서브파서를 instantiate할 때 부모의 `called_from_command_line` 값이 partial로 미리 바인딩되어 전파된다. `issubclass(parser_class, CommandParser)` 가드 덕에 vanilla `argparse.ArgumentParser`를 명시한 경우엔 감싸지 않고 그대로 위임해 호환성을 유지한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_subparser_error_formatting` — 기존 `subparser` 커맨드를 `["subparser", "foo", "twelve"]`로 실행(서브파서 `foo`의 `bar` int 인자에 `"twelve"` 전달). stderr가 정확히 2줄이고 둘째 줄이 `"manage.py subparser foo: error: argument bar: invalid int value: 'twelve'"`여야 한다 — traceback이 아니라 포맷된 usage error. 픽스 전엔 int 변환 실패가 `CommandError` traceback으로 터졌으나, 픽스 후엔 서브파서가 `called_from_command_line=True`를 상속해 `error()`가 usage + error 2줄만 stderr로 낸다.
- **회귀 가드 (PASS_TO_PASS에 포함된 신규 테스트):** `test_subparser_non_django_error_formatting` — 신규 fixture `subparser_vanilla.py`가 `parser.add_subparsers(parser_class=argparse.ArgumentParser)`로 vanilla parser_class를 명시. 이 경우에도 동일한 2줄 포맷이 나오는지 검증해, `issubclass` 가드가 non-django parser_class를 건드리지 않음을 증명한다(분기의 두 갈래 모두 커버).
- **overfit 관점:** FAIL_TO_PASS가 1개뿐이라 얇아 보이지만, 골드는 증상 레이어(`error()` 출력)를 직접 만지지 않고 생성 경로(`add_subparsers`)를 고친다. special-case 패치(예: 특정 메시지 문자열 가공)로 FAIL_TO_PASS만 통과시키는 overfit이 가능하나, vanilla fixture 회귀 테스트가 그런 얕은 패치를 일부 걸러낸다. 다만 FAIL_TO_PASS 1개 + 핵심 분기를 P2P 신규 테스트가 받쳐주는 구조라 weak-suite overfit 위험이 완전히 0은 아님 → `overfit-risk`는 표기하지 않되(분기 양쪽이 테스트됨) 경계.
- **regression 관점:** P2P 45개 중 다수가 `test_subparser*` 계열(기존 서브파서 정상/에러/dest/required 경로)이라, partial 주입이 기존 서브파서 동작을 바꾸지 않음을 폭넓게 보장한다.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 traceback 마지막 프레임이 `django/core/management/base.py` line 72 `error()`를 직접 가리키므로 `CommandParser` 클래스로 바로 진입(L0). 단, "error를 어디서 고치냐"가 아니라 "서브파서가 왜 부모와 다른 설정으로 만들어지냐"로 질문을 재구성하는 게 핵심 — `CommandParser.__init__`이 받는 `called_from_command_line`을 추적하고, 서브파서가 어디서 만들어지는지(`add_subparsers`/`add_parser`)를 argparse 소스에서 확인한다.
2. **픽스와 왜 올바른 일반화인가:** 증상(에러 출력)이 아니라 원인(서브파서 생성 시 부모 설정 미전파)을 고친다. `add_subparsers()`를 오버라이드해 `parser_class`를 `partial(parser_class, called_from_command_line=...)`로 감싸는 것은 argparse의 `parser_class(**kwargs)` 인스턴스화 계약에 정확히 끼워넣는 일반해다. 특정 메시지/특정 커맨드에 국한되지 않고, `CommandParser` 계열로 만들어지는 모든 서브파서에 부모의 에러 핸들링이 자동 상속되므로 overfit이 아니다.
3. **regression 안전:** `issubclass(parser_class, CommandParser)` 가드가 필수다. 이게 있어야 사용자가 vanilla `argparse.ArgumentParser`를 `parser_class`로 명시한 경우(신규 `subparser_vanilla` fixture, P2P)에 잘못된 `called_from_command_line` kwarg를 넘겨 `TypeError`로 깨뜨리지 않는다. 또 `super().add_subparsers(**kwargs)`로 위임하므로 `_SubParsersAction`의 다른 동작(dest/required 등 `test_subparser_dest_*`, `test_subparser_invalid_option`)을 그대로 보존한다.
4. **함정 회피:** 오라클 없는 에이전트의 전형적 오답은 (a) 표면 증상에 끌려 `error()`나 출력 포매팅을 직접 패치 → vanilla parser 회귀에서 막히거나 일반화 실패, (b) `add_subparsers`를 고치되 `issubclass` 가드를 빠뜨려 무조건 `partial`로 감싸기 → non-django parser_class에서 kwargs 충돌 회귀, (c) `called_from_command_line`을 서브파서 생성 후 사후 설정하려다 argparse가 `add_parser` 시점에 이미 instantiate해버리는 타이밍을 놓침. 회피법: argparse `_SubParsersAction.add_parser`가 `parser_class(**kwargs)`로 만든다는 사실을 먼저 확인하고, 생성 시점에 kwargs를 미리 바인딩하는 `partial` 패턴 + `issubclass` 가드로 두 갈래(django/vanilla)를 모두 안전하게 처리한다.
