---
instance_id: astropy__astropy-13579
repo: astropy/astropy
base_commit: 0df94ff7097961e92fd7812036a24b145bc13ca8
version: "5.0"
difficulty: "1-4 hours"
created_at: 2022-08-26T15:06:53Z
fail_to_pass: 1
pass_to_pass: 40
gold_files: [astropy/wcs/wcsapi/wrappers/sliced_wcs.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap, overfit-risk]
---

## 문제 요약
3D WCS(공간·공간·파장)에서 PCij 행렬이 분광-공간 축을 커플링하는 경우, `SlicedLowLevelWCS`로 파장 한 슬라이스를 잘라낸 뒤 `world_to_pixel`을 호출하면 한 픽셀 축이 사실상 무한대(~1.8e11)로 나오는 버그. 같은 WCS의 `pixel_to_world`와 unsliced `world_to_pixel`은 정상이다. 이슈 작성자가 재현 스크립트와 함께 정확한 결함 라인(`sliced_wcs.py` L253-254)까지 지목했다.

## 유형 (정형화)
- **L0 (Localization)**: hints_text가 GitHub permalink로 `world_to_pixel_values` 내부 `world_arrays_new.append(1.)` 라인을 직접 지목. grep 한 방. 탐색 비용 거의 0.
- **S2 (Repair Strategy)**: 고칠 지점은 명백하지만 "1." 대신 무엇을 넣어야 하는지는 **역변환 불변식을 추론**해야 한다. 단순 상수 교체(S1)가 아니라, 잘려나간(sliced-out) world 축에 대해 슬라이스 위치에 해당하는 *실제 world 좌표*를 합성해야 inverse transform이 일관되게 동작한다. 커플링된 PC 행렬에서는 dropped 축 값이 kept 축의 픽셀 매핑에 영향을 주므로 임의 상수(1.)는 틀린 가정. 이것이 Constraint-Reasoning의 핵심.
- **K-Domain (Knowledge)**: WCS APIs(`world_n_dim`, `_world_keep`, `_pixel_keep`, `_pixel_to_world_values_all`)와 FITS WCS의 PCij 커플링 의미를 알아야 올바른 보정값을 도출 가능. 순수 파이썬 추론만으론 "왜 1.이 틀렸나"를 못 짚음.
- **primary = T-ConstraintReason**: 위치는 자명(L0)하나 올바른 식(슬라이스된 축의 world 좌표)을 의미 불변식으로 합성해야 하므로 S2 dominant. S1로 보이지만 정답이 상수가 아니라 계산된 텐서라 기계적 매핑 불가.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처:
- 파일 1개, 골드 헌크 2개(+1줄 삽입, 1줄 교체) — scope는 작음 → 하방 압력.
- has-repro: 재현 스크립트 + 결함 라인 지목 → 강한 easiness 신호 → 하방 압력.
- 그러나 **S2 추론 난도**가 상방: dropped 축에 실제 world 좌표를 역으로 끌어와야 한다는 발상은 도메인 불변식 이해 없이는 안 나옴. `self._pixel_to_world_values_all(*[0]*len(self._pixel_keep))`로 슬라이스 기준 픽셀의 world 좌표를 재구성하는 부분이 비자명.
- regression-trap: P2P 40개(슬라이싱 전 영역) — 기존 `world_to_pixel`/`pixel_to_world` 동작을 깨면 안 됨.
- 공식 라벨 "1-4 hours"와 일치. localize는 0이지만 fix 합성과 회귀 안전이 시간을 먹는 전형적 T4.

## 골드패치 분석
- **파일/함수**: `astropy/wcs/wcsapi/wrappers/sliced_wcs.py`의 `SlicedLowLevelWCS.world_to_pixel_values`.
- **근본원인**: dropped(슬라이스로 제거된) world 축의 입력값을 하드코딩 `1.`로 채웠다. unsliced WCS는 모든 world 축을 받지만 sliced WCS는 kept 축만 받으므로, 빠진 축을 채워 전체 `self._wcs.world_to_pixel_values`로 위임해야 한다. PC 행렬이 축을 커플링하면 dropped 축 값이 kept 축의 픽셀 결과에 섞여 들어가는데, 잘못된 상수 `1.`이 거대한 오차를 만든다.
- **수정요지**: 함수 진입부에 `sliced_out_world_coords = self._pixel_to_world_values_all(*[0]*len(self._pixel_keep))`를 추가 — 슬라이스가 고정한 픽셀(0 origin)에 해당하는 *전체 world 좌표*를 미리 계산. 그리고 dropped 축 채움을 `world_arrays_new.append(1.)` → `world_arrays_new.append(sliced_out_world_coords[iworld])`로 교체. 즉 빠진 축에 "이 슬라이스가 실제로 위치한 world 좌표"를 넣어 역변환을 일관되게 만든다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_coupled_world_slicing`. `COUPLED_WCS_HEADER`(이슈의 커플링 PC 행렬 그대로)로 WCS 생성 → `SlicedLowLevelWCS(fits_wcs, 0)` → `fits_wcs.pixel_to_world_values(0,0,0)`로 얻은 world를 sliced `world_to_pixel_values`에 역투입 → `np.allclose(out_pix[0], 0)`을 단언. 버그 상태에서 `out_pix[0]`은 ~1.8e11이라 실패, 픽스 후 0 근처로 통과.
- **픽스 증명**: 슬라이스가 픽셀 0에서 잘렸으므로 dropped 축의 올바른 world 값 = `pixel_to_world(0,...)`의 해당 성분. 골드가 정확히 그 값을 채워 inverse round-trip이 닫힘.
- **overfit/regression**:
  - overfit-risk(flag): FAIL_TO_PASS가 단 1개이고 슬라이스 인덱스 0 + 특정 커플링 헤더만 검증. 비-0 슬라이스 start나 다축 슬라이싱은 직접 안 짚음. 다만 골드는 `[0]*len(self._pixel_keep)` 일반식이라 origin 픽셀 가정 외에는 일반화됨(special-case 하드코딩 아님).
  - regression: P2P 40개(`test_spectral_slice`, `test_celestial_slice`, `test_world_to_pixel_broadcasting`, `test_dropped_dimensions*` 등)가 비커플링/브로드캐스트/중첩 슬라이싱을 커버. 커플링 없는 케이스에선 dropped 축 값이 결과에 영향 없으므로 `1.`→실값 교체가 안전하게 무해.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 permalink로 `sliced_wcs.py` L253-254를 직접 지목. `world_to_pixel_values`의 `else: world_arrays_new.append(1.)`가 유일 후보. 추가 탐색 불필요.
2. **픽스와 일반화**: `1.`은 "dropped 축은 결과에 안 섞인다"는 암묵 가정인데 PC 커플링에선 거짓. 올바른 채움값은 *슬라이스가 고정한 픽셀에 대응하는 world 좌표*다. `self._pixel_to_world_values_all(*[0]*len(self._pixel_keep))`로 전체 world 벡터를 한 번 구해 `sliced_out_world_coords[iworld]`로 각 dropped 축을 채우면, 커플링 유무와 무관하게 inverse transform이 forward와 정합. 상수가 아닌 계산식이라 overfit이 아닌 올바른 일반화.
3. **regression 안전**: 비커플링 WCS에서는 dropped 축 값이 kept 픽셀에 영향 없어 `1.`이든 실값이든 동일 결과 → P2P 40개(특히 `test_spectral_slice`/`test_celestial_slice`/broadcasting/nested)가 모두 보존. 새 호출 `_pixel_to_world_values_all`은 기존 메서드 재사용이라 부작용 없음.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `1.`을 다른 임의 상수(0. 등)로 바꿔 비커플링 테스트만 통과시키는 special-case 함정에 빠지기 쉽다 — `test_coupled_world_slicing`이 이를 적발. (b) dropped 축 채움을 잊고 kept 축만 넘기면 `self._wcs.world_to_pixel_values` 차원 불일치. (c) `[0]*len(self._pixel_keep)` 대신 잘못된 길이/축순서를 쓰면 broadcasting 깨짐. 핵심 통찰은 "dropped 축 = 슬라이스 위치의 실제 world 좌표"라는 도메인 불변식이며, 이를 못 잡으면 plausible-but-wrong 패치로 귀결.
