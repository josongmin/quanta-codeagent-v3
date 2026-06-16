---
instance_id: pydata__xarray-4966
repo: pydata/xarray
base_commit: 37522e991a32ee3c0ad1a5ff8afe8e3eb1885550
version: "0.12"
difficulty: "15 min - 1 hour"
created_at: 2021-02-26T12:05:51Z
fail_to_pass: 4
pass_to_pass: 21
gold_files: [xarray/coding/variables.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap]
---

## 문제 요약
netCDF3는 signed byte만 알기에 `_Unsigned="true"` 속성으로 unsigned를 저장하는 관례가 있고, xarray는 이를 `UnsignedIntegerCoder.decode`에서 처리한다. 반대로 OPeNDAP/pydap은 unsigned byte만 알아서 `_Unsigned="false"` 속성으로 signed를 저장하는 "hack"(netCDF-c thredds)이 존재하는데, 이 대칭 케이스는 xarray가 처리하지 못해 unsigned 데이터를 그대로 반환하고 SerializationWarning만 낸다. 결과적으로 `engine="netcdf4"`는 `-128` 같은 음수를, `engine="pydap"`은 `128/255` 같은 양수를 돌려주는 불일치가 발생한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 본문이 수정 위치를 `xarray/coding/variables.py#L311`로 직접 링크하고, 고칠 조건(`if .kind == "u" and unsigned == False`)까지 명시한다. grep 한 방.
- **S2 (Constraint-Reasoning)**: 위치는 자명하나, 올바른 픽스는 기존 `kind == "i"` / `unsigned == "true"` 경로의 **대칭 역연산**을 추론해야 한다. unsigned→signed 캐스팅 dtype(`i%s % itemsize`), lazy transform, `_FillValue` 재캐스팅까지 의미적으로 거울처럼 구성해야 한다. 상수 한 줄이 아니라 "올바른 식"을 합성하는 것이라 S1이 아님.
- **K-Domain**: numpy dtype kind 코드(`u`/`i`), netCDF `_Unsigned` 관례, xarray의 lazy decoding seam(`lazy_elemwise_func`) 등 프레임워크/포맷 도메인 지식이 픽스 정확도를 지배한다.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하지만 난점이 "올바른 대칭 변환식 추론"(S2)에 있으므로 T-DirectMap이 아닌 T-ConstraintReason. APR 관점: 기존 분기를 angelic spec(=existing `"true"` branch)으로 삼아 그 역방향을 합성하는 SemFix류 추론.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·1함수(`decode`)·+8줄 단일 헌크, localize는 L0로 거의 공짜, 하지만 픽스는 기계적 가드가 아니라 대칭 변환 로직 합성을 요구한다. P2P 21개 중 `test_decode_unsigned_from_signed[1/2/4/8]`가 포함돼 **기존 `kind=="i"` 경로를 깨지 않아야 하는 regression-trap**이 명확히 존재(새 `elif` 추가로 기존 `if`를 건드리지 않는 것이 핵심). 재현 코드는 있으나 원격 OPeNDAP URL이라 로컬 재현 불가(has-repro로 보긴 약함). 공식 라벨 "15min-1h"와 일치 — localize 비용 0 + 단일헌크라 T2에 가깝지만, 변환식 추론과 dtype/FillValue 대칭성을 정확히 맞춰야 하는 도메인 부담이 T3로 민다.

## 골드패치 분석
- **파일·함수**: `xarray/coding/variables.py` → `UnsignedIntegerCoder.decode`
- **근본원인**: `decode`가 `data.dtype.kind == "i"`(signed 저장) + `unsigned == "true"` 케이스만 unsigned로 승격하고, 그 역(unsigned 저장 + `_Unsigned="false"` → signed로 강등)은 미처리. 따라서 `else` 가지로 빠져 경고만 내고 원본 unsigned 값을 그대로 반환.
- **수정요지**: 기존 `if data.dtype.kind == "i":` 블록 뒤에 `elif data.dtype.kind == "u":` 분기를 추가. `unsigned == "false"`이면 `signed_dtype = np.dtype("i%s" % data.dtype.itemsize)`로 만들고 `partial(np.asarray, dtype=signed_dtype)` transform을 `lazy_elemwise_func`로 적용, `_FillValue`도 `signed_dtype.type(...)`으로 재캐스팅. 즉 encode 측 `"true"` 경로와 decode 측 `"i"` 경로를 거울대칭으로 보완.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_decode_signed_from_unsigned[1,2,4,8]` — `i{bits}`로 만든 `-1`을 `u{bits}`로 astype해 `_Unsigned="false"`를 붙인 Variable을 `decode`하면, 결과 dtype이 `signed_dtype`이고 값이 원래 `-1`로 복원되는지 검증. 픽스 전엔 `else` 경고 분기로 빠져 unsigned 값(`max`)이 남으므로 실패, 픽스 후 새 `elif`가 signed 복원.
- **픽스 증명**: bits=1/2/4/8 전 너비를 파라미터화해 `itemsize` 기반 dtype 생성이 8/16/32/64bit 모두에서 맞는지 확인 → 특정 너비 하드코딩 overfit을 차단.
- **overfit·regression**: P2P에 대칭 짝인 `test_decode_unsigned_from_signed[*]`가 그대로 살아 있어 기존 `kind=="i"` 경로 불변을 강제 → `elif`로 추가했기에 회귀 없음. overfit 위험 낮음(전 dtype 너비 + 대칭 양방향 테스트가 일반화를 묶음).

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `variables.py#L311`과 조건식 `.kind == "u" and unsigned == False`를 직접 주므로 `UnsignedIntegerCoder.decode`로 즉시 수렴. 기존 `if data.dtype.kind == "i": if unsigned == "true":` 블록을 reference 패턴으로 읽는다.
2. **픽스/일반화**: 기존 signed→unsigned 경로의 **역연산**을 대칭 추가. `else`(경고)를 건드리지 말고 그 앞에 `elif data.dtype.kind == "u":`를 끼워 `unsigned == "false"`만 처리. dtype은 너비 보존을 위해 `"i%s" % data.dtype.itemsize`로 동적 생성(상수 `i1` 하드코딩 금지) → 이게 1/2/4/8byte 전부에 일반화되는 이유. `_FillValue` 재캐스팅과 `lazy_elemwise_func` 사용도 기존 경로와 동일하게 맞춰 lazy/dask 호환 유지.
3. **regression 안전**: `test_decode_unsigned_from_signed[*]`(P2P)와 `test_scaling_converts_to_float32[i1/i2/u1/u2]`를 깨지 않아야 한다. 기존 `if` 블록을 수정하지 않고 `elif`로만 확장하므로 signed-저장 경로와 비-_Unsigned 경로가 그대로 유지된다.
4. **함정 회피**: (a) 기존 `if`를 `if unsigned in ("true","false")`로 합쳐 리팩터하려다 `kind=="i"`/`kind=="u"`별 dtype 방향(i↔u)을 뒤집는 실수 — 방향이 정반대라 분리 분기가 맞다. (b) `else` 경고 가지를 제거/이동해 비정수 타입 경고가 사라지는 회귀. (c) dtype을 `"i1"`로 하드코딩해 bits=2/4/8에서 너비 손실. (d) eager `astype`을 써서 lazy 경로를 깨는 것 — encode 측은 `around(...).astype`이지만 decode 측은 `lazy_elemwise_func`라는 비대칭을 인지해야 한다.
