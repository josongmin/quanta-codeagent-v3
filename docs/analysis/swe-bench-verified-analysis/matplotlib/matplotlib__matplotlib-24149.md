---
instance_id: matplotlib__matplotlib-24149
repo: matplotlib/matplotlib
base_commit: af39f1edffcd828f05cfdd04f2e59506bb4a27bc
version: "3.6"
difficulty: "<15 min fix"
created_at: 2022-10-12T22:00:54Z
fail_to_pass: 1
pass_to_pass: 767
gold_files: [lib/matplotlib/axes/_axes.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`ax.bar([np.nan], [np.nan])`가 matplotlib 3.6.1에서 `StopIteration`을 던지며 깨진다(3.6.0에선 nan을 가진 Rectangle 1개를 정상 반환). seaborn의 히스토그램이 색 사이클을 돌리려 "phantom" bar를 그렸다 지우는 패턴에 의존하는데, 이 회귀가 그걸 망가뜨린다. 원인은 PR #23751에서 도입된 `_safe_first_finite`가 "유한값 중 첫 원소"를 찾으려고 `next(...)`를 쓰는데, **모든 원소가 nan이면 next가 `StopIteration`을 올리고 그게 핸들되지 않는** 데 있다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈에 네이티브 traceback이 그대로 박혀 있어 `axes/_axes.py:_convert_dx`의 `cbook._safe_first_finite(x0)` 호출과 `cbook/__init__.py:1749`의 `next(...)` generator까지 한 방에 지목된다. grep 불필요.
- **S1 (Direct-Map) + 보조 S2**: 결함 클래스가 "처리 안 된 예외(unhandled StopIteration)"라는 정형 템플릿이고, 픽스는 기존 `except (TypeError, IndexError, KeyError)` 옆에 `except StopIteration` 분기를 추가하는 기계적 가드다. 다만 fall-back 값을 무엇으로 줄지는 의미 추론이 필요(빈 게 아니라 "유한값이 없으니 첫 원소를 무조건 채택")해 S2를 보조로 단다.
- **K-Domain**: 일반 파이썬 추론만으론 `safe_first_element`/`_safe_first_finite`의 cbook 도메인 계약("유한 우선, 없으면 첫 원소")을 알기 어렵다. matplotlib 내부 helper 시맨틱 지식이 올바른 fall-back 선택의 병목.
- **primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 예외 가드 추가라는 기계적 매핑(S1)이라 dominant는 DirectMap. repro/traceback이 strategy를 거의 명세한다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일·단일 함수(`_convert_dx`), gold diff는 +8줄(대칭 2블록), `has-repro`(완전한 네이티브 StopIteration traceback)로 localize 직접성이 최상. 도메인 지식(cbook fall-back 계약)이 약간 끼어 순수 T1보다 한 단계 위. 공식 라벨 `<15 min fix`와 일치 — 개발자 구현시간 기준으로도 핸들러 한 줄짜리이며 hints에 이미 정답 diff가 붙어 있다. P2P가 767개로 넓어 `regression-trap` 플래그를 달지만, 추가가 순수 additive(`except` 분기 신설)라 기존 경로를 건드리지 않아 trap 실현 위험은 낮다 — tier를 끌어올리진 않음.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/axes/_axes.py`의 `Axes._convert_dx` (static helper, `bar`가 width/xerr 변환에 호출).
- **근본원인**: `cbook._safe_first_finite(obj)`가 `next(val for val in obj if safe_isfinite(val))`로 구현돼, 입력이 전부 비유한값(nan)이면 generator가 소진되어 `StopIteration`이 전파된다. 기존 try/except는 `(TypeError, IndexError, KeyError)`만 잡아 이 케이스를 누락 — PR #23751("leading NaN" 수정)이 들여온 회귀.
- **수정요지**: `x0`와 `xconv` 각각의 try 블록에 `except StopIteration` 분기를 추가하고, 그 안에서 `x0 = cbook.safe_first_element(x0)` / `x = cbook.safe_first_element(xconv)`로 **유한 필터 없이 무조건 첫 원소를 채택**한다. 즉 "유한값을 못 찾았으니 첫 원소(=nan)를 그대로 쓴다"로 3.6.0 동작을 복원.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_bar_all_nan[png]`. `@check_figures_equal`로 test fig는 `ax.bar([np.nan],[np.nan])` 후 `ax.bar([1],[1])`를, ref fig는 `ax.bar([1],[1]).remove()` 후 `ax.bar([1],[1])`를 그려 **두 그림이 픽셀 동일**해야 통과. 핵심은 (a) all-nan bar가 예외 없이 그려지고, (b) 그것이 color cycle을 ref의 remove된 phantom bar와 똑같이 advance시켜 두 번째 실제 bar의 색이 일치하는 것 — seaborn 실사용 패턴을 그대로 재현.
- **픽스 증명**: 패치 전엔 첫 `ax.bar([np.nan],...)`에서 StopIteration으로 즉사 → 테스트 setup 자체가 실패. 패치 후 fall-back으로 nan Rectangle이 생성되고 cycle이 한 칸 돌아 ref와 동치.
- **overfit/regression**: overfit 위험 낮음 — 픽스가 테스트 입력에 특화된 분기가 아니라 "비유한 전용 시퀀스"라는 일반 입력공간을 덮고, color-cycle 동치를 요구해 단순 no-raise 우회로는 통과 못 한다. regression: 767 P2P 중 기존에 유한값이 하나라도 있던 경로는 `StopIteration`이 안 나므로 새 분기에 진입하지 않아 byte-동등 — additive 변경이라 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 traceback을 그대로 따라간다. `bar` → `_convert_dx` (axes/_axes.py:2182) → `cbook._safe_first_finite` → `next(...)`의 `StopIteration`. repro가 `ax.bar([np.nan],[0])`는 raise, `ax.bar([0],[np.nan])`는 OK라고 알려줘 **x 위치(x0/xconv) 경로**임이 확정. L0 — 탐색 없음.
2. **픽스와 일반화 근거**: try마다 `except StopIteration`을 추가하고 `cbook.safe_first_element`로 fall-back. 왜 `safe_first_element`인가 — `_safe_first_finite`는 "유한값"을 요구하지만 전부 nan일 땐 유한값이 존재할 수 없으므로 "유한 필터를 끈 첫 원소"가 의미상 올바른 복원이다(3.6.0의 동작). nan을 0이나 빈 값으로 바꾸지 않는 게 핵심 — 호출자 `bar`는 nan 좌표 Rectangle을 정당한 결과로 기대한다.
3. **regression 안전**: x0와 xconv **양쪽** 블록에 대칭으로 넣어야 한다(한쪽만 고치면 다른 경로에서 재발). 유한값이 있는 일반 케이스는 새 분기에 안 들어가므로 767 P2P 불변 — 특히 datetime+timedelta, pint-wrapped array 등 기존 `_convert_dx` 동작을 깨지 않음.
4. **함정 회피**: (a) `cbook._safe_first_finite` 자체를 고쳐 StopIteration을 삼키면 다른 호출처(leading-nan 정상 동작)까지 시맨틱이 바뀌어 PR #23751의 의도를 되돌리는 회귀 — 수정은 호출처(`_convert_dx`)에서 잡아야 한다. (b) `except StopIteration`을 기존 `(TypeError, IndexError, KeyError)` 튜플에 합쳐 `pass`로 처리하면 `x0`가 미변환 상태로 남아 width 산술에서 다른 오류가 나거나 색 사이클 동치가 깨져 `check_figures_equal`이 실패 — fall-back 대입이 반드시 필요. (c) x0만 고치고 xconv를 빠뜨리는 비대칭 수정(테스트는 둘 다 nan이라 한쪽만 고치면 여전히 실패로 드러남).
