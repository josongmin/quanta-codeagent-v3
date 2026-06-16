---
instance_id: pytest-dev__pytest-7432
repo: pytest-dev/pytest
base_commit: e6e300e729dd33956e5448d8be9a0b1540b4e53a
version: "5.4"
difficulty: "<15 min fix"
created_at: 2020-06-29T21:51:15Z
fail_to_pass: 1
pass_to_pass: 77
gold_files: [src/_pytest/skipping.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`@pytest.mark.skip`/`skipif`로 스킵된 테스트는 `pytest -rs` 출력에서 스킵 위치를 테스트 정의 자체(`test_it.py:3`)로 보고해야 한다. 그런데 `--runxfail`을 함께 주면 위치가 pytest 내부 파일(`src/_pytest/skipping.py:238`)로 잘못 보고된다. `--runxfail`은 xfail 처리만 끄는 옵션이므로 mark.skip 위치 보고에 영향을 줘선 안 된다. 이슈는 버그가 `src/_pytest/skipping.py`의 `pytest_runtest_makereport` 훅에 있다고 직접 지목한다.

## 유형 (정형화)

- **L (Localization) = L0**: 이슈 본문이 파일(`skipping.py`)과 함수(`pytest_runtest_makereport`)를 명시적으로 지목한다. grep 한 방으로 도달. 게다가 잘못된 출력 `skipping.py:238`이 정확히 그 줄을 가리킨다.
- **S (Repair Strategy) = S2 (+S6)**: 고칠 지점은 알지만 올바른 제어흐름을 추론으로 합성해야 한다. `--runxfail`이 켜졌을 때 위 분기에서 `pass`로 빠지면서 `elif` 체인이 단락되어 skip-location 보정이 실행 안 되는 게 근본 원인. 픽스는 그 보정 블록을 체인에서 떼어내 독립 `if`로 만드는 작은 제어흐름 재구조화(S6)라 보조로 단다. 후보를 던져보는 G&V가 아니라 "어느 조건이 어느 조건과 직교해야 하나"를 따지는 불변식 추론이라 S2가 dominant.
- **K (Knowledge) = K-Domain**: pytest의 hookwrapper 리포트 파이프라인, `runxfail` 옵션 시맨틱, `skipped_by_mark_key`/`reportinfo()` 같은 내부 계약을 알아야 한다. 일반 파이썬 추론만으로는 두 관심사가 왜 분리돼야 하는지 못 짚는다.
- **Primary = T-ConstraintReason**: 위치는 자명(L0)하나 픽스가 "xfail 분기와 skip-location 보정은 직교한다"는 불변식을 추론해 제어흐름을 바로잡는 데 있다. 기계적 가드 추가(T-DirectMap)가 아니다.

## 난이도 티어

**Tier = T3 (중간)**. 구조적 피처:
- 파일 1개, 실질 수정 약 2줄(`elif` → 빈 줄 + `if`)로 scope는 최소.
- localize는 L0로 자명, `has-repro`(재현 코드 + 잘못된 출력 둘 다 제공)라 easiness 신호가 강하다.
- 그럼에도 T1/T2가 아닌 이유: 픽스가 "체크 추가"가 아니라 **두 관심사를 분리하는 제어흐름 추론**이다. 단순히 `pass`를 지운다든가 조건을 추가하면 xfail 동작을 깨뜨린다. `elif`를 `if`로 바꾼다는 정확한 통찰과, 그래도 78개 P2P(대부분 xfail/skip 동작)를 안 깨야 한다는 `regression-trap`이 결합돼 T3로 민다.
- 공식 라벨은 `<15 min fix`(T1~T2 prior). 개발자 구현시간으론 맞지만, 에이전트 관점에선 "elif 체인 단락"이라는 비자명한 인과를 짚어야 하고 잘못된 패치가 인접 xfail 동작을 깨기 쉬워 한 단계 올린다.

## 골드패치 분석

- **파일·함수**: `src/_pytest/skipping.py`의 `pytest_runtest_makereport(item, call)` 훅.
- **근본원인**: 이 훅은 `elif` 체인이다. 체인 상단에 `elif item.config.option.runxfail: pass  # don't interfere`가 있다. `--runxfail`이 켜지면 이 분기가 매칭되어 `pass`로 빠지고, 체인의 나머지 `elif`들(특히 마지막 mark.skip 위치 보정 블록)은 절대 평가되지 않는다. 그래서 보정이 안 되고 `rep.longrepr`이 예외가 발생한 pytest 내부 위치(`skipping.py:238`)를 그대로 노출한다.
- **수정요지**: mark.skip 위치 보정 블록을 시작하는 `elif (`를 체인에서 분리해 독립 `if (`로 만든다. 즉 `skipped_by_mark_key`/`rep.skipped`/`type(rep.longrepr) is tuple` 조건은 이제 `runxfail` 분기와 무관하게 항상 평가된다. 블록 본문(`item.reportinfo()`로 filename/line을 얻어 `rep.longrepr = str(filename), line + 1, reason`)은 그대로다. xfail 관심사와 skip-location 관심사를 직교화한 것이 핵심.

## 검증 (test_patch)

- **FAIL_TO_PASS** (1개): `TestXFail::test_xfail_run_with_skip_mark[test_input1-expected1]`. 파라미터화로 `[-rs]`(test_input0, 기존 통과)와 `[-rs, --runxfail]`(test_input1, 새 케이스) 두 변형을 돌린다. `@pytest.mark.skip` 테스트를 만들고 둘 다 `"SKIPPED [1] test_sample.py:2: unconditional skip"`을 기대한다. 픽스 전엔 `--runxfail` 변형이 `skipping.py:NNN`을 출력해 실패하고, 픽스 후엔 두 변형 모두 테스트 파일 위치를 보고한다.
- **픽스 증명**: 분리된 `if`가 `runxfail` 여부와 독립적으로 보정을 실행하므로 두 입력이 동일 위치를 낸다. test_input0이 `PASS_TO_PASS`(test_input0-expected0)에 있어 픽스가 비-runxfail 경로를 깨지 않았음도 함께 증명된다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇아 보이나 parametrize로 runxfail on/off를 짝지어 검증해 special-case 통과를 막는다. `elif`→`if` 외의 꼼수(예: runxfail 분기 안에서 위치 보정 복붙)는 78개 P2P의 xfail 동작을 깨므로 살아남기 어렵다. overfit-risk는 낮다고 본다.
- **regression 관점**: P2P 78개가 사실상 `test_skipping.py` 전체(xfail strict/raises/dynamic, skip/skipif reporting 등)다. `regression-trap`이 실재한다 — 잘못 고치면 `--runxfail` 시 xfail이 다시 보고되는 등 인접 동작이 깨진다. 골드패치는 보정 블록만 떼어내 xfail 처리 경로는 손대지 않아 안전.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 `skipping.py`의 `pytest_runtest_makereport`를 직접 지목하고, 잘못된 출력 `skipping.py:238`이 바로 위치 보정 블록(`rep.longrepr = str(filename), line + 1, reason`) 근처를 가리킨다. 훅을 열어 `elif`로 이어진 분기 체인 구조를 확인한다.
2. **픽스**: 체인 상단 `elif item.config.option.runxfail: pass`가 켜지면 하단 mark.skip 보정 `elif`가 단락된다는 인과를 짚는다. 보정 블록의 `elif`를 독립 `if`로 승격해 두 관심사를 직교화한다. 이게 올바른 일반화인 이유: skip-location 보정의 가드(`skipped_by_mark_key and rep.skipped and longrepr is tuple`)는 이미 자기 조건으로 정확히 mark.skip 케이스만 잡으므로, runxfail 분기와 묶일 이유가 애초에 없었다. 특정 출력 문자열을 패치하는 게 아니라 제어흐름 결함 자체를 제거한다.
3. **regression 안전**: `--runxfail`의 실제 목적(xfail을 일반 실행으로 돌림)을 담은 위쪽 `elif ... pass`와 그 아래 xfail 처리 분기들은 건드리지 않는다. P2P의 xfail strict/raises/dynamic 및 비-runxfail skip reporting(test_input0)이 그대로 통과해야 하고, 보정 블록만 분리하면 모두 보존된다.
4. **함정 회피**: 오라클 없는 에이전트의 흔한 오답은 (a) `elif runxfail: pass`를 지우거나 조건을 바꿔 xfail 동작을 깨는 것, (b) runxfail 분기 안에 위치 보정을 복붙해 중복/시맨틱 누수를 만드는 것. 정답은 "두 관심사가 직교하므로 보정을 체인에서 빼낸다"는 최소 구조 변경. parametrize된 on/off 짝 테스트로 두 경로가 동일 위치를 내는지 확인하면 overfit과 regression을 동시에 방어한다.
