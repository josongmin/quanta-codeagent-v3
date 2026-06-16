---
instance_id: matplotlib__matplotlib-25122
repo: matplotlib/matplotlib
base_commit: 5ec2bd279729ff534719b8bf238dbbca907b93c5
version: "3.6"
difficulty: "<15 min fix"
created_at: 2023-02-01T03:41:00Z
fail_to_pass: 12
pass_to_pass: 2476
gold_files: [lib/matplotlib/mlab.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`mlab._spectral_helper`의 윈도우 보정(window correction)이 음수 계수를 갖는 윈도우(예: `flattop`)에서 틀린 결과를 낸다. 보정항이 `np.abs(window)`로 윈도우의 절댓값을 취하는데, 음수 샘플을 갖는 윈도우에서는 `np.abs(window).sum() != window.sum()`이라 스케일 팩터가 잘못 계산된다. 이슈는 정확한 위치(L423-430)와 scipy의 올바른 구현(절댓값 없이 `win.sum()`)을 함께 제시하며, `np.abs`를 제거해야 한다고 명시한다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈가 `mlab._spectral_helper`와 정확한 라인 범위(L423-430)를 직접 지목. grep 한 방으로 끝. localize 노력 사실상 0.
- **S2 Constraint-Reasoning (+S1)**: 고칠 지점은 자명하나 "왜 `np.abs`를 빼는 게 맞는가"는 신호처리 불변식 추론이다 — 윈도우 보정은 윈도우의 *에너지/진폭 합*(부호 보존)이어야지 절댓값 합이 아니다(Bendat & Piersol Sec 11.5.2 정규화). 실수 양수 윈도우(hann 등)에선 `abs`가 항등이라 회귀가 안 잡혔던 latent bug. 표면적 편집은 `np.abs(...)` 4곳 삭제로 기계적(S1)이나, 그 정당성은 제약추론이라 dominant는 S2.
- **K-Domain**: PSD/스펙트럼 윈도우 정규화·welch 등가성이라는 신호처리 도메인 지식이 정답 판별의 병목.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 픽스의 정당성이 "절댓값이 왜 틀린 스케일인가"라는 의미 추론에서 옴.

APR 관점: 결함이 "잘못된 연산자/표현식"(`np.abs` 불필요 적용)이고 올바른 식이 부호 보존 합이라는 불변식에서 합성된다 — SemFix류 condition/expression synthesis. 다수 후보를 테스트로 거르는 G&V가 아니라 "생각으로" 푸는 S2.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일수 1 (`lib/matplotlib/mlab.py`), 헌크 2개, 실효 변경 4줄 — scope는 T1~T2급.
- localize 직접성 최상(L0), `has-repro`(이슈에 재현 demo + scipy/welch 비교 코드).
- 그러나 **regression-trap이 강함**: PASS_TO_PASS 2476개 — `hann`/`hanning`/`window_none` 등 기존 윈도우 테스트가 모두 `abs`-항등이라 깨지면 안 됨. 변경이 음수 윈도우에서만 효과가 달라야 한다는 점이 제약.
- 정답 판별에 K-Domain(welch scaling 등가)이 필요해 단순 "None가드/상수변경"보다 추론 부담이 큼.

공식 라벨은 `<15 min fix`(T1~T2 prior). 한 줄 변경의 *구현 시간*은 짧지만, abs 제거가 모든 정규화 경로(psd/magnitude/complex)에서 동일하게 옳다는 판단과 광범위한 P2P 안전성 확인은 시간라벨에 안 잡히는 추론 부담이라 T3으로 한 단계 상향.

## 골드패치 분석

- **건드린 파일·함수**: `lib/matplotlib/mlab.py` 내 `_spectral_helper()`.
- **근본원인**: 윈도우 보정 스케일 팩터가 일관되게 `np.abs(window)`를 사용. 실수 양수 윈도우에선 무해하나, 음수 계수를 갖는 `flattop` 등에서 `np.abs(window).sum() != window.sum()`, `(np.abs(window)**2).sum() == (window**2).sum()`(제곱은 동일하지만 합 경로가 분기)이라 진폭/PSD 스케일이 틀어짐.
- **수정요지**: `np.abs` 제거 4곳 —
  - `magnitude`: `/ np.abs(window).sum()` → `/ window.sum()`
  - `complex`: `/= np.abs(window).sum()` → `/= window.sum()`
  - psd density 정규화: `/= (np.abs(window)**2).sum()` → `/= (window**2).sum()`
  - psd spectrum 정규화: `/= np.abs(window).sum()**2` → `/= window.sum()**2`

  scipy `_spectral_py`의 `win.sum()`/`(win*win).sum()` 정규화와 일치시키는 변경.

## 검증 (test_patch)

- **FAIL_TO_PASS (12)**: 신규 `TestSpectral::test_psd_window_flattop` — flattop 윈도우(음수 계수 포함)를 직접 구성해 `mlab.psd`를 `scale_by_freq=False`/기본 두 경로로 호출하고, `spec*win.sum()**2 ≈ spec_a*Fs*(win**2).sum()`을 `assert_allclose`로 검증. 12개는 Fs(Fs4/FsAll) × sides(default/onesided/twosided) × dtype(real/complex) 파라미터화 조합.
- **픽스 증명**: 음수 계수 윈도우에서 `np.abs(window).sum()**2 ≠ window.sum()**2`이므로, abs가 남아 있으면 두 스케일 경로가 어긋나 assert 실패. abs 제거 시 두 정규화가 동일 윈도우 합 기반이 되어 등식 성립.
- **기존 테스트 수정**: `test_psd_window_hanning`/`..._detrend_linear`의 control 스케일을 `(np.abs(windowVals)**2).sum()` → `(windowVals**2).sum()`로 미러링 — 테스트 자체가 코드와 같은 abs 버그를 들고 있었음(hann은 양수라 값은 불변, 표현만 정정).
- **overfit 관점**: FAIL_TO_PASS가 flattop 단일 윈도우지만 12 파라미터 조합 + welch 등가식이라 special-case 통과는 어려움. abs를 일부 경로만 제거하는 부분 패치는 magnitude/complex/psd 경로 간 불일치로 다른 조합에서 실패. 단, `(window**2).sum()`는 제곱이라 abs 유무 무관 동일값이므로 그 한 줄만은 cosmetic — 핵심 teeth는 `.sum()`(비제곱) 경로.
- **regression 관점**: 2476 P2P가 양수 윈도우 기반이라 abs 제거가 항등 — 안전. 회귀 위험은 음수 윈도우를 쓰는 숨은 경로뿐인데 그게 바로 이번에 고친 버그.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 `mlab._spectral_helper`와 L423-430을 직접 지목 + scipy 레퍼런스 링크. grep `np.abs(window)` → `lib/matplotlib/mlab.py`의 4개 정규화 사이트로 즉시 수렴(L0).
2. **픽스와 일반화 정당성**: 4곳 모두에서 `np.abs(window)` → `window`. 윈도우 정규화는 부호를 보존하는 윈도우 합/에너지여야 하며(Bendat & Piersol; scipy welch와 동일), 절댓값은 음수 계수 윈도우의 위상 정보를 파괴해 스케일을 부풀린다. 양수 윈도우에서 항등이므로 이는 special-case 땜질이 아니라 모든 윈도우에 옳은 일반화.
3. **regression 안전**: hann/hanning/window_none 등 양수 윈도우 P2P 2476개는 `abs`가 항등이라 불변. magnitude/complex/psd 4경로를 *함께* 고쳐야 경로 간 스케일 일관성이 유지됨(부분 수정 금지).
4. **함정 회피**: (a) `(window**2).sum()` 경로만 보고 "abs 빼도 값 같으니 의미 없다"고 전부 스킵하면 비제곱 `.sum()` 경로의 진짜 버그를 놓침 — 제곱·비제곱 경로를 구분할 것. (b) magnitude 경로(PR #22828)만 고치고 psd 경로를 빠뜨리는 부분 픽스(이슈 댓글이 경고) — psd 정규화 2줄이 핵심. (c) `np.abs(result)`(스펙트럼 크기)는 의도된 것이므로 건드리지 말고, `np.abs(window)`(윈도우 보정)만 제거.
