---
instance_id: mwaskom__seaborn-3187
repo: mwaskom/seaborn
base_commit: 22cdfb0c93f8ec78492d87edb810f10cb7f57a31
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: 2022-12-18T00:04:22Z
fail_to_pass: 2
pass_to_pass: 248
gold_files: [seaborn/_core/scales.py, seaborn/utils.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, cross-file-dep, regression-trap]
---

## 문제 요약
큰 수(예: 1E6 규모) 범례에서 `ScalarFormatter`가 multiplicative offset / scientific notation을 떼어내고 mantissa만 표기하는 바람에 범례 값이 잘못 나온다. seaborn은 그 offset 텍스트를 범례 어디에도 표시하지 않으므로, 라벨이 실제 데이터 스케일과 완전히 어긋난다. `so.Plot`(objects)과 `relplot`/`scatterplot`(classic) 양쪽 경로에서 동일하게 재현된다. 이슈 본문이 원인 파일(`_core/scales.py` L377-382)과 `ScalarFormatter` offset 메커니즘까지 정확히 지목한다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 동일 결함이 두 독립 코드경로에 존재 — objects 엔진(`_core/scales.py`)과 classic 엔진(`utils.py`의 `dummy_axis` 기반 포매터 생성). 한 군데만 고치면 FAIL_TO_PASS 절반이 남는다. 두 파일을 **함께** 고쳐야 한다.
- **S = S2 (+S5)**: 고칠 지점 자체는 이슈가 짚어주지만, "offset을 범례 제목에 합치자"는 이슈 제안을 그대로 따르면 안 되고, seaborn이 offset을 표현할 표면이 없다는 제약을 추론해 "포매터에서 offset/scientific을 끄는" 방향(`set_useOffset(False)`/`set_scientific(False)`)을 합성해야 한다. 의도된 동작(offset 없이 절대값 라벨)을 스펙으로 재구성하는 S5 요소도 있다.
- **K = K-Domain**: matplotlib `ScalarFormatter`의 offset/scientific 내부 동작과 seaborn의 범례 생성 파이프라인(`format_ticks`, `dummy_axis`) 지식이 병목. 일반 파이썬 추론만으론 못 푼다.
- **primary = T-DomainBound**: 픽스 줄수는 작지만 핵심 난점이 "matplotlib 포매터 도메인 지식 + 두 엔진 경로 모두 인지"에 있어 K-Domain이 dominant.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일수 2 / 헌크 2 / 픽스 코드는 각 4줄 안팎으로 작음 → 줄수만 보면 쉬움.
- 그러나 **L3 multi-site**: 동일 버그가 objects/classic 두 경로에 분산되어, 한 곳만 고친 패치는 `tests/test_relational.py` 쪽 FAIL_TO_PASS에서 탈락한다(부분 픽스 함정).
- `has-repro`(완전한 재현 스니펫 + 정확한 소스 라인 링크)는 강한 easiness 신호라 T5로는 안 올라감.
- `regression-trap`: PASS_TO_PASS 248개로 넓다. 범례·스케일·포매터 인접 동작(log scale 포매터 등)을 안 깨야 한다.
공식 라벨 "15분-1시간"과 일치. 다만 시간라벨은 "두 번째 경로(`utils.py`)를 놓칠 위험"을 못 잡으므로, 에이전트 관점에선 localize 완전성이 실질 난점이다.

## 골드패치 분석
건드린 파일·함수:
- `seaborn/_core/scales.py` — `ContinuousBase._setup` 내부 `spacer`/legend 생성 블록(`axis.major.formatter.format_ticks(locs)` 직전).
- `seaborn/utils.py` — `locator_to_legend_entries` 함수의 `else` 분기에서 `ScalarFormatter()`를 만드는 곳(함수 안 `dummy_axis`의 inner `get_view_interval`은 diff 헤더 컨텍스트일 뿐 편집 대상 아님; `_disable_autolayout`은 170줄 떨어져 무관).

근본원인: 범례 라벨을 `formatter.format_ticks(locs)`로 생성하는데, `ScalarFormatter`는 큰 값에서 공통 offset/scientific 배수를 분리해 축 코너에 별도 표기하도록 설계돼 있다. seaborn 범례에는 그 offset 텍스트를 그릴 자리가 없어, 분리된 mantissa만 라벨로 남아 값이 틀린다.

수정요지: 라벨 포매팅 직전에 포매터의 offset/scientific 표기를 **끈다**.
- scales.py: `hasattr` 가드 후 `axis.major.formatter.set_useOffset(False)` / `set_scientific(False)`.
- utils.py: `ScalarFormatter()` 생성 직후 `formatter.set_useOffset(False)` / `formatter.set_scientific(False)`.
이러면 `format_ticks`가 각 tick의 절대값을 그대로 라벨로 내보낸다.

## 검증 (test_patch)
FAIL_TO_PASS 2개:
- `tests/_core/test_plot.py::TestLegend::test_legend_has_no_offset` — `color = x + 1e8`로 범례 생성 후 모든 텍스트가 `float(text) > 1e7`인지 확인. offset이 분리되면 mantissa는 1e7 미만이 되어 실패 → 픽스 후 절대값이라 통과.
- `tests/test_relational.py::TestRelationalPlotter::test_legend_has_no_offset` — `relplot(... hue = z + 1e8)`에서 동일 검증. **이 테스트가 utils.py 경로를 강제**하므로 scales.py만 고치면 못 통과한다.

overfit 관점: 두 테스트가 두 엔진을 각각 커버해 single-path 픽스를 배제한다. 다만 `> 1e7` 단방향 임계라서 "라벨이 정확한 값인지"까지는 안 보고 "offset이 안 떨어졌는지"만 본다 — 약한 overfit 여지는 있으나 set_useOffset/set_scientific을 끄는 골드 방식이 가장 자연스러운 일반해라 실질 위험은 낮음.
regression 관점: log scale은 `LogFormatter` 분기로 빠져 영향 없고, hasattr 가드로 `set_useOffset`/`set_scientific`이 없는 포매터에는 안전. PASS_TO_PASS 248개(범례/스케일/포매터 다수)가 그대로 통과해야 함.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `_core/scales.py` L377-382와 `ScalarFormatter` offset을 직접 지목 → `format_ticks(locs)` 호출부가 첫 후보. 핵심은 여기서 멈추지 말고, 이슈가 "scatterplot/relplot에서도 재현"이라 명시했으니 classic 경로(`utils.py`의 `locator_to_legend_entries`에서 `ScalarFormatter`를 생성하는 `else` 분기, relplot이 `relational.py`에서 이 함수를 호출)를 grep으로 찾아 **두 번째 site**를 확보하는 것.
2. **픽스**: offset을 범례 제목에 합치는 이슈 제안 대신, seaborn이 offset을 표현할 표면이 없다는 제약상 포매터의 `set_useOffset(False)`/`set_scientific(False)`로 offset 자체를 끄는 게 올바른 일반화 — 모든 입력 규모에서 라벨이 절대값이 되고 별도 표기 자리도 필요 없다.
3. **regression 안전**: log scale(`LogFormatter`)은 건드리지 않고, scales.py는 `hasattr` 가드로 포매터 종류에 무관하게 안전. PASS_TO_PASS의 log/포매터 테스트가 깨지지 않음을 확인.
4. **함정 회피**: (a) scales.py 한 곳만 고치고 끝내면 relplot FAIL_TO_PASS가 남는 **multi-site 누락**이 최대 함정. (b) 이슈의 "offset을 제목에 표시" 제안을 곧이곧대로 구현하면 표현 표면이 없어 과설계가 된다. (c) utils.py에서는 `hasattr` 없이 직접 호출해도 되지만(방금 만든 `ScalarFormatter`라 메서드 존재 보장), scales.py에서는 외부 axis 포매터라 가드가 필요하다는 비대칭을 인지해야 함.
