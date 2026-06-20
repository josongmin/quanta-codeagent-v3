---
instance_id: pytest-dev__pytest-5787
repo: pytest-dev/pytest
base_commit: 955e54221008aba577ecbaefa15679f6777d3bf8
version: "5.1"
difficulty: 1-4 hours
created_at: 2019-08-26T16:43:31Z
fail_to_pass: 2
pass_to_pass: 123
gold_files: [src/_pytest/reports.py]
primary_type: T-SpecInference
tier: T4
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 로컬 quanta receipt (2026-06-20)

- **PASS receipt**: durable sidecar `/Users/songmin/Library/quanta-codeagent-v3/bench/full-remote/report-i-0015118a58d76af3e.json`.
- **run**: `agentless-v1`, `gpt-5.5`, official swebench harness, 59 turns, 7755B patch.
- **patch**: `src/_pytest/reports.py` 단일 파일, `ExceptionChainRepr` import 및 chain serialization/deserialization 구현. Gold 9824B보다 작지만 official grader PASS.
- **해석**: 기존 gpt-5.4 miss는 multi-surface feature-generation 실패모드로 남긴다. 현재 상태는 active unresolved/model ceiling이 아니라 **capability/variance가 있는 complex-generation case**다.

## 문제 요약

`xdist`(`-n auto`) 환경에서 테스트가 chained exception(`raise ... from ...` 또는 암묵적 context chaining)으로 실패하면, 워커가 마스터로 직렬화해 보낸 리포트가 마지막 예외 하나만 표시한다. xdist 없이 직접 실행하면 "The above exception was the direct cause..." / "During handling..." 체인이 온전히 출력되는데 직렬화 경로에서 체인이 유실되는 것. 근본 원인은 pytest의 리포트 longrepr 직렬화기(`TestReport._to_json` / `_from_json`)가 단일 `ReprExceptionInfo`(reprtraceback+reprcrash)만 다루고 `ExceptionChainRepr.chain`을 통째로 누락하기 때문이다.

## 유형 (정형화)

- **L (Localization) = L1**: 이슈에 직접 심볼 포인터는 없지만("exception serialization", xdist), 키워드 "serialization"+"chained exceptions"가 `src/_pytest/reports.py`의 `_to_json`/`_from_json`으로 좁게 수렴한다. 단일 파일·단일 책임. grep 한두 방.
- **S (Repair Strategy) = S5 (+S6)**: 올바른 직렬화 동작은 코드만으로 결정되지 않는다 — "체인의 각 항목(reprtraceback, reprcrash, description)을 round-trip 보존하라"는 스펙을 이슈와 `ExceptionChainRepr.chain` 자료구조에서 재구성해야 함(S5). 그리고 단순 한 줄이 아니라 nested 헬퍼를 추출하고(`serialize_repr_*`/`deserialize_repr_*`) chain 분기를 도입하는 소규모 구조 변경(S6)이 동반된다.
- **K (Knowledge) = K-Domain**: `ExceptionChainRepr` vs `ReprExceptionInfo`의 차이, `chain`이 `(ReprTraceback, ReprFileLocation, description)` 튜플 리스트라는 점, `addsection`/`reprentries` 직렬화 규약 등 pytest 내부 repr 모델 지식이 병목.
- **primary = T-SpecInference**: 진짜 난점은 "어디"가 아니라 "직렬화가 chain까지 round-trip해야 한다"는 누락된 스펙을 추론·구현하는 것이라 S5가 dominant.

APR 관점: 실패 테스트가 픽스를 명세하지 않고(이슈는 증상만 기술), 정확한 round-trip 불변식을 자료구조 계약에서 복원해야 하므로 template(S1)/generate-validate(S3)보다 spec-inference가 맞다.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처:
- 파일 수 = 1 (gold patch는 `src/_pytest/reports.py` 단독) → 컷 기준상 쉬운 쪽.
- 줄 수는 큼: 기존 inline 로직을 모듈 레벨 `_report_to_json`/`_report_kwargs_from_json`로 추출하면서 ~140줄 추가. 단순 가드 추가가 아닌 refactor+신규 chain 분기.
- localize 직접성: L1로 양호, repro 존재(has-repro)로 easiness 신호.
- 도메인: pytest repr 내부 모델(`ExceptionChainRepr.chain`) 이해 필요(K-Domain).
- P2P trap: 123개 — `test_reprentries_serialization_*`, `test_xdist_*`, 다수 `toterminal` 테스트가 직렬화·repr 동작을 광범위하게 묶고 있어 round-trip을 재작성하면서 기존 비-체인 경로를 깨지 말아야 한다(regression-trap).

공식 라벨 "1-4 hours"와 일치(T4). localize는 쉬우나 올바른 직렬화 스펙 합성 + 넓은 P2P가 티어를 T2/T3에서 T4로 끌어올린다.

## 골드패치 분석

- **건드린 파일**: `src/_pytest/reports.py` (단독).
- **건드린 심볼**: `BaseReport._to_json`/`_from_json`를 얇은 위임으로 축소하고, 모듈 함수 `_report_to_json`(내부 `serialize_repr_entry`/`serialize_repr_traceback`/`serialize_repr_crash`/`serialize_longrepr`)와 `_report_kwargs_from_json`(내부 `deserialize_repr_entry`/`deserialize_repr_traceback`/`deserialize_repr_crash`) 신설. 상단에 `from _pytest._code.code import ExceptionChainRepr` 추가.
- **근본 원인**: 기존 `disassembled_report`는 longrepr을 `reprcrash`/`reprtraceback`/`sections`로만 평탄화해 `ExceptionChainRepr.chain`(상위/하위 예외들의 traceback 리스트)을 직렬화에서 통째로 떨어뜨렸다. 역직렬화도 항상 `ReprExceptionInfo`로만 재조립했다. 그래서 xdist round-trip 후 체인 항목이 사라지고 crash entry 하나만 남았다.
- **수정 요지**: 직렬화 시 `isinstance(rep.longrepr, ExceptionChainRepr)`이면 `result["chain"]`에 각 `(repr_traceback, repr_crash, description)`을 traceback/crash 헬퍼로 직렬화해 담고, 아니면 `chain=None`. 역직렬화 시 `reportdict["longrepr"]["chain"]`이 있으면 헬퍼로 복원해 `ExceptionChainRepr(chain)`을 재구성하고, 없으면 종전대로 `ReprExceptionInfo(reprtraceback, reprcrash)`. round-trip 동안 `addsection`으로 sections도 복원.

## 검증 (test_patch)

- **FAIL_TO_PASS (2)**: `test_chained_exceptions[TestReport]`, `test_chained_exceptions[CollectReport]`. chained exception을 일으키는 모듈을 `inline_run`해 call/collect 리포트를 얻고, `longrepr`이 `ExceptionChainRepr`이며 `len(longrepr.chain) == 2`, 두 항목의 `tb`/`description`이 정확함을 검증. 핵심: `report._to_json()` → `report_class._from_json(data)` round-trip 후에도 `check_longrepr`가 동일하게 통과하고, 마지막에 `loaded_report.longrepr.toterminal(tw_mock)`이 터지지 않음을 확인.
- **픽스 증명**: 기존 코드는 round-trip 후 `chain`이 없어 `ExceptionChainRepr` 복원이 불가능 → 단언 실패. 패치는 chain을 보존·복원하므로 통과. `TestReport`(call)와 `CollectReport`(import-time error) 둘 다 파라미터화해 양쪽 리포트 타입에서 동작 보장.
- **overfit 관점**: F2P=2지만 special-case로 통과 불가 — round-trip 동등성 + 체인 길이 2 + 양 리포트 타입을 동시에 요구하므로 chain을 진짜로 직렬화/역직렬화해야만 한다. 하드코딩 우회는 막혀 있음. test_patch는 부수적으로 모든 `TWMock`을 `conftest.py`의 `tw_mock` fixture로 통합(테스트 인프라 리팩터), 픽스 자체의 일반성에는 영향 없음.
- **regression 관점**: 비-체인 경로는 직렬화 dict가 byte 동치는 **아니다** — `serialize_longrepr`의 else 분기가 `result["chain"] = None`을 무조건 추가하므로, 기존 `disassembled_report`(reprcrash/reprtraceback/sections만 반환)와 달리 모든 비-체인 longrepr에 `"chain": None` 키가 새로 붙는다. 보존되는 것은 round-trip **동작**(역직렬화 시 동일한 reprtraceback/reprcrash/sections를 가진 `ReprExceptionInfo`로 복원)이지 직렬화 바이트가 아니다. 123개 P2P(특히 `test_reprentries_serialization_*`, `test_xdist_*`, `test_extended_report_deserialization`)가 통과하는 이유도 이들이 재구성된 개별 속성/round-trip 동등성을 단언할 뿐 직렬화 dict 전체 동일성(`data == expected_dict`)을 검사하지 않기 때문이다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "exception serialization" + "xdist에서만 마지막 것만 표시" → xdist는 워커→마스터로 리포트를 JSON 직렬화해 보낸다는 도메인 사실에서 `src/_pytest/reports.py`의 `_to_json`/`_from_json`(원래 `disassembled_report`)로 직행. chained 예외는 `_pytest._code.code.ExceptionChainRepr`로 표현됨을 grep으로 확인.
2. **픽스(올바른 일반화)**: 직렬화기가 단일 traceback/crash만 인코딩하는 게 root cause. `ExceptionChainRepr`이면 `chain` 리스트의 각 `(traceback, crash, description)`을 인코딩하고 역직렬화에서 `ExceptionChainRepr(chain)`로 복원. 특정 예외값(11/12/13)이 아니라 chain 구조 자체를 round-trip하므로 임의 깊이·임의 메시지의 체인에 일반화됨 → overfit 아님.
3. **regression 안전**: 비-체인 longrepr은 역직렬화 시 종전 `ReprExceptionInfo` 경로로 복원되어 round-trip **동작**이 보존된다. 단, 직렬화 dict는 byte 동치가 아니다 — else 분기가 `result["chain"] = None`을 추가하므로 종전 대비 `"chain": None` 키가 더 붙는다. `reprentries`/`sections`/`reprfuncargs` 등 기존 직렬화 필드 계약은 그대로 두므로 `test_reprentries_serialization_*`, `test_xdist_*` 등 123 P2P가 보존되는데, 이는 해당 테스트들이 재구성 속성/round-trip 동등성을 단언할 뿐 직렬화 dict 전체 동일성을 검사하지 않기 때문이다.
4. **함정 회피**: (a) chain의 traceback/crash가 reprentries 직렬화 규약을 그대로 따른다는 점을 놓치고 chain만 얕게 str화하면 round-trip이 깨진다 — 기존 `serialize_repr_traceback` 헬퍼를 chain 항목에도 재사용해야 함. (b) `addsection`으로 sections 복원을 빠뜨리면 `longrepr.sections` 단언 실패. (c) `_from_json`에서 chain 분기와 단일 분기를 모두 `addsection` 후 같은 경로로 합류시켜야 양 리포트 타입에서 일관. (d) `toterminal`가 복원된 객체에서 동작해야 하므로 부분 복원(예: description 누락)은 금물.
