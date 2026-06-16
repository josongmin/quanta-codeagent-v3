---
instance_id: matplotlib__matplotlib-25479
repo: matplotlib/matplotlib
base_commit: 7fdf772201e4c9bafbc16dfac23b5472d6a53fa2
version: "3.7"
difficulty: "<15 min fix"
created_at: 2023-03-16T17:59:41Z
fail_to_pass: 2
pass_to_pass: 263
gold_files: [lib/matplotlib/cm.py, lib/matplotlib/colors.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
컬러맵을 객체 내부 이름(`some_cmap_name`)과 다른 이름(`my_cmap_name`)으로 `register`/`register_cmap` 한 뒤 `plt.set_cmap('my_cmap_name')` 후 그리면 `ValueError: Colormap some_cmap_name is not recognized`가 난다. 등록 시 사용한 이름이 아니라 컬러맵 객체의 `.name` 속성으로 재조회(double lookup)되기 때문이다. 핵심 욕구는 "빌트인을 가져와 over/under만 바꾸고 다른 이름으로 등록"하는 흔한 워크플로우를 깨지 않고 지원하는 것이다.

## 유형 (정형화)
- **L = L3 (Multi-site)**: 픽스가 `cm.py`의 등록 경로와 `colors.py`의 동등성(`__eq__`) 경로 **두 곳을 함께** 바꿔야 일관성이 산다. 이슈/hints는 `set_cmap`/`pyplot`을 지목하지만 실제 근본 픽스 지점은 그게 아님 → 단순 grep으로 안 끝남.
- **S = S2 (Constraint-Reasoning) + S5(Spec-Inference)**: 등록 이름과 객체 이름의 불변식("registry 키 = 객체 name")을 추론으로 합성해야 한다(S2). 그리고 "이름이 다른 컬러맵을 같은 것으로 볼지"는 코드만으론 안 정해지고, 이슈 코멘트(greglucas의 viridis+with_extremes 시나리오)에서 의도된 스펙을 재구성해야 한다(S5).
- **K = K-Domain**: 컬러맵 registry(`ColormapRegistry._cmaps`), `rcParams['image.cmap']`, lookup table 기반 동등성 등 matplotlib 내부 모델 이해가 병목.
- **primary = T-ConstraintReason**: 위치는 좁지만 자명한 가드 추가가 아니라 "registry 키와 객체 name을 동기화 + name을 동등성 판정에서 제외"라는 **불변식 합성**이 본질. 그래서 S1 템플릿이 아니라 S2다.

## 난이도 티어
- **티어 = T4 (약간 어려움)**. 구조 피처: 파일 2개, 변경 ~6줄로 작지만 **L3 조율**(register-side와 eq-side 동시 변경)이 필요하고, `__eq__`에서 name 비교를 제거하는 변경은 **regression-trap**이 크다(컬러맵 동등성에 의존하는 광범위 코드).
- 공식 라벨은 `<15 min fix`(T1~T2 prior). 다르게 매긴 이유: 줄 수만 보면 사소하나, (1) 이슈가 가리키는 `set_cmap`/`pyplot`은 **오답 위치**여서 localize가 호도되고, (2) `__eq__`에서 name을 빼는 결정은 263개 P2P를 안 깨는지 따져야 하는 의미적 판단이라 시간라벨에 안 잡히는 추론 부담이 있다.

## 골드패치 분석
- `lib/matplotlib/cm.py` — `ColormapRegistry.register()`: `self._cmaps[name] = cmap.copy()` 직후, 복사본의 `.name`이 등록 이름과 다르면 `self._cmaps[name].name = name`으로 **동기화**. 근본원인 1: registry에는 등록 이름으로 저장되지만 객체는 빌트인/원본 name을 그대로 들고 있어, 이후 `set_cmap`→rcParam→재조회 시 객체 name으로 lookup이 빗나감.
- `lib/matplotlib/colors.py` — `Colormap.__eq__()`: 비교 조건에서 `self.name != other.name`을 **제거**, `colorbar_extend`와 lookup table만 비교. 근본원인 2: name이 동등성에 들어가면, 같은 LUT를 다른 이름으로 등록한 컬러맵이 "다르다"고 판정돼 위 동기화/사용 시나리오가 모순됨.
- 수정요지: registry 키를 객체의 진실로 만들고(name 동기화), 동등성은 시각적 정체성(LUT+extend)으로 정의 → 이름 재명명이 동등성을 깨지 않게.

## 검증 (test_patch)
- FAIL_TO_PASS 2개:
  - `test_colormap_equals`: 기존엔 `cm_copy.name="Test"` 후 `cm_copy != cmap`을 단언했으나, 패치로 **`cm_copy == cmap`**(LUT 동일하면 이름 달라도 동등)으로 의미가 뒤집혀 `__eq__` 변경을 직접 증명.
  - `test_set_cmap_mismatched_name`: `viridis.with_extremes(over='r')` → `cmap.name="test-cmap"` → `register(name='wrong-cmap')` → `set_cmap("wrong-cmap")`/`get_cmap("wrong-cmap")`이 **객체 동등** + **`.name == "wrong-cmap"`**임을 단언 → **두 변경을 모두** 요구한다. `.name == "wrong-cmap"`은 `register()`의 name 동기화를 증명하고, `cmap_returned == cmap` 단언은 `__eq__` 변경에도 의존한다: 동기화 후 `cmap_returned.name="wrong-cmap"`이지만 원본 `cmap.name="test-cmap"`(register는 `cmap.copy()`를 저장하고 copy는 name 보존)이라 두 name이 다르고, base의 `__eq__`는 name 불일치 시 False라 name 비교를 빼지 않으면 이 단언이 실패한다.
- overfit 관점: 두 테스트가 패치의 두 변경을 각각 정확히 겨냥하고, name과 LUT를 분리 검증해 special-case 통과가 어렵다. 단 `__eq__`에서 name 제외는 "이름이 의미상 정체성인" 가정에 의존하던 미검증 코드가 있으면 위험(overfit-risk보다 regression-trap 쪽).
- regression 관점: 263 P2P(특히 `test_colormap_copy`, `test_register_cmap`, `test_colormaps_get_cmap`, 대량 `test_colormap_reversing[*]`)가 동등성/등록 동작을 광범위하게 고정 → name을 eq에서 빼도 LUT/extend 기반 판정이 이들을 유지함을 보증.

## 모범답안 (오라클 기반)
1. **localize**: 스택트레이스가 `get_cmap(name)`에서 터지고 메시지가 `some_cmap_name`(등록 이름 아님)임에 주목 → "등록 이름 vs 객체 name" 이중 lookup 가설. hints의 `set_cmap`은 증상 위치일 뿐, registry에 무엇이 저장되는지 추적하면 `ColormapRegistry.register()`(`cm.py`)가 진짜 진입점.
2. **픽스**: register 시 저장 객체의 `.name`을 등록 키와 동기화(불변식 "registry 키 == 객체 name") + `__eq__`에서 name 비교 제거. 이게 올바른 일반화인 이유 — name은 식별자(라벨)일 뿐 시각적 정체성이 아니므로, 동등성은 LUT+`colorbar_extend`로 정의하는 게 도메인적으로 맞다(같은 viridis를 다른 이름으로 등록해도 같은 컬러맵).
3. **regression 안전**: `__eq__` 변경이 광범위하므로 LUT/extend 비교 경로는 보존해야 하고(`test_colormap_equals`의 LUT-size·extend 분기 유지), `test_register_cmap`/`copy`/`reversing` 류가 깨지지 않는지 확인. 동기화는 `cmap.copy()` 결과에만 적용해 원본 사용자 객체를 변형하지 않음(부작용 회피).
4. **함정 회피**: (a) hints만 믿고 `pyplot.set_cmap`/rcParam 검증을 우회 수정하면 증상만 가리고 근본 이중 lookup이 남음(실제로 과거 PR이 이렇게 실패). (b) `register()`만 고치고 `__eq__`를 안 고치면 `test_colormap_equals`가 반대로 깨지거나 동등성 모순이 남음 → **두 site 조율이 필수**. (c) 원본 객체의 name을 in-place로 바꾸면 호출자 객체를 오염시키므로 반드시 copy 본에만 적용.
