---
instance_id: matplotlib__matplotlib-24870
repo: matplotlib/matplotlib
base_commit: 6091437be9776139d3672cde28a19cbe6c09dcd5
version: "3.6"
difficulty: "15 min - 1 hour"
created_at: "2023-01-02T20:37:49Z"
fail_to_pass: 1
pass_to_pass: 65
gold_files: [lib/matplotlib/contour.py, lib/matplotlib/tri/_tricontour.py]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, underspecified]
---

## 문제 요약
`plt.contour(boolean_2d_array)`를 levels 지정 없이 호출하면 기본 8레벨(0, 0.15, ..., 1.05)이 0~1 구간에 몰려 모든 등고선이 겹쳐 그려진다. bool 입력은 의미상 True/False 경계 하나만 그리면 충분하므로, 레벨을 자동으로 `[0.5]`(line) / `[0, .5, 1]`(filled)로 잡아달라는 기능 요청(ENH)이다. tricontour/tricontourf도 같은 처리가 필요하고, hints에서 contourf의 "at least 2 levels" 에러까지 같이 해결하기로 합의됐다.

## 유형 (정형화)
- **L (Localization) = L3.** 픽스가 `contour.py`의 세 메서드(`_process_contour_level_args`, `_contour_args`, `_check_xyz`)와 별도 파일 `tri/_tricontour.py::_contour_args`에 **조율되어 함께** 바뀌어야 한다. 단순히 레벨 분기 한 곳을 고치는 게 아니라, z의 dtype을 레벨 결정 함수까지 **전파**시켜야 하므로 multi-site.
- **S (Repair Strategy) = S5 (+S6).** 이슈는 "bool이면 `[0.5]`"라는 의도만 줄 뿐, contourf의 `[0, .5, 1]`이나 dtype 보존 메커니즘은 코드/관례에서 **스펙을 재구성**해야 한다(S5). 그리고 dtype 정보를 `_process_contour_level_args(args, z_dtype)`로 넘기는 **시그니처 도입 + 위치인자 언패킹 재배치**라는 작은 구조 변경이 필수라 S6 보조.
- **K (Knowledge) = K-Domain.** contour 파이프라인 내부(z가 어디서 `np.float64`로 강제되는지, masked array 처리, filled vs line 레벨 규약)를 알아야 한다. matplotlib 프레임워크 지식 의존.
- **Primary = T-SpecInference.** 핵심 난점은 "어떻게 고치나"가 아니라 "bool일 때 올바른 레벨 규약이 무엇인가"를 이슈/도메인 관례에서 추론해 명세화하는 것. 따라서 SpecRover 계열 spec-inference가 dominant.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 "15분-1시간"으로 비교적 쉽지만, 구조 피처가 T3보다 위로 민다:
- **파일수 2 + 함수 4개** 수정, 줄 변경은 작아도 **cross-file 조율**(contour.py ↔ _tricontour.py)이 필수 → L3.
- **localize 직접성 낮음:** 진짜 함정은 레벨 분기가 아니라 `ma.asarray(..., dtype=np.float64)`가 bool을 미리 float로 뭉개버린다는 점. 이걸 못 찾으면 분기를 추가해도 dtype이 항상 float64라 영원히 안 걸린다(데이터플로우 추적 필요).
- **P2P trap 넓음(65개):** 기존 `_check_xyz(args, kwargs)` / `_contour_args` 위치인자 처리를 재배치하므로 shape 검증·에러메시지 테스트 다수를 깨면 안 됨 → regression-trap.
- has-repro는 있으나(이슈에 재현코드+그림) 그건 "bool이 겹친다"만 보여줄 뿐 dtype 강제 원인을 가리키지 않음. 그래서 T5까지는 아니나 T3보다 확실히 어렵다.

## 골드패치 분석
**건드린 파일·함수**
- `lib/matplotlib/contour.py`: `_process_contour_level_args(self, args)` → `(self, args, z_dtype)`; `_contour_args`; `_check_xyz(self, args, kwargs)` → `(self, x, y, z, kwargs)`.
- `lib/matplotlib/tri/_tricontour.py`: `_contour_args`.

**근본원인** — 두 겹이다. (1) 레벨 자동결정부에 bool 분기가 아예 없음. (2) 설령 분기를 넣어도 `_contour_args`/`_check_xyz`가 z를 `ma.asarray(args[0], dtype=np.float64)`로 **무조건 float64 캐스팅**해서 bool dtype 정보가 레벨 결정 시점 이전에 소실된다.

**수정요지**
- `_contour_args`에서 `z = ma.asarray(z)`(dtype 강제 제거)로 바꿔 z의 원래 dtype을 살리고, `z.dtype`을 `_process_contour_level_args(args, z.dtype)`로 전달.
- `_process_contour_level_args`에서 명시 args가 없을 때 `np.issubdtype(z_dtype, bool)`이면 `self.filled` 여부에 따라 `[0, .5, 1]`(filled) 또는 `[.5]`(line), 아니면 기존 기본값 `7`.
- `_check_xyz`도 z를 float 강제하지 않도록 `ma.asarray(z)`로 바꾸고, 위치인자(`x, y, z`)를 직접 받도록 시그니처/언패킹 정리(`z, *args = args` 패턴).
- `_tricontour.py`도 동일하게 `z.dtype` 전달 + `z, *args = args`로 일치시킴.

## 검증 (test_patch)
**FAIL_TO_PASS = `test_bool_autolevel` (1개).** bool 입력(list, ndarray, masked array)에 대해 `plt.contour(...).levels == [.5]`, `plt.contourf(...).levels == [0, .5, 1]`, 그리고 `tricontour`/`tricontourf`도 동일하게 검증한다.
- **픽스 증명:** 세 입력형태(plain list/ndarray/masked) 모두 통과시키려면 dtype이 레벨 결정 지점까지 보존돼야 하므로, float 강제 제거 + dtype 전파가 둘 다 됐음을 입증한다. line/filled 분기도 양쪽 다 본다.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇아 보이나, 테스트가 line×filled × {list, ndarray, masked} × {contour, tricontour}를 곱으로 덮어 special-case 구현으로는 통과 어렵다. 다만 정수 dtype, object dtype 등은 미검증이라 `np.issubdtype(z_dtype, bool)` 정확 매칭 외 일반화는 검증 공백.
- **regression 관점:** 65개 P2P가 shape 검증/에러문구/`_check_xyz` 동작을 고정한다. 시그니처를 위치인자로 바꾸면서 이들을 안 깨야 하는 게 픽스의 진짜 비용이다.

## 모범답안 (오라클 기반)
1. **localize 경로.** 이슈의 "기본 8레벨이 0~1에 몰린다" → 레벨 자동결정 함수 `_process_contour_level_args`의 `levels_arg = 7` 분기를 찾는다(grep `Default, hard-wired`). 그러나 거기서 멈추면 안 되고, z가 그 함수까지 어떤 dtype으로 도달하는지 역추적 → `_contour_args`/`_check_xyz`의 `ma.asarray(..., dtype=np.float64)`가 bool을 죽이는 지점을 반드시 함께 식별.
2. **픽스와 일반화.** bool 분기를 `levels_arg=7` 자리에 추가하되, 그 분기가 실제로 트리거되려면 dtype 강제를 제거하고 `z.dtype`을 인자로 흘려야 한다. `np.issubdtype(z_dtype, bool)`은 list/ndarray/masked 모두에 robust하므로 올바른 일반화(특정 입력형태에 묶이지 않음). filled은 contourf가 ≥2 레벨을 요구하므로 `[0,.5,1]`, line은 `[.5]` — 이는 도메인 규약 추론 결과.
3. **regression 안전.** `_check_xyz`/`_contour_args`의 위치인자 재배치는 비-bool 경로에서 기존과 byte-identical 동작이어야 한다. `dtype=np.float64` 제거가 비-bool 입력의 후속 연산(masked_invalid, min/max)을 바꾸지 않는지 확인 — float/int 입력은 이후 산술에서 자연 승격되므로 안전. 65 P2P(shape error 문구, Nlevels, uniform_z 등)를 전부 통과시켜야 한다.
4. **함정 회피.** 오라클 없는 에이전트의 전형 실패: (a) `_process_contour_level_args`에만 bool 분기를 넣고 dtype 강제 제거를 빠뜨려 분기가 **죽은 코드**가 되는 것(테스트 영원히 fail). (b) tricontour 쪽을 잊어 절반만 통과. (c) 시그니처 변경 시 `_check_xyz` 호출부(`_contour_args` 내)를 안 맞춰 P2P shape 테스트 회귀. (d) filled에 `[.5]` 단일레벨을 줘 "at least 2 levels" 에러 재발. dtype 전파를 1번에서 같이 잡고 두 파일을 짝으로 수정하면 모두 회피된다.
