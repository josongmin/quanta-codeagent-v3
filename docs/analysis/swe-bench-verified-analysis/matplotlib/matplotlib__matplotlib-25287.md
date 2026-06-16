---
instance_id: matplotlib__matplotlib-25287
repo: matplotlib/matplotlib
base_commit: f8ffce6d44127d4ea7d6491262ab30046b03294b
version: "3.7"
difficulty: "<15 min fix"
created_at: 2023-02-22T18:19:27Z
fail_to_pass: 2
pass_to_pass: 786
gold_files: [lib/matplotlib/axis.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
matplotlib 3.6.3에서 `xtick.labelcolor` / `ytick.labelcolor` rcParam을 설정해도 축의 지수 라벨(offset text, 예: `1e9`)의 색이 바뀌지 않는다. offsetText는 항상 `xtick.color` / `ytick.color` 기준으로 색이 칠해지며, 일반 tick label 색과 일관되지 않는다. 이슈 본문에 재현 코드와 함께 작성자가 직접 만든 수정 diff까지 포함되어 있다.

## 유형 (정형화)
- **L = L1 (Traceable)**: 이슈가 "offsetText", "tick.color vs tick.labelcolor"라는 키워드를 직접 주고, 작성자 패치가 정확한 라인(`color=mpl.rcParams['xtick.color']`)을 지목한다. `axis.py`의 `XAxis._init` / `YAxis._init` 안 `self.offsetText.set(...)` 호출로 곧장 수렴 — 단일 파일 약간의 탐색.
- **S = S1 (Direct-Map) (+S2)**: 픽스는 사실상 명세돼 있다. `color=...color` 자리를 `labelcolor`가 `'inherit'`면 `color`, 아니면 `labelcolor`로 분기. `'inherit'` sentinel 처리라는 작은 조건 합성(S2)이 끼지만, 본질은 기존 tick-label 색 결정 규약을 그대로 복제하는 기계적 매핑이다.
- **K = K-Domain**: `labelcolor`의 `'inherit'` sentinel 의미(미지정 시 `tick.color`를 따라감)는 matplotlib rcParam 규약 도메인 지식. 이걸 모르면 단순히 `labelcolor`로만 바꿔 `'inherit'` 기본값을 깨뜨린다.
- **primary = T-DirectMap**: 위치가 명확하고 픽스가 기존 규약을 복제하는 기계적 매핑. 진짜 핵심은 "`inherit` 분기를 빠뜨리지 않는 것"이라 S1이 dominant.

## 난이도 티어
**T2 (쉬움).** 구조적 피처: 1파일(`axis.py`), gold 2헌크 약 12줄, localize 직접성 높음(L1, 이슈가 라인 지목+repro 존재), 도메인 지식은 `'inherit'` sentinel 한 가지로 국소적. 공식 라벨도 `<15 min fix`로 일치. T1이 아닌 이유: 이슈 작성자의 naive 패치는 `'inherit'` 분기를 *이미* 포함하지만, 아무 생각 없이 `labelcolor`로만 치환하면 `'inherit'` 기본값(거의 모든 P2P 케이스)에서 색이 깨진다 — 즉 약한 constraint 추론과 넓은 regression 표면이 T1보다 한 칸 위로 민다. P2P 786개가 대부분 기본 스타일(`labelcolor='inherit'`)이라 이 분기를 틀리면 대량 회귀.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/axis.py`의 `XAxis._init` 와 `YAxis._init`.
- **근본원인**: 두 `_init`이 `self.offsetText.set(...)`에서 색을 `mpl.rcParams['xtick.color']` / `['ytick.color']`로 하드코딩. 일반 tick label은 `labelcolor`(기본 `'inherit'` → `color` fallback)를 따르는데 offsetText만 이 규약에서 누락됨.
- **수정요지**: 각 `_init`에서 `set()` 호출 전에 분기 변수 `tick_color`를 계산 — `rcParams['xtick.labelcolor'] == 'inherit'`이면 `xtick.color`, 아니면 `xtick.labelcolor`(ytick 동일). 그리고 `color=tick_color`로 전달. 이슈 작성자의 인라인 삼항을 동일 의미의 명시적 if/else로 정형화한 것.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_xaxis_offsetText_color`, `test_yaxis_offsetText_color`. 각 테스트가 두 케이스를 검증: (1) `labelcolor='blue'/'green'` 설정 시 `ax.xaxis.offsetText.get_color()`가 해당 색이어야 함(설정 경로), (2) `color='yellow'/'red'` + `labelcolor='inherit'` 시 offsetText가 `color` 값을 따라야 함(inherit fallback 경로).
- **픽스 증명**: 두 테스트가 정확히 gold의 두 분기(`inherit` vs explicit)를 각각 친다. naive 치환(분기 없이 `labelcolor`만)은 케이스(2)에서 `'inherit'` 문자열이 색으로 들어가 실패 → 테스트가 회귀를 잡는다.
- **overfit/regression**: FAIL_TO_PASS가 얇지만(2개) inherit/explicit 양 경로를 모두 커버해 S4식 special-case 통과를 막는다. P2P 786개가 기본 스타일이라 `'inherit'` 분기 보존을 강제 — regression-trap이 실질적.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "offsetText is colored based on tick.color instead of tick.labelcolor" + repro에서 지수 라벨이 핵심 → `axis.py`에서 `offsetText`와 `xtick.color` 동시 grep → `XAxis._init` / `YAxis._init`의 `self.offsetText.set(... color=mpl.rcParams['xtick.color'])` 두 지점에 도달.
2. **픽스와 일반화**: tick label의 색 규약(`labelcolor=='inherit'`이면 `color`, 아니면 `labelcolor`)을 offsetText에도 동일 적용. 이게 올바른 일반화인 이유 — offsetText는 의미상 tick label의 일부이므로 같은 규약을 따라야 하고, `'inherit'` sentinel을 보존해야 기존 동작이 유지된다. `labelcolor`로 무조건 치환하는 것은 sentinel을 깨는 오답.
3. **regression 안전**: P2P 786개 대부분은 `labelcolor`가 기본값 `'inherit'`이라 분기 결과가 `xtick.color`로 떨어져 *기존과 동일*해야 한다. `if ... == 'inherit'` 분기를 정확히 넣으면 이 광범위 케이스가 byte-identical하게 보존됨.
4. **함정 회피**: (a) `'inherit'` 분기를 빠뜨리고 `labelcolor`로 직접 치환 → 기본 스타일에서 `'inherit'` 문자열이 색으로 들어가 대량 회귀. (b) x축만 고치고 y축 대칭 헌크를 누락(두 `_init`이 독립이라 한쪽만 고치면 FAIL_TO_PASS 절반 잔존). (c) `offsetText` 생성 위치를 잘못 짚어 tick label 색 결정부(별도)를 건드리는 것 — 수정 지점은 offsetText 한정.
