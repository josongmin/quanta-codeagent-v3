---
instance_id: matplotlib__matplotlib-20488
repo: matplotlib/matplotlib
base_commit: b7ce415c15eb39b026a097a2865da73fbcf15c9c
version: "3.4"
difficulty: "15 min - 1 hour"
created_at: "2021-06-23T03:05:05Z"
fail_to_pass: 1
pass_to_pass: 111
gold_files: [lib/matplotlib/image.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`test_huge_range_log`가 numpy 1.21.0 릴리스 이후 CI에서 `ValueError: Invalid vmin or vmax`로 실패한다. 스택트레이스는 `image.py:542`의 `output = self.norm(resampled_masked)` → `colors.py:1477` LogNorm 변환에서 터지며, 음수/0을 포함하는 데이터에 `LogNorm`을 적용할 때 리샘플링으로 재계산된 `s_vmin`이 0이 되어 `log(0) = -inf`가 되는 것이 원인이다. 기존에는 numpy의 부동소수 동작 차이로 우연히 가려져 있었다.

## 유형 (정형화)
- **L (Localization) = L1**: 네이티브 스택트레이스가 `image.py` 정확한 라인(`_make_image` 내 `self.norm(...)` 호출)을 지목한다. 다만 진짜 결함은 그 호출 직전의 `s_vmin` 클램프 분기라서, 스택 끝 라인이 아니라 직전 `if isinstance(self.norm, mcolors.LogNorm)` 블록까지 짧게 거슬러 올라가야 한다. 핀포인트는 아니나 단일 함수 내 좁은 탐색.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 위치는 거의 자명하지만, "올바른 조건"이 추론을 요한다. 기존 `if s_vmin < 0`는 음수만 막고 **경계값 0을 누락**한다(`log(0)=-inf`도 invalid). 또 `max(s_vmin, eps)`는 0에 대해 `max(0, eps)=eps`라 우연히 맞을 수 있으나, 조건 자체가 0을 안 잡으면 들어오지도 않는다. 정확한 불변식은 "LogNorm에 0 또는 음수를 주지 마라" = `s_vmin <= 0`이고, 그 경우 값을 무조건 `eps`로 치환하는 것.
- **K (Knowledge) = K-Domain**: LogNorm이 `vmin`에 로그를 취한다는 것, eps(`np.finfo(scaled_dtype).eps`)가 양의 최소 표현값이라는 것, 리샘플링이 vmin/vmax를 재계산한다는 matplotlib normalize 파이프라인 지식이 필요.
- **primary = T-ConstraintReason**: 위치는 좁게 수렴되나 픽스의 본질은 경계 조건(`<` → `<=`)을 정확히 합성하는 의미 추론이다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 파일 1개·함수 1개(`_make_image`)·실질 변경 3줄, has-repro(완전한 ValueError 스택트레이스 + 실패 테스트명 명시). 이 신호들은 T2를 가리키지만, 픽스가 단순 가드 추가(S1)가 아니라 기존 조건의 **경계 누락을 진단**해야 하는 S2 추론이라 T3로 올린다. P2P가 113개로 넓어 `regression-trap` — 특히 `test_empty_imshow[LogNorm]`, `test_log_scale_image`, `test_huge_range_log[png-1]`(양수 케이스) 등 LogNorm 인접 동작을 안 깨야 한다. 공식 라벨 "15분-1시간"과 정합적.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/image.py`의 `_make_image`.
- **근본원인**: 리샘플링 후 `s_vmin, s_vmax = vrange`로 재계산된 vmin이 0(또는 음수)일 때 그대로 `LogNorm`에 전달됨. `_trf.transform(0) = log(0) = -inf` → `np.isfinite([t_vmin, t_vmax]).all()` 실패 → `ValueError("Invalid vmin or vmax")`. 기존 가드 `if s_vmin < 0`은 **정확히 0인 경계를 놓침**. numpy 1.21에서 부동소수 재계산 결과가 0으로 떨어지면서 잠재 버그가 표면화.
- **수정요지**: 두 단계 분기를
  ```
  if isinstance(self.norm, mcolors.LogNorm):
      if s_vmin < 0:
          s_vmin = max(s_vmin, np.finfo(scaled_dtype).eps)
  ```
  를
  ```
  if isinstance(self.norm, mcolors.LogNorm) and s_vmin <= 0:
      # Don't give 0 or negative values to LogNorm
      s_vmin = np.finfo(scaled_dtype).eps
  ```
  로 교체. 핵심은 (a) `<` → `<=`로 0 경계 포함, (b) `max(s_vmin, eps)` 대신 무조건 `eps` 대입(음수에서 max는 어차피 eps였고, 이제 조건이 `<=0`이라 들어오는 모든 값이 부적격이므로 단순화).

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_huge_range_log[png--1]` 1개. test_patch는 기존 단일 테스트를 `@pytest.mark.parametrize('x', [-1, 1])`로 확장해 음수 데이터(`x=-1`, 마스크/언더플로우로 vmin→0 유발)와 양수 대범위(`x=1`, 1→1e20) 둘 다 커버. `check_figures_equal`로 LogNorm 결과 figure를 `Normalize`+`set_under('w')` 참조 figure와 픽셀 비교해, 예외 없이 동등 렌더되는지 증명.
- **픽스 증명**: 패치 전에는 `x=-1` 케이스에서 `s_vmin==0`이 LogNorm에 전달되어 ValueError로 draw 단계가 죽음. `<=0` 가드가 `eps`로 치환하면 변환이 유한해져 정상 렌더 → 테스트 통과.
- **overfit/regression**: overfit 위험 낮음 — 픽스가 테스트 입력에 특수화되지 않고 "LogNorm vmin ≤ 0 → eps"라는 일반 불변식. `x=1`(양수) 케이스가 PASS_TO_PASS(`[png-1]`)로 남아, 가드 조건이 양수 vmin을 잘못 건드리지 않음을 paired-control로 보증. 113개 P2P가 인접 image/norm 동작 regression을 차단.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 스택트레이스가 `image.py:_make_image` → `self.norm(resampled_masked)` → `colors.py` LogNorm `transform`을 직접 준다. "Invalid vmin or vmax"는 LogNorm이 비유한 변환값을 만났다는 뜻이므로, norm 호출 직전 vmin/vmax를 만지는 `if isinstance(self.norm, mcolors.LogNorm)` 분기로 즉시 수렴.
2. **픽스와 일반화**: `log(x)`는 `x<=0`에서 비유한(음수=NaN, 0=-inf)이라는 도메인 사실에서 출발해, 가드 조건이 `< 0`이 아니라 `<= 0`이어야 함을 도출. 0 경계 누락이 정확한 근본원인. 모든 부적격 입력을 양의 최소값 `eps`로 끌어올리는 것이 올바른 일반화(특정 데이터 의존 없음).
3. **regression 안전**: 양수 vmin(`test_huge_range_log[png-1]`, `test_log_scale_image`, `test_empty_imshow[LogNorm]`)은 가드에 안 걸려 byte-identical하게 동작해야 함. 조건을 `<=0`으로 좁게 유지하고 분기 밖 경로를 안 건드리는 것이 안전.
4. **함정 회피**: (a) numpy 변경이 원인이라는 힌트에 끌려 `colors.py` LogNorm 자체를 고치려 하면 광범위 regression을 유발 — 진짜 fix-site는 호출측 `image.py`. (b) `< 0`을 그대로 두고 `max(s_vmin, eps)`만 만지면 0 케이스는 조건에 안 들어와 여전히 실패(인과 역전 함정). 조건의 **경계**가 결함임을 반드시 인지해야 함. (c) `<` 대신 `< eps` 같은 임의 임계값 도입은 불필요한 휴리스틱 — 정확한 수학적 경계는 0이다.
