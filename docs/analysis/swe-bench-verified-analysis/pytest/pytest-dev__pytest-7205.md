---
instance_id: pytest-dev__pytest-7205
repo: pytest-dev/pytest
base_commit: 5e7f1ab4bf58e473e5d7f878eb2b499d7deabd29
version: "5.4"
difficulty: "<15 min fix"
created_at: 2020-05-09T11:25:58Z
fail_to_pass: 10
pass_to_pass: 16
gold_files: [src/_pytest/setuponly.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
`python3 -bb -m pytest --setup-show`(BytesWarning을 에러로 격상)로 bytes 파라미터(`@pytest.mark.parametrize('data', [b'Hello World'])`)를 가진 테스트를 실행하면 setup 단계에서 `BytesWarning: str() on a bytes instance`가 발생하며 ERROR가 난다. 원인은 `--setup-show`/`--setup-only`/`--setup-plan` 출력 코드가 `cached_param`을 `"[{}]".format(...)`으로 찍으면서 bytes에 대해 암묵적 `str()`을 호출하기 때문. 이슈 본문이 이미 "saferepr를 쓰는 게 맞지 않냐"고 픽스 방향을 제안한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 스택트레이스가 `src/_pytest/setuponly.py:69`의 `tw.write("[{}]".format(fixturedef.cached_param))` 라인을 정확히 지목한다. grep 한 방으로 끝.
- **S1 (Direct-Map) +S2**: 이슈와 hints_text가 픽스를 사실상 명세("use `saferepr`", "shorter maxsize than 240"). `str()` → `saferepr()` 치환은 정형 결함클래스(repr/escaping 가드)의 템플릿 매칭. 다만 `maxsize` 인자값을 합성해야 하는 작은 추론(기본 240은 과하다 → 42)이 끼어 S2 보조.
- **K-Gen**: pytest 내부 도메인지식 불필요. `saferepr`라는 기존 헬퍼의 존재만 알면 되고 bytes/str repr은 일반 파이썬 상식.
- **primary = T-DirectMap**: 위치 자명 + 기계적 함수치환 픽스. 식 합성이 본질이 아니라 "올바른 헬퍼로 출력 인코딩을 바꾸는 것"이 본질이라 ConstraintReason이 아니다.

APR 관점: 이슈가 결함 위치·수정 방향·심지어 사용할 API까지 적어주므로 template-based repair(PAR/TBar류)로 충분. 후보를 여럿 생성해 테스트로 거를 필요가 없어 G&V/CEGIS가 아니다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`setuponly.py`), 실질 변경 2줄(import 1 + write 1).
- localize 직접성 최상(L0, 네이티브 스택트레이스가 정확한 라인).
- `has-repro`: 최소 재현 코드 + 완전한 트레이스백 존재 → 가장 강한 easiness 신호.
- 도메인지식 없음(K-Gen).
- 다만 P2P 16개 + F2P 9개가 `?foo?` → `?'foo'?`처럼 **출력 포맷 기대값을 동시에 바꿔야** 하는 regression-trap이 있어 T1까지 내리지 않음(인접 fnmatch 단언이 새 repr 형식과 정합해야 함).

공식 라벨 `<15 min fix`와 일치. 개발자 구현시간 기준이지만 에이전트 난이도도 동급으로 낮다.

## 골드패치 분석
- **파일/함수**: `src/_pytest/setuponly.py`의 `_show_fixture_action(fixturedef, msg)`.
- **근본원인**: `"[{}]".format(fixturedef.cached_param)`의 `{}` 포맷 변환은 `__format__`/`str()`을 호출한다. `cached_param`이 bytes일 때 `str(b'...')`은 `BytesWarning`을 발생시키고, `-bb` 환경에선 이게 에러로 격상되어 fixture setup이 통째로 실패한다.
- **수정요지**: 모듈 상단에 `from _pytest._io.saferepr import saferepr` 추가하고, 해당 라인을 `tw.write("[{}]".format(saferepr(fixturedef.cached_param, maxsize=42)))`로 교체. `saferepr`는 bytes를 `repr` 기반으로 안전 직렬화(예외/경고 없이)하고 `maxsize=42`로 과도하게 긴 파라미터 표시를 절단한다.

## 검증 (test_patch)
- **신규 F2P**: `test_show_fixture_action_with_bytes`가 핵심 — `b'Hello World'` 파라미터로 `sys.executable, "-bb", "-m", "pytest", "--setup-show"`를 서브프로세스 실행해 `result.ret == 0`을 단언. 이게 `-bb`에서 BytesWarning이 더는 에러가 아님을(즉 `saferepr` 적용을) 직접 증명한다.
- **기존 테스트 기대값 갱신**: `test_show_fixtures_with_parameters` 등 9개가 `arg_same?foo?` → `arg_same?'foo'?`로 바뀜. `str('foo')`='foo'였으나 `saferepr('foo')`="'foo'"(따옴표 포함)이기 때문 — repr화의 가시적 부작용을 잠금.
- **overfit 관점**: bytes 단언이 서브프로세스+`-bb`라는 실제 결함 조건을 재현하므로 special-case 통과가 아님. str 케이스 기대값 변경이 일반화(모든 param이 repr로 찍힌다)를 강제해 얇지 않다.
- **regression 관점**: P2P 16개는 따옴표가 안 붙는 출력(scope/autouse/active 등 비-param 경로)이라 영향 없음. `maxsize=42`는 짧은 테스트 파라미터를 절단하지 않아 기존 단언과 충돌하지 않는다.

## 모범답안 (오라클 기반)
1. **localize**: 트레이스백 마지막 프레임 `src/_pytest/setuponly.py:69`의 `tw.write("[{}]".format(fixturedef.cached_param))` + 예외 `BytesWarning: str() on a bytes instance`를 그대로 따라가면 단일 라인에 도달. 추가 탐색 불필요.
2. **픽스**: 암묵 `str()`을 `saferepr(fixturedef.cached_param, maxsize=42)`로 교체. 올바른 일반화인 이유 — 문제는 "bytes를 str로 강제"라는 결함클래스 자체이고, `saferepr`는 임의 객체를 예외/경고 없이 repr 직렬화하므로 bytes뿐 아니라 모든 미래 param 타입에 안전. `maxsize`는 hints_text("240 too long")를 반영한 표시 절단으로, bytes 회피와 직교한 출력 위생 개선.
3. **regression 안전**: param 출력이 `saferepr`로 바뀌면 str 파라미터에 따옴표가 붙으므로 `test_show_fixtures_with_parameters`/`_with_parameter_ids`/`_function`의 fnmatch 기대값을 `?'foo'?` 형태로 함께 갱신해야 한다. 이를 빠뜨리면 9개가 깨진다. 반대로 비-param 출력 경로(P2P 16개)는 건드리지 않는다.
4. **함정 회피**: (a) `str()` 대신 `repr()`만 쓰면 bytes는 통과하나 매우 긴 param에서 출력이 폭주하고, pytest는 이미 `saferepr` 헬퍼를 보유하므로 프로젝트 관례상 `saferepr`가 정답. (b) `maxsize` 인자를 빼면 동작은 맞지만 hints의 의도(짧게)를 놓침 — 단 테스트는 짧은 입력이라 누락해도 F2P는 통과할 수 있어 over-/under-fit 경계. (c) 가장 흔한 실수는 src만 고치고 인접 fnmatch 단언 갱신을 잊어 P2P/F2P 동시 회귀를 내는 것 — 출력 포맷 변경은 항상 기대 문자열 동기화를 동반함을 인지해야 한다.
