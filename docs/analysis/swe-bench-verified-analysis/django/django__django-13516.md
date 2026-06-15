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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-API
flags: [has-repro]
---

# django__django-13516

## 문제 요약
management 커맨드의 `self.stdout`/`self.stderr`에서 호출하는 `flush()`가 실제로 동작하지 않는다. `migrate` 같은 긴 커맨드에서 진행 메시지(`Applying myapp.0002_... `)가 즉시 출력되지 않고, 마이그레이션이 다 끝난 뒤에야 한꺼번에 flush 되어 사용자는 작업이 진행 중인지 멈췄는지 알 수 없다. problem_statement에 before/after 출력 예시가 그대로 박혀 있어, 기대 동작은 `Applying ...` 라인이 작업 시작 시점에 곧바로 화면에 나타나는 것이다. 근본은 `self.stdout`이 raw stream이 아니라 `OutputWrapper`로 감싸여 있고, 이 래퍼가 `flush`를 underlying stream으로 전달하지 않는다는 것.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)** — problem_statement이 "`flush()` on self.stdout/stderr management commands doesn't work"로 결함 메서드(`flush`)와 객체(`self.stdout`)를 직접 지목한다. `self.stdout`은 `BaseCommand`가 `OutputWrapper`로 감싼 것이므로, `OutputWrapper` 클래스 정의(`django/core/management/base.py`)로 grep 한 방에 수렴한다. 후보 탐색이 거의 없다.
- **S (Repair Strategy) = S1 (Direct-Map / template)** — 결함 클래스가 정형이다: "delegating wrapper에 누락된 pass-through 메서드". 픽스는 기계적으로 인접 위임 메서드(`isatty()`)의 패턴을 복사해 `flush()`를 추가하는 것. 올바른 식·불변식을 추론으로 합성할 필요가 없다(S2 아님). 후보가 다수라 테스트로 골라야 하는 상황도 아니다(S3/S4 아님). 이슈가 사실상 픽스를 명세한다 → 템플릿 매칭.
- **K (Knowledge) = K-API (API-contract)** — `OutputWrapper`는 stream-like 객체로서 file-object 계약(write/flush/isatty)을 흉내내야 한다. `flush`는 그 공개 stream 인터페이스의 일부이고, underlying stream에 `flush`가 없을 수도 있으므로(`StringIO` 외 다양한 stream) `hasattr` 가드로 계약을 안전하게 맞춰야 한다. 깊은 ORM/query-compiler 도메인 지식은 아니다(K-Domain 아님). file-object/stream API 계약 인지가 핵심이라 K-API.

**Primary type = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 메서드 추가(S1)다. 찾으면 끝이고 픽스가 자명에 가까우나, "왜 `__getattr__` 폴백이 안 타는가"라는 한 겹의 이해가 필요해 순수 T-LocTrivial보다 살짝 위. 가드 추가/위임 추가라는 정형 픽스이므로 T-DirectMap이 dominant.

왜 S1인가(APR 관점): TBar/PAR 류의 fix-pattern 카탈로그에서 "missing method delegation / forward call to delegate"는 표준 결함 템플릿이다. 동일 클래스 내 `isatty()`가 `return hasattr(self._out, 'isatty') and self._out.isatty()`로 이미 정확히 같은 hasattr-guarded delegation 패턴을 쓰므로, 픽스는 그 도너(donor) 코드를 그대로 적용하는 transplant에 해당한다. semantic synthesis(SemFix/Angelix)도, generate-and-validate 반복도 불필요하다.

## 난이도 티어

**Tier = T2 (쉬움).** 공식 difficulty 라벨은 "15 min - 1 hour"(T3 prior)이지만 T2로 하향한다.

이 티어로 미는 구조적 피처:
- **수정 범위 최소** — 1파일, 1메서드, 실질 3줄(`+4` 라인). ICLR 2024 컷에서 1파일·<5줄 구간(≈48% solve)에 정확히 위치.
- **L0 직접 localize** — 이슈가 `flush`/`self.stdout`을 명시 → grep 한 방. 51% 실패 원인인 localization 에러 리스크가 사실상 없다.
- **has-repro** — problem_statement이 before/after 출력을 그대로 보여주는 재현 시나리오를 담고 있다(가장 강한 easiness 신호).
- **도너 패턴 존재** — 동일 클래스 `isatty()`가 그대로 베낄 픽스 템플릿을 제공.
- **P2P trap 거의 없음** — 신규 메서드 추가라 기존 동작을 깰 표면이 좁다. 43개 P2P는 대부분 커맨드 파싱/실행 테스트로, `OutputWrapper`에 메서드 하나 추가가 이들을 깨뜨릴 경로가 없다(regression-trap 미표기).

**공식 라벨과 다른 이유**: "15분-1시간"은 개발자가 (1)래퍼 구조를 처음 더듬고 (2)`__getattr__`가 왜 안 타는지 이해하는 인지 비용을 반영한 시간으로 보인다. 그러나 에이전트 난이도 기준(localize 직접성·픽스 자명성·repro·regression 안전)으로 보면 이 문제는 T2의 전형이다. 시간 라벨은 "구현 노력"이라 한 겹의 개념 이해를 시간으로 환산하지만, 구조적 피처는 모두 쉬움을 가리킨다.

## 골드패치 분석

- **건드린 파일·함수**: `django/core/management/base.py` — `OutputWrapper` 클래스에 `flush()` 메서드 신규 추가.
- **근본 원인**: `OutputWrapper`는 `__init__(self, out, ending='\n')`로 underlying stream을 `self._out`에 보관하고, `__getattr__`로 *미정의* 속성만 `self._out`에 위임한다. 문제는 `OutputWrapper`가 `flush`를 이미 어딘가에서 정의/상속(또는 `write`가 ending을 붙이는 stream-like 구현)하고 있어 `__getattr__` 폴백이 타지 않거나, 타더라도 의도와 다르게 동작한다는 점. 그래서 `self.stdout.flush()` 호출이 underlying stream의 진짜 `flush()`에 도달하지 못해 OS 레벨 버퍼가 비워지지 않고, 긴 작업 동안 출력이 지연됐다.
- **수정 요지**: `OutputWrapper`에 명시적 `flush()`를 추가한다.
  ```python
  def flush(self):
      if hasattr(self._out, 'flush'):
          self._out.flush()
  ```
  underlying stream이 `flush`를 가진 경우에만 직접 호출하도록 위임. 바로 아래 `isatty()`가 쓰는 `hasattr(self._out, ...)` 방어 패턴을 그대로 미러링해 스타일 일관성과 안전성(flush 없는 stream에 대한 AttributeError 회피)을 모두 만족한다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_outputwrapper_flush (user_commands.tests.CommandTests)`.
- **동작 / 픽스 증명**:
  - 신규 테스트 커맨드 `tests/user_commands/management/commands/outputwrapper.py`의 `handle()`이 `self.stdout.write('Working...')` → `self.stdout.flush()` → `self.stdout.write('OK')`를 순서대로 호출.
  - 테스트는 `StringIO()`를 `stdout`으로 넘기고 `mock.patch.object(out, 'flush')`로 underlying stream의 `flush`를 감시한 뒤 `management.call_command('outputwrapper', stdout=out)` 실행.
  - 단언: `assertIn('Working...', out.getvalue())`로 출력이 실제 기록됐는지 확인하고, `assertIs(mocked_flush.called, True)`로 래퍼의 `flush()`가 underlying `flush`까지 도달했는지 증명. 픽스 전에는 래퍼가 `flush`를 underlying stream으로 전달하지 않아 `mocked_flush.called == False`로 실패한다.
- **overfit 관점**: 테스트가 1개로 얇긴 하나, 검증 지점이 "underlying `flush`가 실제로 호출됐는가"라는 정확한 인과(`mocked_flush.called`)를 짚는다. special-case로 통과시키기 어렵다 — `called`를 True로 만들려면 결국 underlying `flush`를 호출하는 수밖에 없다. 그래서 골드 픽스(hasattr 가드 + delegation)가 가장 자연스러운 일반해이고, overfit-risk 플래그는 미표기.
- **regression 관점**: 신규 메서드 추가라 43개 P2P 어느 것도 깨지 않는다. `flush` 없는 stream도 `hasattr` 가드로 안전(AttributeError 미발생). regression-trap 미표기.

## 모범답안 (오라클 기반)

1. **Localize 경로**: 이슈의 "`flush()` on self.stdout/stderr ... doesn't work" 신호 → `self.stdout`이 무엇인지부터 추적한다. `django/core/management/base.py`의 `BaseCommand.__init__`에서 `self.stdout = OutputWrapper(stdout or sys.stdout)`로 감싸는 것을 확인 → `OutputWrapper` 클래스로 직행. 클래스 본문에서 `write`, `isatty`, `__getattr__`는 보이는데 `flush`가 없음을 발견. 이것이 누락된 위임 메서드다.

2. **픽스와 왜 올바른 일반화인가**: `flush(self)`를 추가하고 `if hasattr(self._out, 'flush'): self._out.flush()`로 위임. 이것이 overfit이 아닌 이유 — (a) file-object/stream API 계약상 `flush`는 표준 메서드이고 어떤 underlying stream에도 일관되게 의미가 있다(테스트의 `StringIO`만이 아니라 실제 `sys.stdout`, 파이프, 파일 모두). (b) 바로 아래 `isatty()`가 동일한 hasattr-guarded delegation을 쓰므로 코드베이스의 확립된 관례를 따른다 — 클래스 전체에 일관된 일반해. 특정 테스트 입력에 맞춘 특수 분기가 전혀 없다.

3. **Regression 안전**: 43개 P2P(`test_command`, `test_call_command_*`, `test_subparser_*`, `test_output_transaction` 등)는 커맨드 파싱·실행·출력 트랜잭션을 검증한다. `flush()`는 *신규* 메서드라 기존 메서드 시그니처/동작을 바꾸지 않으므로 이들을 깰 경로가 없다. `hasattr` 가드 덕에 `flush`를 갖지 않는 underlying stream에서도 AttributeError 없이 no-op으로 안전하게 동작 — 기존 출력 경로(`write`, `isatty`, `__getattr__` 위임)는 그대로 보존된다.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) **잘못된 파일 헤집기**: 증상이 `migrate`에서 나타나므로 `django/core/management/commands/migrate.py`나 마이그레이션 progress callback을 고치려 들 수 있다. 그러나 정답은 출력 래퍼 한 곳이다(증상 위치 ≠ 결함 위치). (b) **`__getattr__` 착각**: "`__getattr__`가 있으니 `flush`도 자동 위임될 텐데?"라고 판단해 손대지 않으면 버그가 남는다 — `__getattr__`는 *정의되지 않은* 속성에만 타고, `OutputWrapper`/그 상속 체인이 `flush`를 이미 노출하면 폴백이 발동하지 않는다. 명시적 메서드가 필요한 이유. (c) **가드 누락**: `self._out.flush()`를 무조건 호출하면 `flush` 없는 stream에서 AttributeError. `isatty()` 패턴을 미러링해 `hasattr` 가드를 넣는 것이 코드베이스 관례이자 안전. 이 세 함정을 피하는 길은 "증상이 아니라 `self.stdout`의 실제 타입을 localize → 인접 도너 메서드(`isatty`)의 패턴을 그대로 복사"다.
