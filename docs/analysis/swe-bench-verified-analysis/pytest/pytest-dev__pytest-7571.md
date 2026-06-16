---
instance_id: pytest-dev__pytest-7571
repo: pytest-dev/pytest
base_commit: 422685d0bdc110547535036c1ff398b5e1c44145
version: "6.0"
difficulty: "15 min - 1 hour"
created_at: 2020-07-29T12:00:47Z
fail_to_pass: 1
pass_to_pass: 14
gold_files: [src/_pytest/logging.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`caplog` fixture는 문서상 "set_level로 바꾼 로그 레벨은 테스트 끝에 자동 복원된다"고 보장하지만, pytest 6.0에서 깨졌다. 한 테스트에서 `caplog.set_level(42)`를 호출하면 다음 테스트의 `caplog.handler.level`이 0이 아니라 42로 새어나간다. 이슈는 회귀 커밋(fcbaab8)까지 지목하며 최소 재현 코드를 제공한다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 심볼을 직접 찍진 않지만 `caplog.set_level` / `caplog.handler.level`을 본문에 박아줘서 `LogCaptureFixture.set_level`과 `_finalize`로 곧장 수렴한다. grep 한두 번. 단일 파일(`logging.py`).
- **S2 (Constraint-Reasoning)**: 고칠 지점은 명백하나, 올바른 픽스는 "logger 레벨만 복원하던 불변식을 handler 레벨까지 확장"이라는 대칭성 추론이 필요하다. 단순 None가드/상수변경(S1)이 아니라, `set_level`이 mutate하는 두 상태(`logger_obj.setLevel` + `self.handler.setLevel`) 중 하나만 저장/복원되던 누락을 식별해 짝을 맞춰야 한다.
- **K-Domain**: stdlib `logging`의 logger-vs-handler 레벨 이원 구조와 pytest fixture teardown(`_finalize`) lifecycle을 알아야 한다. 일반 파이썬 추론만으론 "handler도 별도 레벨을 가진다"를 놓치기 쉽다.
- **primary = T-ConstraintReason**: 위치는 쉽게 잡히나 난점은 "무엇을 추가로 저장/복원해야 하는가"라는 불변식 합성에 있다. 이 strategy인 이유: 픽스가 테스트 반복 탐색(S3/S4)이 아니라 기존 `at_level`의 save/restore 패턴을 거울삼은 의미적 추론으로 결정되기 때문.

## 난이도 티어
**T3 (중간)**. 구조적 피처: gold가 1파일·실질 3줄(필드 1 + 복원 2 + 저장 1)로 작고, `has-repro`(네이티브 동작 재현)라 localize는 거의 공짜다. 그러나 픽스 자체는 자명한 한 줄이 아니라 "logger 레벨 복원 코드와 대칭으로 handler 레벨 복원 코드를 추가"하는 의미 추론(S2)과 logging 도메인 지식(K-Domain)을 요구한다. 공식 라벨 "15분~1시간"과 일치 — repro가 강한 easiness 신호라 T4까지는 안 오르고, S1 템플릿이 아니라 T2도 아니다. P2P 14개(인접 caplog 동작 전부)가 regression-trap을 형성하지만 좁은 단일 파일이라 조율 부담은 낮다.

## 골드패치 분석
- **파일/심볼**: `src/_pytest/logging.py`의 `LogCaptureFixture.__init__`, `_finalize`, `set_level`.
- **근본 원인**: `set_level`은 두 객체의 레벨을 바꾼다 — `logger_obj.setLevel(level)`과 `self.handler.setLevel(level)`. 그런데 teardown 복원용 저장은 `self._initial_logger_levels.setdefault(...)`로 **logger 레벨만** 기록했다. handler의 원래 레벨은 어디에도 저장되지 않아 `_finalize`가 복원할 수 없었고, handler는 다음 테스트로 오염된 레벨을 들고 넘어갔다. (회귀 커밋 fcbaab8에서 handler가 테스트 간 재생성되지 않게 바뀌며 노출됨.)
- **수정 요지**: `__init__`에 `self._initial_handler_level = None` 필드 추가. `set_level`에서 `logger_obj.setLevel` 직후 `self._initial_handler_level = self.handler.level`로 원래 handler 레벨을 저장. `_finalize`에서 `if self._initial_handler_level is not None: self.handler.setLevel(self._initial_handler_level)`로 복원. 이미 존재하던 `at_level` context manager의 save/restore 대칭을 fixture-lifetime 경로에도 동일하게 적용한 것.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_change_level_undos_handler_level`: 세 테스트를 `testdir`로 띄워 test1이 `set_level(41)`로 handler.level을 41로 만든 뒤, test2가 `caplog.handler.level == 0`(복원됨)을 단언하고, test3이 또 `set_level(43)` 후 즉시 43임을 단언한다. 픽스 전엔 test2에서 41이 새어 실패; 픽스 후 `_finalize`가 0으로 복원해 passed=3.
- **픽스 증명**: 단언이 logger가 아니라 **handler.level**을 직접 본다 — gold가 새로 저장/복원하는 바로 그 상태. 따라서 픽스가 동작 효과로 관찰된다.
- **overfit/regression 관점**: `_initial_handler_level`을 단일 스칼라로 두는 건 약한 overfit 우려(같은 테스트 내 다중 `set_level` 호출 시 첫 값만이 아니라 마지막 값 기준 — 그러나 logger도 `setdefault`로 첫 값을 잡으므로 한 테스트에서 첫 호출만 저장하는 게 일관적; 다만 handler는 `=` 대입이라 마지막 호출 기준이 됨, 미세 비대칭이나 테스트는 단일 호출이라 노출 안 됨). regression: P2P의 `test_change_level_undo`, `test_with_statement`(at_level 경로) 등 14개가 caplog 레벨 동작을 광범위하게 고정해, handler 복원이 logger 복원이나 at_level 경로를 깨지 않음을 보장한다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 본문의 `caplog.set_level`·`caplog.handler.level`·"restored at the end of the test"를 키워드로 `LogCaptureFixture`를 찾고, 복원 책임 메서드 `_finalize`와 변경 메서드 `set_level`을 나란히 읽는다. `set_level`이 logger와 handler 둘 다 `setLevel`하는데 저장은 `_initial_logger_levels`로 logger만 함을 발견 — 누락 지점 확정.
2. **픽스(올바른 일반화)**: 같은 클래스의 `at_level`이 이미 `handler_orig_level = self.handler.level` 저장 후 finally에서 되돌리는 검증된 패턴을 갖고 있다. 이를 fixture-lifetime으로 옮겨 `__init__`에 초기값 필드를 두고 `set_level`에서 원래 레벨 저장, `_finalize`에서 복원. handler 자체 동작이 아니라 "set_level이 변경한 모든 상태의 대칭 복원"을 다루므로 특정 테스트가 아닌 일반 케이스를 고친다 — overfit 아님.
3. **regression 안전**: `_initial_logger_levels` 복원 루프는 손대지 않고 그 앞에 handler 복원만 추가한다. `None` 가드로 `set_level`을 부르지 않은 테스트는 handler를 건드리지 않아(불필요한 setLevel(0) 강제 안 함) at_level 전용·레벨 미변경 경로의 P2P가 안전.
4. **함정 회피**: 오라클 없는 에이전트는 (a) logger 레벨만 보고 "이미 복원 코드 있는데?"라며 멈추거나, (b) `_finalize`에서 무조건 `self.handler.setLevel(0)`으로 하드코딩(원래 0이 아니었던 경우 깨짐)하기 쉽다. 핵심은 "0 복귀"가 아니라 "변경 전 실제 값 저장 후 복원"이며, `None` 센티넬로 미호출 케이스를 구분하는 것. logger와 handler가 **별개 레벨**을 가진다는 logging 도메인 사실을 놓치면 근본 원인 자체를 못 본다.
