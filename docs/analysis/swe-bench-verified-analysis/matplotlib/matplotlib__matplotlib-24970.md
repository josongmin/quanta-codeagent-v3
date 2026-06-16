---
instance_id: matplotlib__matplotlib-24970
repo: matplotlib/matplotlib
base_commit: a3011dfd1aaa2487cce8aa7369475533133ef777
version: "3.6"
difficulty: "15 min - 1 hour"
created_at: 2023-01-13T14:23:39Z
fail_to_pass: 1
pass_to_pass: 253
gold_files: [lib/matplotlib/colors.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
NumPy 1.24부터 `plt.get_cmap()(np.empty((0,), dtype=np.uint8))` 같은 호출에서 DeprecationWarning이 다수 발생한다.
범인은 `colors.py`의 `Colormap.__call__`로, 입력 `xa`가 uint8이면 그대로 uint8 dtype을 유지한 채
out-of-range 인덱스 배열에 `self._i_over`(=N+1=257), `self._i_under`(=256), `self._i_bad`(=258) 같은 값을 대입한다.
NumPy 1.24가 "out-of-bound Python integer를 정수 배열에 넣는 것"을 deprecate하면서 경고가 터진다. 기대 동작은 경고 없음.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈 본문과 hints가 `colors.py` 정확한 라인(L730-732)과 `_i_over/_i_under/_i_bad` 대입 지점을 직접 지목한다. 스택 메시지로 단일 함수 `Colormap.__call__`에 바로 수렴 → 거의 L0에 가까운 L1.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 위치는 명확하나 "왜 경고가 나는가"의 불변식을 추론해야 한다. 핵심은 *lookup table은 N+2까지의 인덱스를 담아야 하므로 `xa`는 uint8보다 넓은 정수형이어야 한다*는 타입 불변식. 단순 가드 추가가 아니라, 캐스트 위치를 float 전용 분기 밖으로 끌어내 모든 dtype에 `astype(int)`를 강제하는 의미적 재구성이 필요하다.
- **K (Knowledge) = K-Domain**: colormap의 special-case 인덱싱 규약(처음 N개는 실색, 뒤 3개는 over/under/bad)과 NumPy dtype 승격/errstate 의미를 알아야 올바른 픽스가 나온다.
- **Primary = T-ConstraintReason**: 위치는 쉽지만 핵심이 "캐스트를 언제·어떤 dtype으로 해야 불변식이 성립하는가"의 추론에 있다. S1 템플릿(modulo 트릭, hints의 첫 제안)으로도 경고는 없앨 수 있으나 그건 의미가 깨지는 overfit이고, 메인테이너가 명시적으로 "진짜 버그는 dtype을 넓혀야 한다는 것"이라고 정정했다 → S2가 dominant.

## 난이도 티어
**T3 (중간)**. 구조 피처: 1파일·1함수·실질 1헌크(~11줄 이동)·`has-repro`(재현코드 + 네이티브 deprecation 메시지) → localize는 매우 쉽다. 그러나 픽스가 자명한 가드/상수 변경(S1)이 아니라 dtype 불변식 추론(S2)이고, K-Domain이 끼어 T2에서 한 단계 올라온다.
`regression-trap`: PASS_TO_PASS가 213개로 매우 넓다(colormap reversing 전수, norm 계열, light source 등). 캐스트를 함수 전체로 끌어올리면서 float 경로의 기존 동작(`np.clip`, `xa[xa==N]=N-1`)을 한 톨도 깨지 않아야 한다.
공식 라벨 "15분-1시간"과 일치 — 코드 변경은 작지만 올바른 일반화를 짚는 데 사고가 든다.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/colors.py`, `Colormap.__call__`.
- **근본원인**: float 분기에서만 `xa = xa.astype(int)`를 수행. 입력이 정수형(uint8 등)이면 `xa`가 uint8을 유지 → 뒤이은 `xa[xa > self.N - 1] = self._i_over`(257), `xa[xa < 0] = self._i_under`(256), `xa[mask_bad] = self._i_bad`(258) 대입이 uint8 범위(0-255)를 넘는 정수 삽입이라 NumPy 1.24가 deprecate.
- **수정요지**: (1) float 전용이던 `astype(int)`를 분기 밖으로 이동해 *모든 입력 dtype*에 적용. (2) 이 무조건 캐스트를 `with np.errstate(invalid="ignore")`로 감싸고, 기존 float 전용 연산(`*= self.N`, clip 등)에 걸려있던 errstate는 float 분기 내부로 좁힘. 주석 "We need this cast for unsigned ints as well as floats"가 의도를 못박는다. 결과적으로 인덱스 배열이 항상 충분히 넓은 int가 되어 N+2까지 안전히 담긴다.

## 검증 (test_patch)
신규 `test_index_dtype`가 `@pytest.mark.parametrize("dtype", [np.uint8, int, np.float16, float])`로 `cm(dtype(0)) == cm(0)`을 단언한다.
**FAIL_TO_PASS = `test_index_dtype[uint8]`** 하나. base에서는 uint8 입력이 dtype 미승격으로 over/under/bad 대입 시 경고(미래엔 에러)를 내거나 결과가 어긋나고, 패치 후 무조건 int 캐스트로 `cm(0)`와 동일 결과 → 통과.
**overfit 관점**: FAIL_TO_PASS가 1개로 얇아 보이지만, 같은 테스트의 int/float16/float 변형이 PASS_TO_PASS에 들어가 dtype 일반화를 강제한다(uint8만 특별처리하는 special-case 패치는 float16 등에서 깨질 수 있음). hints의 modulo 제안 같은 overfit 경로를 테스트가 어느 정도 배제.
**regression 관점**: 213 P2P가 colormap 전 표면을 커버 — clip/특수값 경로를 깨면 즉시 적발된다.

## 모범답안 (오라클 기반)
1. **localize**: 재현코드의 deprecation 메시지가 `colors.py:730 xa[xa > self.N - 1] = self._i_over`를 직접 가리킨다 → `Colormap.__call__` 한 함수로 즉시 수렴. `_i_over/_i_under/_i_bad`가 N+1/N+2 범위 값임을 확인.
2. **픽스**: 경고의 진짜 원인은 "대입 라인"이 아니라 *그 위에서 정수 입력이 uint8 dtype을 유지한 채 내려온다*는 것. 따라서 `astype(int)`를 float 분기에서 함수 본체로 끌어올려 모든 dtype을 충분히 넓은 int로 승격. 이것이 올바른 일반화인 이유: lookup table 인덱스 공간은 `[−1, N+2]`이므로 어떤 입력 dtype이든 이 범위를 담는 정수형이어야 한다는 불변식을 직접 만족시키기 때문(메인테이너의 "promote the input data to be bigger than uint8" 정정과 일치).
3. **regression 안전**: float 분기의 `xa *= self.N`, `xa[xa==self.N]=N-1`, `np.clip(xa,-1,N,out=xa)`는 그대로 두고 캐스트만 이동 — float 경로 동작은 byte 동일. errstate를 float 연산엔 유지하되 캐스트 자체도 감싸 unsigned 캐스트 경고도 침묵. 213 P2P(특히 norm/특수값 테스트)가 이 보존을 검증.
4. **함정 회피**: (a) hints 첫 제안인 "modulo 최대값" 트릭은 경고만 지우고 색 의미를 깨는 overfit — 채택 금지. (b) `errstate(invalid="ignore")` 컨텍스트를 통째로 없애면 float 분기에서 다른 invalid 경고가 새로 샌다 — 범위를 float 연산으로 좁히되 제거하지 말 것. (c) uint8만 if-분기로 특수처리하면 float16 등 다른 dtype 변형(P2P)에서 재발하므로, dtype 무관 무조건 캐스트로 가야 한다.
