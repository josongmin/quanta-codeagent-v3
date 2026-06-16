---
instance_id: matplotlib__matplotlib-22865
repo: matplotlib/matplotlib
base_commit: c6c7ec1978c22ae2c704555a873d0ec6e1e2eaa8
version: "3.5"
difficulty: "15 min - 1 hour"
created_at: "2022-04-20T15:15:11Z"
fail_to_pass: 3
pass_to_pass: 57
gold_files: [lib/matplotlib/colorbar.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`drawedges=True`인 colorbar는 색 경계마다 검은 구분선을 그린다. 그러나 `extend='both'`(또는 `'min'`/`'max'`)로 colorbar 끝을 삼각형으로 확장하면, 확장된 양 끝(extremity)의 구분선이 그려지지 않는다. 재현 코드가 명확히 제공되어 있고, actual/expected 이미지로 증상이 시각적으로 특정된다. 핵심은 구분선 segment 배열을 자를 때 양 끝을 무조건 잘라내(`[1:-1]`) extend 영역의 경계선을 누락시키는 것이다.

## 유형 (정형화)

- **L (Localization) = L1**: 이슈가 심볼을 직접 지목하진 않지만 "drawedges", "colorbar", "extend" 키워드가 `colorbar.py`의 단일 메서드 `_add_solids`로 빠르게 수렴한다. `self.dividers.set_segments(...)`가 구분선을 만드는 유일한 지점이라 grep으로 좁은 단일 후보가 나온다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 줄은 명확하나, 올바른 슬라이스 경계를 `extend` 상태에 따라 추론·합성해야 한다. 무조건 `[1:-1]`이 아니라 "하단 확장이면 0부터, 아니면 1부터 / 상단 확장이면 끝까지(`len(X)`), 아니면 -1까지"라는 조건식을 불변식(양 끝 확장 여부 ↔ 경계선 존재 여부)으로 도출하는 것이 본질. 후보를 마구 던지는 G&V가 아니라 케이스 분석으로 푼다.
- **K (Knowledge) = K-Domain**: `_extend_lower()`/`_extend_upper()`가 어떤 의미인지, `X`/`Y`의 길이가 extend 영역을 포함해 어떻게 늘어나는지 같은 colorbar 내부 좌표 모델 지식이 필요하다.
- **primary = T-ConstraintReason**: 위치는 거의 자명하나 난점이 "올바른 조건식 합성"에 있으므로 S2 기반 T-ConstraintReason이 dominant.

## 난이도 티어

**T3 (중간)**. 구조적 피처: 파일 1개·함수 1개·실질 변경 ~6줄로 scope는 작다(1파일·<5줄 컷에 근접). has-repro라 재현·검증 신호가 강하다(easiness 신호). 그러나 단순 None-가드/상수변경이 아니라 4-케이스(both/min/max/neither) 경계 추론을 정확히 맞춰야 하고, 기존 동작(`drawedges=False`, `extend='neither'`)을 안 깨야 하는 약한 regression-trap이 있다. T2(쉬움)보다 추론 밀도가 높고, T4로 갈 만한 cross-file 조율·넓은 P2P trap·깊은 도메인은 없다. 공식 라벨 "15 min - 1 hour"와 정합(T3 상단).

## 골드패치 분석

- **파일·함수**: `lib/matplotlib/colorbar.py`의 `Colorbar._add_solids(self, X, Y, C)`.
- **근본원인**: 구분선 segment를 만들 때 `np.dstack([X, Y])[1:-1]`로 양 끝을 **무조건** 잘라냈다. 이 슬라이스는 "확장 삼각형의 바깥쪽 경계선"까지 제거해버린다. extend 영역이 있을 때 첫/마지막 segment가 바로 그 끝 경계선이므로, 확장된 쪽에서 선이 사라진다.
- **수정요지**: `drawedges`/extend 상태에 따라 슬라이스 경계를 분기.
  ```python
  if self.drawedges:
      start_idx = 0 if self._extend_lower() else 1
      end_idx = len(X) if self._extend_upper() else -1
      self.dividers.set_segments(np.dstack([X, Y])[start_idx:end_idx])
  else:
      self.dividers.set_segments([])
  ```
  하단 확장이면 `start_idx=0`(첫 경계선 보존), 아니면 1(기존처럼 내부 끝 제외). 상단 확장이면 `end_idx=len(X)`(마지막 경계선 보존), 아니면 -1. 기존 `_extend_lower()`/`_extend_upper()` 헬퍼를 재사용해 colorbar 전역의 extend 의미와 일관되게 맞춘다.

## 검증 (test_patch)

- **FAIL_TO_PASS (3)**: `test_colorbar_extend_drawedges`의 `both`/`min`/`max` 파라미터. `from_levels_and_colors(..., extend=...)`로 만든 cmap/norm에 `drawedges=True` colorbar를 생성하고 `cbar.dividers.get_segments()`가 기대 segment 배열과 정확히 일치하는지 단언한다. `both`는 3개 segment(0,1,2 인덱스 모두), `min`은 2개(0부터), `max`는 2개(2까지)를 요구 — 패치 전엔 양 끝이 잘려 개수가 모자라 실패한다.
- **픽스 증명**: `start_idx`/`end_idx` 분기가 각 케이스에서 보존해야 할 끝 경계선을 정확히 살려, 단언된 segment 좌표열과 일치시킨다.
- **overfit/regression**: `neither` 케이스는 PASS_TO_PASS에 있어(`test_colorbar_extend_drawedges[neither--1-res3]`) extend 없음일 때 여전히 `[1:-1]` 동치(`start=1,end=-1`)로 1개 segment만 남는지 보장 — 기존 동작 회귀를 차단. 4-케이스를 모두 파라미터로 고정해 special-case 통과를 막아 overfit 위험이 낮다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "drawedges가 그리는 검은 선"과 "extend 끝에서 안 보임" → `colorbar.py`에서 `drawedges`/`dividers`를 grep → `_add_solids`의 `self.dividers.set_segments(np.dstack([X, Y])[1:-1] if self.drawedges else [])` 단 한 줄로 수렴.
2. **픽스와 일반화**: `[1:-1]`이 "내부 경계만 그린다"는 가정이 extend 영역을 무시한 것이 버그. 올바른 일반화는 끝 슬라이스를 extend 여부로 조건화하는 것 — 확장된 쪽은 끝 경계선이 실제 경계이므로 포함해야 한다. 상수 슬라이스가 아니라 `_extend_lower()/_extend_upper()`로 분기해 모든 extend 조합에 일반화된다.
3. **regression 안전**: `drawedges=False`면 빈 리스트 그대로(분기 분리로 명시화), `extend='neither'`면 `start=1,end=-1`로 기존 `[1:-1]`과 byte-동치 → 60개 PASS_TO_PASS(특히 `neither` drawedges 케이스, 각종 extension/lognorm/powernorm 테스트) 불변.
4. **함정 회피**: 오라클 없는 에이전트가 흔히 빠질 실수 — (a) `[1:-1]`을 통째로 `[:]`로 바꿔 `neither`에서 내부 끝까지 선을 그려 회귀, (b) `_extend_lower/_extend_upper` 헬퍼를 모른 채 `extend` 문자열을 직접 파싱(min/max/both 분기 누락), (c) `end_idx`를 `len(X)` 대신 `len(X)-1`로 off-by-one. 정답은 colorbar의 기존 extend 헬퍼를 재사용하고 두 끝을 독립적으로(lower/upper 별개) 조건화하는 것.
