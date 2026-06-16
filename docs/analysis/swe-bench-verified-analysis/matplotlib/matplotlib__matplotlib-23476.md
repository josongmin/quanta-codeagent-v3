---
instance_id: matplotlib__matplotlib-23476
repo: matplotlib/matplotlib
base_commit: 33a0599711d26dc2b79f851c6daed4947df7c167
version: "3.5"
difficulty: "<15 min fix"
created_at: 2022-07-22T18:58:22Z
fail_to_pass: 1
pass_to_pass: 104
gold_files: [lib/matplotlib/figure.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

M1 Mac(HiDPI)에서 figure를 pickle로 덤프 후 다시 로드하면 dpi가 매번 2배로 불어나고, 루프로 반복하면 `OverflowError`까지 난다. 원인은 HiDPI 처리에서 `_set_device_pixel_ratio`가 `figure._dpi`를 `ratio * _original_dpi`로 부풀려 놓은 채 그 부풀린 `_dpi`를 직렬화하기 때문이고, 다시 unpickle하면 canvas가 또 ratio를 곱해 누적된다. 이슈 본문에 명확한 재현코드·네이티브 스택트레이스(`backend_macosx.py __init__` → `OverflowError`)가 있다.

## 유형 (정형화)

- **L1 (Traceable)**: 스택트레이스가 `figure.py::__setstate__`/canvas 생성 경로를 직접 가리키고, hint가 "doubled dpi를 저장→재로드 시 또 doubling"이라고 인과를 거의 짚어준다. 다만 정확한 수정 지점이 `__setstate__`(복원)가 아니라 `__getstate__`(직렬화 시점)임은 약간의 데이터플로우 추적이 필요해 L0는 아니다.
- **S2 (Constraint-Reasoning)**: 한 줄 추가지만 "왜 `_dpi`가 아니라 `_original_dpi`를 저장해야 동작 불변식이 보존되는가"를 추론해야 한다. 단순 None가드/상수변경이 아니라, `_set_device_pixel_ratio`가 도입한 `_dpi = ratio*_original_dpi` 변환을 직렬화 경계에서 되돌리는 의미적 수정이다.
- **K-Domain**: matplotlib의 dpi/device-pixel-ratio/`_original_dpi` 라이프사이클과 pickle `__getstate__` 관례를 알아야 한다. 일반 파이썬 추론만으론 `_original_dpi`라는 정답 필드를 못 찾는다.
- **primary = T-ConstraintReason**: 위치는 좁혀지지만 픽스의 핵심은 "직렬화될 상태를 ratio 변환 이전 값으로 정규화"하는 올바른 조건 합성에 있다. APR 관점에서 SemFix/Angelix식 의미수정(상태값 정규화)이며 템플릿 매칭(S1)으론 안 나온다.

## 난이도 티어

**T3 (중간)**. 구조적 피처: 단일 파일(`figure.py`) 1-함수 1-헌크 +3줄로 patch scope는 T1~T2급이고, `has-repro`(재현코드+네이티브 스택)라는 강한 easiness 신호가 있다. 그러나 (1) 정답 수정 지점이 스택트레이스가 가리키는 `__setstate__`가 아니라 직렬화측 `__getstate__`라는 misdirection, (2) `_original_dpi`라는 비자명한 도메인 필드를 알아야 함, (3) PASS_TO_PASS 107개가 figure 동작 전반(savefig_pixel_ratio/change_dpi/subfigure_dpi 등 dpi 인접 테스트 포함)이라 regression-trap이 실재한다는 점이 T1/T2에서 위로 민다. 공식 라벨 "<15 min fix"는 *오라클을 아는 개발자*의 구현시간으로 맞지만, 에이전트 기준 localize misdirection + 도메인 필드 발견 비용은 시간라벨에 안 잡히므로 T3로 상향.

## 골드패치 분석

- **건드린 파일·함수**: `lib/matplotlib/figure.py`의 `Figure.__getstate__` (직렬화 상태 구성).
- **근본원인**: HiDPI에서 `FigureCanvasBase._set_device_pixel_ratio(ratio)`가 `dpi = ratio * self.figure._original_dpi` 후 `self.figure._set_dpi(dpi, forward=False)`로 `_dpi`를 부풀린다. 이때 `_original_dpi`는 보존되지만 `__getstate__`는 부풀려진 `_dpi`를 그대로 직렬화한다. unpickle→canvas 재생성 시 다시 ratio가 곱해져 매 사이클 누적(idempotent 위반).
- **수정요지**: `__getstate__`에서 `state["_dpi"] = state.get('_original_dpi', state['_dpi'])`. 즉 직렬화될 dpi를 device-pixel-ratio 적용 이전 원본값으로 되돌린다. `_original_dpi`가 없는(ratio 한 번도 안 걸린) 경우엔 기존 `_dpi`로 폴백해 비-HiDPI 경로를 그대로 보존한다.

## 검증 (test_patch)

- **FAIL_TO_PASS** `test_unpickle_with_device_pixel_ratio`: `Figure(dpi=42)` 생성 → `fig.canvas._set_device_pixel_ratio(7)`로 `fig.dpi == 42*7` 확인(스케일 적용됨) → `pickle.loads(pickle.dumps(fig))` 후 `fig2.dpi == 42`를 단언. 즉 round-trip 후 dpi가 원본 42로 복귀해야 한다.
- **픽스 증명**: 패치 없으면 직렬화 시 `_dpi=294`가 저장되고 복원 canvas가 다시 곱해 `294`(또는 재-스케일) → 42로 안 돌아와 실패. 패치는 저장 직전 `_dpi`를 `_original_dpi(=42)`로 정규화하므로 복원값이 42로 수렴.
- **overfit/regression 관점**: FAIL_TO_PASS 1개라 얇지만, 테스트가 "스케일 적용→round-trip→원복"이라는 핵심 불변식을 직접 관찰해 special-case 통과가 어렵다(ratio=7, dpi=42로 우연일치 불가). regression은 PASS_TO_PASS의 `test_savefig_pixel_ratio[Agg/Cairo]`, `test_change_dpi`, `test_subfigure_dpi`가 dpi 경로를 커버해 폴백 분기가 비-HiDPI를 안 깼음을 보증.

## 모범답안 (오라클 기반)

1. **localize**: 스택트레이스의 `figure.py::__setstate__` + hint "doubled dpi를 저장→재로드 또 doubling"에서 pickle round-trip을 의심한다. `__setstate__`만 보면 canvas 재생성이 ratio를 곱하는 정상 동작이라 고칠 게 없음을 깨닫고, 한 단계 위로 올라가 "무엇을 저장하느냐"=`__getstate__`로 시선을 옮긴다. `_set_device_pixel_ratio`를 grep해 `_dpi = ratio*_original_dpi` 변환과 보존된 `_original_dpi`를 발견한다.
2. **픽스와 일반화**: `__getstate__`에서 직렬화될 `_dpi`를 ratio 적용 이전 `_original_dpi`로 되돌린다. 이는 "직렬화 상태는 표시기기 의존 변환(device pixel ratio)을 포함하면 안 된다"는 일반 원칙의 인스턴스라 overfit이 아니다 — ratio 값/플랫폼과 무관하게 누적을 끊는다. `state.get('_original_dpi', state['_dpi'])` 폴백으로 ratio 미적용 figure는 동작 불변.
3. **regression 안전**: 비-HiDPI(`_original_dpi` 부재)는 폴백으로 기존 `_dpi` 유지 → `test_change_dpi`, `test_set_fig_size`, savefig 계열 안 깨짐. 정상 figure의 pickle 의미(deepcopy 등 `test_deepcopy`)도 dpi가 동일해 유지.
4. **함정 회피**: (a) 스택트레이스만 믿고 `__setstate__`에서 dpi를 나누거나 ratio를 빼는 ad-hoc 보정 → ratio를 알 수 없어 부정확하고 비-HiDPI를 깬다. (b) `_set_dpi`/`_original_dpi` 갱신 로직 자체를 건드리면 런타임 HiDPI 표시가 망가진다. 정답은 *직렬화 경계*에서만 정규화하는 것. (c) `state['_dpi'] = state['_original_dpi']`로 무조건 접근하면 ratio 미적용 figure에서 KeyError — `.get` 폴백 필수.
