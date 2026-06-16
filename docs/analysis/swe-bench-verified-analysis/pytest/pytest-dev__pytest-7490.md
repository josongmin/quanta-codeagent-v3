---
instance_id: pytest-dev__pytest-7490
repo: pytest-dev/pytest
base_commit: 7f7a36478abe7dd1fa993b115d22606aa0e35e88
version: "6.0"
difficulty: "15 min - 1 hour"
created_at: 2020-07-13T22:20:10Z
fail_to_pass: 2
pass_to_pass: 78
gold_files: [src/_pytest/skipping.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

## 문제 요약

pytest 5.x에서는 테스트 함수 안에서 `request.node.add_marker(pytest.mark.xfail(...))`로 xfail 마커를 **동적으로** 추가하면 그 테스트의 실패가 xfailed로 처리됐다. 6.0.0rc0부터 이 동작이 회귀하여 그냥 실패(F)로 보고된다. 이슈는 xfail 평가 로직을 리팩터링한 커밋 `c9737ae`가 원인일 것이라고 정확히 지목한다(개발자가 직접 회귀 커밋을 명시).

## 유형 (정형화)

- **L1 (Traceable)** — 이슈가 회귀 커밋(`c9737ae`)과 증상(xfail 무시 안 됨)을 직접 지목. `src/_pytest/skipping.py`의 xfail 평가 훅으로 grep 수렴은 빠르나, "왜 안 잡히나"는 setup/call/makereport 3-훅의 store 타이밍을 따라가야 함 → L0는 아님.
- **S2 (Constraint-Reasoning) + S6** — 고칠 파일은 자명하지만, "마커가 테스트 본문 실행 중에 추가된다 → `makereport`가 store를 읽는 시점에는 평가가 끝나 있어야 한다"는 **시점 불변식**을 추론해야 한다. 픽스는 한 줄 가드 변경이 아니라 `pytest_runtest_call`의 `yield` **이후**에 재평가 블록을 새로 배치하는 소규모 lifecycle 재구성이라 S6 보조.
- **K-Domain** — pytest 훅 실행 순서(setup→call hookwrapper→makereport), `item._store[xfailed_key]` 캐싱 의미, `runxfail` 옵션 의미를 알아야 함. 일반 파이썬 추론만으로는 못 품.
- **primary = T-ConstraintReason**: 위치는 좁혀지지만 진짜 난점은 "store에 언제 재평가 결과를 써야 makereport가 보는가"라는 조건/시점 합성이다.

APR 관점: 실패 테스트가 픽스를 과소명세하지 않고(동적 add_marker라는 명확한 케이스), 후보 패치를 마구 던져 통과시키는 게 아니라 훅 lifecycle 불변식을 따져 풀어야 하므로 G&V/CEGIS가 아니라 semantic constraint reasoning이다.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개(`skipping.py`), 헌크 2개, 순변경 ~6줄 → scope는 작음(T2~T3급).
- 그러나 localize 직접성은 중간(L1): 증상→파일은 쉬우나 3-훅 데이터플로우와 store 타이밍 추론이 실질 병목.
- **has-repro** 강한 신호(이슈에 5.x/6.x 출력 대조 + 최소 재현코드).
- **regression-trap** 강함: PASS_TO_PASS 78개가 전부 skip/xfail/runxfail/strict 동작. `runxfail` 가드 위치를 한 칸 잘못 옮기면 `test_xfail_not_run_xfail_reporting`, `test_strict_xfail*`, `test_dynamic_xfail_no_run` 류가 깨진다.
- K-Domain 의존.

공식 라벨은 "15분~1시간"으로 T2~T3에 가깝지만, 도메인 lifecycle 추론 + 넓은 P2P trap(한 칸만 잘못 옮겨도 인접 동작 다수 회귀)이 시간라벨에 안 잡히는 난이도를 더해 **T4로 상향**한다.

## 골드패치 분석

- **파일/함수**: `src/_pytest/skipping.py`의 `pytest_runtest_setup`, `pytest_runtest_call`.
- **근본원인**: 회귀 커밋이 xfail 평가를 setup/call 시점에 캐싱(`item._store[xfailed_key]`)하도록 바꾸면서, 평가가 항상 **테스트 본문 실행 전**에만 일어났다. 테스트 본문에서 `add_marker(xfail)`로 동적 추가하면, `pytest_runtest_makereport`가 `xfailed_key`를 읽을 때 그 마커가 반영되지 않아(평가 시점엔 마커가 없었음) 그냥 실패로 보고됐다.
- **수정요지**:
  1. `pytest_runtest_setup`에서 `runxfail` 가드와 무관하게 항상 `xfailed_key`를 저장하도록 풀어내고, `skipped_by_mark_key`도 `skipped is not None`으로 단순화.
  2. **핵심**: `pytest_runtest_call`의 `yield`(=실제 테스트 본문 실행) **직후**에 재평가 블록을 추가 — `xfailed_key`가 None이면 `evaluate_xfail_marks(item)`로 다시 평가해 store에 기록. 이로써 본문에서 동적으로 추가된 xfail 마커가 makereport 전에 store에 반영된다.

## 검증 (test_patch)

FAIL_TO_PASS 2개:
- `test_dynamic_xfail_set_during_runtest_failed` — 본문에서 `add_marker(xfail)` 후 `assert 0` → `assert_outcomes(xfailed=1)`. 동적 xfail이 실패를 흡수해야 함을 직접 검증.
- `test_dynamic_xfail_set_during_runtest_passed_strict` — `add_marker(xfail(strict=True))` 후 통과(xpass) → `assert_outcomes(failed=1)`. strict xfail이 예상외 통과를 실패로 보고하는 경로까지 커버.

픽스 증명: 두 테스트 모두 "본문 실행 중 마커 추가 → makereport가 재평가된 store를 읽음" 경로를 강제한다. yield 이후 재평가가 없으면 첫 테스트는 `failed=1`, 둘째는 `passed=1`로 빠져 둘 다 RED.

overfit·regression: failed/strict-passed 2갈래를 모두 잡아 special-case 통과 회피(overfit 낮음). PASS_TO_PASS 78개가 정적 xfail/skip/runxfail/strict 전 스펙트럼을 덮어, 가드 위치를 잘못 옮긴 회귀를 즉시 적발한다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 회귀 커밋 `c9737ae` + "동적 add_marker xfail 무시 안 됨" → `skipping.py`의 xfail 훅 3종(setup/call/makereport). `xfailed_key` store 흐름을 추적해, makereport가 읽는 값이 **본문 실행 전에 고정**된다는 게 버그임을 확인.
2. **픽스**: `pytest_runtest_call`의 `yield` 뒤에 "test run may have added an xfail mark dynamically" 재평가를 삽입. 이것이 overfit이 아닌 이유 — store가 None일 때만 재평가하므로 기존 정적 평가 결과를 덮지 않고, 동적 추가라는 일반 케이스(failed/strict-passed 모두)를 lifecycle 시점 교정으로 푼다.
3. **regression 안전**: `runxfail` 가드를 `xfail("[NOTRUN]...")` 발동 조건 안으로만 합치고(가드를 store 저장에서 분리), setup/call의 store 기록은 항상 일어나게 함. 이로써 `test_xfail_not_run_*`, `test_strict_xfail*`, `test_dynamic_xfail_no_run` 등 P2P 동작이 보존된다.
4. **함정 회피**: 흔한 오답은 (a) `runxfail` 가드를 store 저장까지 감싼 채로 두어 동적 케이스를 못 잡거나, (b) yield 전에만 재평가를 추가해 본문에서 추가된 마커를 여전히 놓치는 것. 핵심은 재평가를 **본문 실행 후(yield 뒤)** 에 둬야 makereport가 본다는 시점 불변식이다. strict xfass 경로까지 통과시키려면 재평가가 strict 플래그를 보존하는 `evaluate_xfail_marks` 재호출이어야 함.
