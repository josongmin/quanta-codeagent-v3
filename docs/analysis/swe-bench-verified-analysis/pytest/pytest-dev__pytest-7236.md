---
instance_id: pytest-dev__pytest-7236
repo: pytest-dev/pytest
base_commit: c98bc4cd3d687fe9b392d8eecd905627191d4f06
version: "5.4"
difficulty: "15 min - 1 hour"
created_at: 2020-05-21T19:53:14Z
fail_to_pass: 1
pass_to_pass: 51
gold_files: [src/_pytest/unittest.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`unittest.TestCase`에서 `@unittest.skip`으로 스킵된 테스트가 `--pdb` 옵션과 함께 실행되면 `tearDown()`이 잘못 호출되어 에러가 난다(스킵된 테스트인데도 `setUp`/`tearDown`이 동작). `--pdb` 없이 돌리면 정상적으로 스킵된다. 이슈 제보자는 5.4.1→5.4.2 사이의 회귀이며 PR #7151(pdb·skip·teardown 변경)이 원인일 것으로 지목한다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈 본문이 `--pdb`, `tearDown`, `unittest.skip` 키워드 + 회귀 PR #7151을 직접 지목 → 단일 파일 `src/_pytest/unittest.py`로 빠르게 수렴. 하지만 "정확히 어느 분기"인지는 코드 독해가 약간 필요해 L0는 아님.
- **S2 (Constraint-Reasoning)**: 고칠 지점(`runtest`의 `usepdb` 분기)을 찾은 뒤, "스킵된 테스트는 tearDown 연기를 하면 안 된다"는 **불변식**을 추론해 조건을 `usepdb and not _is_skipped(self.obj)`로 합성해야 한다. 후보를 마구 던져보는 G&V가 아니라 의미적 조건 추론이 핵심.
- **K-Domain (Domain-bound)**: pytest의 unittest 통합 내부 — `--pdb`일 때 tearDown을 명시적으로 연기(`_explicit_tearDown`)하는 메커니즘과 `__unittest_skip__` 마커 규약을 알아야 한다. 일반 파이썬 추론만으로는 안 됨.

primary type = **T-ConstraintReason**: 위치는 명확하나 올바른 가드 조건(`not _is_skipped`)을 불변식으로 추론·합성하는 게 본질. APR 관점에서 SemFix식 조건 정련이라 S2가 dominant.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일 1개(`src/_pytest/unittest.py`), 실질 변경은 3개 헌크 + 헬퍼 1개 추가로 ~10줄 — 작음.
- localize 직접성: 회귀 PR 지목 + has-repro로 매우 높음. 하지만 단순 None-가드 추가가 아니라 "스킵 판정"을 일관되게 재사용하는 의미 변경이 들어가 S1보다 추론 부담이 있음.
- regression-trap: PASS_TO_PASS 53개(unittest 통합 전반 + `test_pdb_teardown_called` 등 인접 동작)를 안 깨야 함 → T2보다 위로 미는 요인.
- 도메인 지식(K-Domain)이 필요하지만 깊은 call-chain은 아님.

공식 라벨 "15 min - 1 hour"와 정합. has-repro·소규모라 T2로 내릴 수도 있으나, 넓은 P2P trap + 의미적 조건 합성 때문에 T3로 둔다.

## 골드패치 분석

건드린 파일/함수: `src/_pytest/unittest.py`
- 신규 헬퍼 `_is_skipped(obj)`: `bool(getattr(obj, "__unittest_skip__", False))` — 스킵 판정 로직을 단일 SSOT로 추출.
- `UnitTestCase.collect`: `skipped = getattr(cls, "__unittest_skip__", False)` → `skipped = _is_skipped(cls)`로 교체.
- `_make_xunit_fixture`의 내부 `fixture`: `if getattr(self, "__unittest_skip__", None)` → `if _is_skipped(self)`로 교체.
- `TestCaseFunction.runtest`: `if self.config.getoption("usepdb"):` → `if self.config.getoption("usepdb") and not _is_skipped(self.obj):`.

근본원인: PR #7151이 `--pdb`일 때 tearDown을 즉시 호출하지 않고 `self._explicit_tearDown`으로 연기하도록 바꿨는데, 이 분기가 **스킵 여부를 보지 않았다**. 스킵된 unittest 테스트는 unittest 런너가 tearDown을 건너뛰지만, pytest가 연기 트릭으로 `tearDown`을 인터셉트해 두면 나중에 실행돼 버린다. 수정요지: pdb 연기 분기에 `not _is_skipped(self.obj)` 가드를 추가하고, 흩어진 스킵 판정을 `_is_skipped`로 통일.

## 검증 (test_patch)

FAIL_TO_PASS = `test_pdb_teardown_skipped[@unittest.skip]` 1개. `monkeypatch`로 `pytest.test_pdb_teardown_skipped` 리스트를 심고, `setUp`/`tearDown`이 호출되면 `"setUp:..."`/`"tearDown:..."`를 append하는 `MyTestCase`를 `{mark}("skipped")`로 스킵한 뒤 `--pdb`로 실행. 기대: `* 1 skipped in *` 출력 + `assert tracked == []`(즉 setUp/tearDown 미호출). 픽스 전에는 연기된 tearDown이 돌아 tracked가 비지 않거나 에러가 났다.

overfit 관점: 테스트가 `@unittest.skip`과 `@pytest.mark.skip` 두 마크로 parametrize 되어 있고(`@pytest.mark.skip` 버전은 P2P에 존재), 골드는 `_is_skipped`로 `__unittest_skip__` 마커를 일반적으로 판정하므로 특정 입력에 special-case하지 않음 → overfit 위험 낮음.

regression 관점: `collect`/`fixture`의 기존 동작은 `_is_skipped`가 동일 의미(`__unittest_skip__` 기반)라 byte-equivalent하게 보존. `test_pdb_teardown_called`(스킵 안 된 경우 연기가 여전히 동작) 등 53개 P2P가 가드를 깨지 않음을 보증.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 "5.4.1→5.4.2 회귀 + PR #7151(pdb/skip/teardown)"을 직접 명시 → `git log`/blame으로 `src/_pytest/unittest.py`의 `runtest`에서 `usepdb` 분기 + `_explicit_tearDown` 연기 코드를 짚는다. has-repro라 스킵 테스트 + `--pdb` 케이스로 곧장 재현.
2. **픽스**: 연기 분기에 `not _is_skipped(self.obj)`를 AND로 추가. 올바른 일반화인 이유 — 근본 불변식은 "스킵된 테스트는 setUp/tearDown을 실행하지 않는다"이며, pdb 연기는 그 불변식의 예외가 되어선 안 된다. 마커(`__unittest_skip__`)로 판정하므로 `@unittest.skip` 데코레이터가 붙은 모든 케이스에 일반적으로 적용됨.
3. **regression 안전**: `collect`/`fixture`의 기존 스킵 판정을 `_is_skipped`로 바꾼 건 의미 동일(default를 `None`→`False`로 정규화해도 `if`/`not`에서 동치)이라 `test_unittest_skip_*`·`test_setup_inheritance_skipping`·`test_pdb_teardown_called`를 안 깬다. 스킵 안 된 테스트의 pdb 연기는 가드가 `not False=True`라 그대로 유지됨.
4. **함정 회피**: 오라클 없는 에이전트의 오답 위험 — (a) `usepdb` 분기 대신 `tearDown` 자체를 건드려 스킵 안 된 경우의 pdb 연기까지 깨뜨림(P2P `test_pdb_teardown_called` 회귀), (b) `self.obj` 대신 클래스(`cls`)나 잘못된 객체에 `_is_skipped`를 적용, (c) `@pytest.mark.skip`도 같이 처리하려다 `__unittest_skip__`이 없는 경로에서 과잉 일반화. 골드는 마커 판정을 헬퍼로 격리하고 pdb 분기에만 가드를 더해 이 함정들을 모두 피한다.
