---
instance_id: pytest-dev__pytest-10081
repo: pytest-dev/pytest
base_commit: da9a2b584eb7a6c7e924b2621ed0ddaeca0a7bea
version: "7.2"
difficulty: "<15 min fix"
created_at: 2022-06-26T13:53:24Z
fail_to_pass: 1
pass_to_pass: 63
gold_files: [src/_pytest/unittest.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`pytest --pdb` 실행 시, `@unittest.skip`이 **클래스 레벨**에 붙은 `unittest.TestCase`의 `tearDown()`이 실행되어 버린다(스킵돼야 하는데도). 정상 실행(`--pdb` 없음)에서는 올바르게 스킵된다. 이미 함수 레벨 스킵에 대해서는 #7215에서 고쳐졌으나, 클래스 레벨 스킵은 동일 결함이 남아 있었다. 재현 코드(`tearDown` 안의 `xxx` NameError)가 이슈에 포함돼 있다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `--pdb` + `tearDown` + `unittest.skip`를 직접 지목. 키워드로 `src/_pytest/unittest.py`의 `TestCaseFunction.runtest`로 좁은 수렴이 가능하고, #7215 참조가 정확히 같은 함수의 `usepdb` 분기를 가리킨다. grep 한두 방.
- **S2 (Constraint-Reasoning)**: 고칠 지점(`if usepdb and not _is_skipped(self.obj)`)은 명확하나, 올바른 조건식을 **추론으로 합성**해야 한다 — "함수가 스킵됐는가"만이 아니라 "**포함 클래스가** 스킵됐는가"까지 OR로 결합해야 함. 단순 가드 추가(S1)가 아니라 skip 판정의 의미 범위를 재정의하는 식 합성이라 S2.
- **K-Domain**: `__unittest_skip__` 속성이 **메서드가 아니라 클래스 객체**에 설정된다는 unittest/pytest collection 내부 지식이 병목. `self.obj`(테스트 메서드) vs `self.parent.obj`(UnitTestCase 클래스 객체)의 구분이 핵심.
- **primary type = T-ConstraintReason**: 위치는 명확하나 픽스가 기계적 None-가드가 아니라 "어느 객체의 skip 플래그를 봐야 하는가"라는 불변식 추론 합성이기 때문.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·실질 4줄·단일 헌크로 scope는 매우 작고(<15min 공식 라벨과 정합), `has-repro`라 easiness 신호가 강하다. 그러나 단순 T1/T2가 아닌 이유는 (1) 픽스가 `self.obj`→`self.parent.obj`라는 **객체 식별 추론**을 요구하고(잘못 보면 메서드 객체에서 영원히 플래그를 못 찾음), (2) 66개의 넓은 `test_unittest.py` P2P가 걸려 있어 skip 판정을 잘못 일반화하면 함수-스킵/비-스킵 teardown 경로를 깰 수 있는 `regression-trap`이 존재하기 때문. localize는 쉽지만 식 합성에 도메인 지식이 필요해 T3로 둔다(공식 시간라벨은 구현시간만 보므로 이 추론 비용을 덜 반영).

## 골드패치 분석
- **파일·함수**: `src/_pytest/unittest.py`의 `TestCaseFunction.runtest()`.
- **근본원인**: `--pdb`일 때 tearDown을 no-op으로 치환할지 결정하는 분기가 `not _is_skipped(self.obj)`만 검사했다. `_is_skipped`는 `getattr(obj, "__unittest_skip__", False)`인데, 이 플래그는 `@unittest.skip`이 **클래스에 붙으면 클래스 객체**에만 설정되고 테스트 메서드(`self.obj`)에는 없다. 따라서 클래스 스킵 케이스에서 분기가 "스킵 아님"으로 잘못 판정 → tearDown 치환이 일어나지 않아 실제 tearDown이 실행됨.
- **수정요지**: `assert isinstance(self.parent, UnitTestCase)`로 부모가 UnitTestCase임을 확정한 뒤, `skipped = _is_skipped(self.obj) or _is_skipped(self.parent.obj)`로 **메서드 스킵 OR 클래스 스킵**을 함께 본다. 분기를 `not skipped`로 교체. 즉 #7215의 함수-레벨 판정에 클래스-레벨 판정을 OR로 보강.

## 검증 (test_patch)
- **FAIL_TO_PASS** (1개): `test_pdb_teardown_skipped_for_classes[@unittest.skip]`. 클래스에 `@unittest.skip`을 붙인 TestCase를 `--pdb`로 돌려 `* 1 skipped in *`와 `tracked == []`(setUp/tearDown 미호출)를 단언 → 픽스 후 `_is_skipped(self.parent.obj)`가 True가 되어 tearDown 치환 경로를 타므로 통과.
- **픽스 증명**: 기존 `test_pdb_teardown_skipped`는 `..._for_functions`로 이름 변경돼 함수-레벨 회귀를 계속 지킨다. 신규 `..._for_classes`가 클래스-레벨 결함을 직접 겨냥.
- **overfit·regression 관점**: `@pytest.mark.skip` 변형(`..._for_classes[@pytest.mark.skip]`)과 함수 변형 2개가 모두 P2P에 포함돼, OR 조건이 양쪽 skip 경로 모두에서 일관되게 동작함을 강제 → special-case overfit 차단. `test_pdb_teardown_called`(비-스킵 시 tearDown이 호출돼야 함)가 P2P에 있어, OR을 잘못 넓혀 모든 teardown을 죽이는 과잉 일반화도 적발된다. FAIL_TO_PASS가 1개로 얇지만 인접 P2P가 경계를 단단히 잡아준다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "Identical to #7215, but class level" + `--pdb`/`tearDown` 키워드 → `src/_pytest/unittest.py`에서 `usepdb` grep → `runtest()`의 `if self.config.getoption("usepdb") and not _is_skipped(self.obj)` 한 줄로 즉시 수렴.
2. **픽스와 일반화 근거**: `_is_skipped`/`__unittest_skip__`이 클래스 객체에 설정됨을 확인 → skip 판정을 메서드 단독에서 **메서드 OR 부모 클래스**로 확장. 부모는 collection 트리상 `UnitTestCase`이므로 `self.parent.obj`가 클래스 객체. 이는 special-case가 아니라 unittest의 skip 의미("클래스 스킵은 모든 메서드 스킵")를 정확히 반영하는 올바른 일반화.
3. **regression 안전**: `test_pdb_teardown_called`(비-스킵 tearDown 정상 호출), `..._for_functions[*]`(함수 스킵 기존 동작), `test_unittest_skip_issue*` 류를 깨지 않아야 한다 — OR는 기존 True 케이스를 보존하고 클래스-스킵 케이스만 추가로 True로 만들기에 안전.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오류는 (a) `self.obj`에서 `__unittest_skip__`를 찾으려다 클래스 플래그를 영영 못 보는 것, (b) `_is_skipped`를 수정해 모든 호출처에 영향을 주는 과잉 변경, (c) `self.parent`가 항상 UnitTestCase라 가정하고 타입 단언 없이 접근하는 것. 골드는 (b)를 피해 호출지점에서만 OR을 추가하고, `assert isinstance(self.parent, UnitTestCase)`로 (c)를 방어한다.
