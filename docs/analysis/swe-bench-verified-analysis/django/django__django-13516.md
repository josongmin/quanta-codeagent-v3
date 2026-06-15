---
instance_id: django__django-13516
repo: django/django
base_commit: b7da588e883e12b8ac3bb8a486e654e30fc1c6c8
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-10-08T19:00:01Z
fail_to_pass: 1
pass_to_pass: 43
gold_files: [django/core/management/base.py]
---

# django__django-13516

## 문제 요약
management 커맨드의 `self.stdout`/`self.stderr`에서 호출하는 `flush()`가 실제로 동작하지 않는다. `migrate` 같은 긴 커맨드에서 진행 메시지(`Applying ...`)가 즉시 출력되지 않고 마이그레이션이 다 끝난 뒤에야 한꺼번에 flush 되어, 사용자는 작업이 진행 중인지 멈췄는지 알 수 없다. 기대 동작은 `Applying ...` 라인이 작업 시작 시점에 곧바로 화면에 나타나는 것이다.

## 유형 분류
- 버그 카테고리: 누락처리 (API-contract — `flush()` 메서드가 래퍼에서 위임되지 않음)
- 서브시스템: django core management (BaseCommand / OutputWrapper)
- 증상 타입: silent-wrong (출력이 지연되어 진행 표시가 무의미해짐)
- 로컬라이제이션 신호: problem_statement이 "`flush()` on self.stdout/stderr"를 명시 → `self.stdout`이 감싸진 `OutputWrapper` 객체이고, 이 래퍼가 `flush`를 underlying stream으로 전달하지 않는다는 점이 핵심 단서

## 골드패치 분석
- 건드린 파일/함수: `django/core/management/base.py` : `OutputWrapper.flush()` (신규 추가)
- 근본 원인: `OutputWrapper`는 `__getattr__`로 미정의 속성을 `self._out`에 위임한다. 그런데 `OutputWrapper`가 (간접적으로) `flush`를 자체적으로 노출하거나, `write()` 시 매번 ending을 붙여 내보내는 구조여서 `self.stdout.flush()` 호출이 underlying stream의 `flush`로 제대로 도달하지 못했다. 결과적으로 버퍼가 비워지지 않아 출력이 지연됐다.
- 수정 요지: `OutputWrapper`에 명시적 `flush()` 메서드를 추가하여, `self._out`이 `flush`를 가진 경우 `self._out.flush()`를 직접 호출하도록 위임한다(3줄). `isatty()`가 이미 같은 `hasattr` 위임 패턴을 쓰는 것과 동일한 방어적 스타일을 따른다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_outputwrapper_flush (user_commands.tests.CommandTests)`
- 테스트가 어떻게 픽스를 증명하는지:
  - 신규 테스트 커맨드 `tests/user_commands/management/commands/outputwrapper.py`가 `handle()`에서 `self.stdout.write('Working...')` → `self.stdout.flush()` → `self.stdout.write('OK')`를 순서대로 호출.
  - 테스트는 `StringIO()`를 `stdout`으로 넘기고 `mock.patch.object(out, 'flush')`로 underlying stream의 `flush`를 감시한 뒤 `call_command('outputwrapper', stdout=out)` 실행.
  - 재현 입력: 커맨드 실행 → 기대 출력: `out.getvalue()`에 `'Working...'`이 포함되고, `mocked_flush.called`가 `True`. 픽스 전에는 래퍼의 `flush`가 underlying `flush`에 도달하지 않아 `called == False`로 실패한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `self.stdout`이 어떤 타입인지부터 추적. `BaseCommand.__init__`에서 `OutputWrapper(stdout or sys.stdout)`로 감싸는 것을 확인하면 곧장 `OutputWrapper` 클래스로 좁혀진다. 그 안에서 `isatty`, `__getattr__` 등 위임 메서드를 보면 `flush`가 누락됐음이 드러난다.
- 함정/난이도 메모: `__getattr__`가 있으니 "어차피 위임되지 않나?" 착각하기 쉽다. 하지만 `OutputWrapper`가 `flush`를 자체적으로 갖거나 stream-like 동작을 흉내내는 부분 때문에 `__getattr__` 폴백이 타지 않거나, 위임돼도 의도와 다르게 동작한다 — 그래서 명시적 메서드가 필요하다. 단일 파일·단일 메서드라 멀티파일은 아님.
- 우리 에이전트 관점: 너무 작은 수정이라 오히려 "어디를 고쳐야 진짜 flush가 보장되는가"를 정확히 짚는 게 관건. 잘못하면 `migrate.py`나 progress callback 쪽을 헤집을 수 있는데, 정답은 출력 래퍼 한 곳이다. `isatty()` 위임 패턴을 미러링해 `hasattr` 가드까지 맞추는 스타일 일관성을 지키는지가 품질 포인트.
