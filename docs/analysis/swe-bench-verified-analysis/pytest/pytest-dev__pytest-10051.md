---
instance_id: pytest-dev__pytest-10051
repo: pytest-dev/pytest
base_commit: aa55975c7d3f6c9f6d7f68accc41bb7cadf0eb9a
version: "7.2"
difficulty: "15 min - 1 hour"
created_at: "2022-06-15T17:39:53Z"
fail_to_pass: 1
pass_to_pass: 15
gold_files: [src/_pytest/logging.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`caplog.clear()`를 호출하면 `caplog.get_records()`가 실제 캡처 레코드와 분리(decouple)된다. 테스트 셋업 시 `caplog.get_records(when)`이 가리키는 stash 리스트는 setup 단계에서 `caplog.records`와 **같은 리스트 객체로 별칭(alias)** 설정되는데, `clear()` 경로의 `reset()`은 이 리스트를 비우는 게 아니라 **새 리스트로 교체**해 버린다. 그 결과 `clear()` 이후 `get_records("call")`은 옛 레코드에 얼어붙고, 새 로그도 반영하지 않으며, 클리어도 되지 않는다. 이슈에는 `caplog.get_records("call") == caplog.records` 불변식을 깨뜨리는 재현 코드가 포함돼 있다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈 본문이 `logging.py#L699`(stash에 동일 리스트 바인딩)과 `#L345`(`reset()`의 리스트 교체) 두 줄을 직접 지목한다. grep 없이 `LogCaptureHandler.reset` / `LogCaptureFixture.clear` 두 심볼로 즉시 수렴.
- **S2 (Constraint-Reasoning)**: 고칠 위치는 자명하나, 올바른 픽스는 "리스트 정체성(identity)을 보존하면서 내용만 비운다"는 **별칭 불변식**을 추론해야 도출된다. `self.records = []`(재바인딩) vs `self.records.clear()`(in-place 변이)의 의미 차이가 핵심이며, 단순 가드 추가(S1)가 아니라 자료구조 aliasing 의미론을 따져야 한다.
- **K-Domain**: pytest 내부의 caplog 다단계(setup/call/teardown) 캡처 구조와 `item.stash[caplog_records_key][when] = caplog_handler.records` 별칭 배선을 알아야 "왜 교체가 위험한지"가 보인다.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 픽스의 정당성은 별칭 보존이라는 제약 추론에서 나온다. APR 관점에서 in-place 클리어는 SemFix식 "조건/식 합성"이 아니라 변이 의미 교정이지만, 테스트 반복 탐색(S3/S4)이 아니라 한 번의 의미 추론으로 정답이 결정되므로 S2가 dominant.

## 난이도 티어

- **T3 (중간)**. 구조적 피처: 단일 파일(`src/_pytest/logging.py`), gold 순변경 ~7줄(메서드 1개 추가 + 호출 1줄 교체), L0 직접 localize, **has-repro**(불변식 위반 재현 코드 존재 — 가장 강한 easiness 신호).
- T2가 아닌 이유: 픽스가 "기본값/가드 한 줄"이 아니라, 기존 `reset()`을 건드리지 않고 **별도 `clear()`를 신설**해 변이 의미를 분리하는 설계 판단(왜 reset을 못 고치는가 — 아래 함정)을 요구. 단순 S1보다 한 단계 추론이 더 든다.
- T4는 아님: cross-file 조율 없음, 도메인 깊이가 ORM/query-compiler 급은 아님.
- 공식 라벨("15 min - 1 hour")과 정합. repro가 있어 에이전트 난이도도 라벨대로 중하 수준.

## 골드패치 분석

- **건드린 파일**: `src/_pytest/logging.py` 단일.
- **건드린 심볼**:
  - `LogCaptureHandler`에 **신규 메서드 `clear()`** 추가 — `self.records.clear()`(in-place) + `self.stream = StringIO()`.
  - `LogCaptureFixture.clear()`의 본문을 `self.handler.reset()` → `self.handler.clear()`로 교체.
- **근본원인**: setup 단계에서 `item.stash[caplog_records_key][when] = caplog_handler.records`로 stash가 핸들러의 records 리스트와 **동일 객체**를 가리킨다. 그런데 사용자-facing `clear()`가 호출하던 `reset()`은 `self.records = []`로 **새 리스트를 재바인딩**해, stash 쪽 별칭이 옛 리스트를 계속 가리키며 분기된다.
- **수정요지**: 별칭을 깨는 재바인딩 대신 `list.clear()`로 **동일 객체를 in-place로 비운다**. 이러면 stash가 가리키는 리스트와 핸들러의 records가 계속 같은 객체이므로, `get_records()`가 클리어/신규 레코드를 정상 반영한다. 기존 `reset()`은 그대로 두어 내부 호출자(`caplog_handler.reset()` at setup)의 "새 단계마다 깨끗한 리스트로 시작" 의미를 보존.

## 검증 (test_patch)

- **FAIL_TO_PASS (1)**: `testing/logging/test_fixture.py::test_clear_for_call_stage`. call 단계 로그 1건 캡처 → `caplog.clear()` → (1) `get_records("call") == []`(클리어 반영), (2) `get_records("setup")`은 보존, (3) `caplog._item.stash[caplog_records_key]`의 키셋이 여전히 `{"setup","call"}`(stash 별칭 무손상), (4) 클리어 후 신규 로그가 `get_records("call")`에 다시 잡힘.
- **픽스 증명**: in-place `clear()`라 stash가 가리키는 리스트 정체성이 유지되므로 (1)(3)(4)가 동시에 만족. 만약 여전히 `reset()`(재바인딩)이었다면 stash 별칭이 옛 리스트를 가리켜 (1)은 옛 레코드로, (4)는 새 레코드 미반영으로 깨진다.
- **overfit 관점**: 테스트가 "클리어 반영 + 타 단계 보존 + 신규 캡처 재개"의 세 측면을 모두 검사하므로 special-case 통과 여지가 작다. overfit 위험 낮음.
- **regression 관점**: PASS_TO_PASS에 `test_clear`(기존 단순 클리어), `test_caplog_captures_for_all_stages`, `test_change_level*` 등 15개. `reset()`을 그대로 두고 사용자 경로만 `clear()`로 돌렸기에 setup 시점의 깨끗한-리스트 의미와 단계별 캡처가 안 깨진다. **regression-trap** 표기.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 두 줄(`#L699` stash 별칭 배선, `#L345` `reset()`의 리스트 교체)을 직접 준다. `LogCaptureFixture.clear → self.handler.reset`와 setup의 `item.stash[...][when] = caplog_handler.records` 두 지점을 읽고, "같은 리스트를 별칭으로 잡아두는데 한쪽이 재바인딩한다"는 분기 지점을 확정.
2. **픽스**: `reset()`의 `self.records = []`를 in-place `self.records.clear()`로 바꾸는 게 본질. 이게 올바른 일반화인 이유 — 버그의 근원이 "객체 정체성 파괴"이고, in-place 클리어는 정체성을 보존하면서 의도(레코드 비움)를 그대로 달성하므로 모든 별칭 보유자에게 일관되게 반영된다. 특정 단계/특정 입력에 한정되지 않음.
3. **regression 안전**: `test_clear`/`test_caplog_captures_for_all_stages` 등을 안 깨야 한다. 그래서 내부 `reset()`을 직접 변이로 바꿔 setup 호출자까지 의미를 흔드는 대신, **신규 `clear()`를 추가하고 사용자 경로(`LogCaptureFixture.clear`)만 그쪽으로 라우팅**하는 게 안전. setup의 `caplog_handler.reset()`은 매 단계 새 리스트를 원하는 정당한 케이스라 보존.
4. **함정 회피**: (a) `reset()` 자체를 in-place로 고쳐버리면 한 줄로 통과는 하나, setup이 새 단계마다 "신선한 리스트"를 stash에 새로 바인딩하는 의미와 충돌할 위험을 검토해야 한다 — 골드는 분리(`clear` 신설)로 그 위험을 회피. (b) `LogCaptureFixture`에서 `self.handler.records.clear()`를 직접 호출하면 `self.stream` 리셋을 빠뜨려 캡처 텍스트가 안 비워지는 미완 픽스가 된다 — 두 상태(records + stream)를 함께 비우는 메서드로 캡슐화해야 함. (c) overfit 유혹: FAIL_TO_PASS의 `when="call"`만 보고 call 전용 처리를 넣지 말 것 — 근본은 단계 무관한 별칭 보존이다.
