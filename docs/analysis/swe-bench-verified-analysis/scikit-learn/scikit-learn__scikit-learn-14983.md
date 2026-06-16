---
instance_id: scikit-learn__scikit-learn-14983
repo: scikit-learn/scikit-learn
base_commit: 06632c0d185128a53c57ccc73b25b6408e90bb89
version: "0.22"
difficulty: "<15 min fix"
created_at: 2019-09-14T15:31:18Z
fail_to_pass: 2
pass_to_pass: 105
gold_files: [sklearn/model_selection/_split.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약

`RepeatedKFold`, `RepeatedStratifiedKFold`의 `repr()`이 파라미터 문자열(`RepeatedKFold(n_splits=5, n_repeats=10, random_state=None)`) 대신 기본 객체 주소(`<...RepeatedKFold object at 0x...>`)를 출력한다. 두 클래스의 공통 부모 `_RepeatedSplits`에 `__repr__`가 정의돼 있지 않아 `object.__repr__`로 폴백되기 때문이다. 단순히 `__repr__`만 추가하면 `n_splits`가 클래스 직접 속성이 아니라 `cvargs`에 저장돼 있어 `None`으로 출력되는 2차 결함이 드러난다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈가 클래스명 `RepeatedKFold`/`RepeatedStratifiedKFold`와 `__repr__` 동작을 직접 지목하지만, 실제 수정 지점은 부모 `_RepeatedSplits`와 공유 헬퍼 `_build_repr`로 한 단계 추적이 필요. grep "한 방"은 아니고 상속/위임 구조를 읽어야 함 → L1.
- **S2 (+S1)**: `__repr__` 추가 자체는 기계적(S1, 부모에 메서드 한 줄). 그러나 핵심 결함은 `_build_repr`가 `getattr(self, key, None)`만 보고 `n_splits`를 못 찾는 것 — `cvargs` 폴백 조건을 **추론으로 합성**해야 정답이 됨(S2). hints에 적힌 1차 픽스로는 `n_splits=None` 회귀가 생기는 게 결정적 신호.
- **K-Domain**: `_RepeatedSplits`가 `cv`/`n_repeats`/`random_state`만 속성으로 두고 `n_splits` 같은 하위 CV 인자를 `**cvargs`로 흡수하는 sklearn 내부 파라미터 저장 규약을 알아야 폴백 위치를 짚음.
- **primary = T-ConstraintReason**: 위치는 비교적 명확하나, 올바른 픽스는 "`value is None and hasattr(self,'cvargs')`일 때 `cvargs.get(key)`로 대체"라는 조건식을 불변식(파라미터는 속성 또는 cvargs 둘 중 하나에 있다) 추론으로 짜야 하므로 S2 기반 ConstraintReason.

## 난이도 티어

- **파일 1개 / +5줄 / 2 헌크**: 구조적으로 매우 작음(부모에 `__repr__` 3줄 + `_build_repr`에 폴백 2줄).
- **localize 직접성**: 중간. 이슈가 증상은 명확히 주지만, 진짜 버그는 hints에서 드러나듯 `_build_repr`의 `getattr` 한계라 한 겹 더 들어가야 함.
- **has-repro**: `repr(RepeatedKFold())` 재현 코드가 본문에 있어 easiness 강함.
- **P2P trap 약함**: 109개 P2P 중 `test_build_repr`만 직접 인접 — `_build_repr` 변경이 다른 추정기(`getattr` 정상 작동 클래스)에 영향 없어야 함. 폴백이 `value is None`에서만 발동하므로 trap 좁음.
- 공식 라벨 `<15 min fix`와 일치하나, 1차(naive) 픽스로는 통과 못 하는 2단 구조 때문에 T1(존나쉬움)이 아니라 **T2**. 약한 엣지추론(cvargs 폴백)이 T2의 전형.

## 골드패치 분석

- **파일**: `sklearn/model_selection/_split.py` (단일).
- **헌크 1 — `_RepeatedSplits`에 `__repr__` 추가**:
  ```python
  def __repr__(self):
      return _build_repr(self)
  ```
  `RepeatedKFold`/`RepeatedStratifiedKFold`가 상속하므로 둘 다 한 번에 커버.
- **헌크 2 — `_build_repr` 폴백**:
  ```python
  value = getattr(self, key, None)
  if value is None and hasattr(self, 'cvargs'):
      value = self.cvargs.get(key, None)
  ```
- **근본원인**: (1) `_RepeatedSplits`에 `__repr__` 부재 → `object.__repr__` 폴백. (2) `_RepeatedSplits.__init__`이 `cv, n_repeats, random_state, **cvargs` 시그니처라 `n_splits`가 `self`의 직접 속성이 아니라 `self.cvargs`에 저장됨 → `_build_repr`의 `getattr(self,'n_splits',None)`이 `None` 반환.
- **수정요지**: 부모에 위임형 `__repr__`를 달고, 공유 헬퍼가 직접 속성에서 못 찾으면 `cvargs`에서 보충하도록 하여 `n_splits=2` 같은 값이 정상 출력되게 함.

## 검증 (test_patch)

- **FAIL_TO_PASS (2)**: `test_repeated_cv_repr[RepeatedKFold]`, `[RepeatedStratifiedKFold]`. `n_splits=2, n_repeats=6`로 생성 후 `repr(repeated_cv)`가 정확히 `'{cls}(n_repeats=6, n_splits=2, random_state=None)'`와 일치하는지 단언.
- **픽스 증명**: 헌크1 없으면 객체 주소 문자열이라 불일치 → 실패. 헌크1만 있고 헌크2 없으면 `n_splits=None`으로 렌더돼 기대 문자열과 불일치 → 여전히 실패. 두 헌크 모두 있어야 `n_splits=2`가 채워져 통과. 즉 테스트가 2단 결함을 둘 다 강제.
- **overfit 관점**: `n_repeats`(직접 속성)와 `n_splits`(cvargs)를 한 케이스에서 동시에 검증하므로 `getattr`/`cvargs` 두 경로를 모두 밟음. 다만 `random_state=None`만 테스트해 비-None random_state 렌더는 미검증(얇은 면 존재하나 동일 코드경로라 위험 낮음).
- **regression 관점**: `test_build_repr`(P2P)가 기존 `_build_repr` 정상 동작을 가드. 폴백이 `value is None and hasattr(self,'cvargs')` 조건부라 `cvargs` 없는 일반 추정기는 분기 미진입 → 회귀 없음.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "`__repr__` 틀림 + 두 클래스 모두" 신호 → `_split.py`에서 두 클래스를 grep → 공통 부모 `_RepeatedSplits`에 `__repr__`가 없음을 확인. 동일 모듈의 다른 CV가 쓰는 `_build_repr` 헬퍼가 repr 생성 SSOT임을 파악.
2. **픽스 & 일반화 근거**: 부모에 `__repr__ = _build_repr(self)` 위임을 추가(자식 둘 다 자동 커버 = 올바른 추상화 레벨). 이어 `_build_repr`가 `n_splits`를 못 찾는 이유 = `__init__`이 `**cvargs`로 흡수하기 때문임을 추적하고, "파라미터는 직접 속성 또는 cvargs 둘 중 하나"라는 불변식에 따라 `value is None`일 때 `self.cvargs.get(key)`로 폴백. 특정 키(`n_splits`) 하드코딩이 아니라 일반 폴백이라 overfit이 아닌 일반화.
3. **regression 안전**: 폴백을 `hasattr(self,'cvargs')` 가드 + `value is None` 조건으로 좁혀, `cvargs` 없는 모든 추정기의 기존 repr(=`test_build_repr`)을 바이트 동일로 보존. 109개 P2P(주로 split 동작) 미접촉.
4. **함정 회피**: 오라클 없는 에이전트가 hints의 **1차 픽스(`__repr__`만)만** 적용하면 `n_splits=None`으로 렌더돼 테스트가 여전히 빨갛게 남음 — 여기서 멈추면 오답. 핵심은 repr 출력을 실제로 한 번 찍어 `None`을 눈으로 확인하고, 값의 출처가 `cvargs`임을 역추적해 `_build_repr`까지 2차 수정하는 것. 또 `__repr__`를 부모가 아닌 두 자식에 각각 복붙하면 동작은 같아도 DRY 위반/누락 위험 — 부모 위임이 정석.
