---
instance_id: matplotlib__matplotlib-25311
repo: matplotlib/matplotlib
base_commit: 430fb1db88843300fb4baae3edc499bbfe073b0c
version: "3.7"
difficulty: "<15 min fix"
created_at: 2023-02-23T21:04:12Z
fail_to_pass: 1
pass_to_pass: 181
gold_files: [lib/matplotlib/offsetbox.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
draggable legend(또는 draggable annotation)을 붙인 figure를 `pickle.dumps`하면 `TypeError: cannot pickle 'FigureCanvasQTAgg' object`가 발생한다. `leg.set_draggable(True)` 줄을 빼면 정상 피클된다. 즉 draggable 활성화 시 객체 그래프 어딘가에 GUI 캔버스(`FigureCanvas`)에 대한 직접 참조가 새로 생겨 피클 스트림에 끌려 들어가는 것이 원인이다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 함수/심볼을 직접 지목하진 않지만 신호가 강하다. "draggable legend → 피클 실패, set_draggable 제거 시 정상"이라는 differential repro가 `set_draggable` 경로 → `DraggableLegend`/`DraggableBase` 한 줄로 수렴시킨다. grep `draggable`/`canvas =`로 좁은 단일파일(`offsetbox.py`) 후보로 수렴. 한 번의 탐색.
- **S2 (Constraint-Reasoning) +S6**: 고칠 지점(캔버스 참조 저장)은 좁히면 자명하나, 올바른 픽스는 "피클 가능성(picklability) 불변식을 유지하면서 동일 API를 보존"이라는 제약을 추론해 합성해야 한다. 단순 삭제가 아니라 인스턴스 속성을 `property`로 바꾸는 작은 구조 변경(S6)이 필요해 `self.canvas` 접근부 전부가 그대로 동작해야 한다.
- **K-Domain**: matplotlib의 피클 모델(왜 `FigureCanvas`가 피클 불가능한가, `Figure`는 캔버스를 직렬화하지 않고 unpickle 시 재생성한다는 내부 계약)을 알아야 "참조를 끊되 lazy 재계산으로 대체"가 올바른 해법임을 안다.
- **primary = T-ConstraintReason**: 위치는 비교적 명확하나 픽스의 본질이 "불변식(picklable) 보존 + API 동등성"을 따지는 의미 추론이다. 기계적 None-가드/상수변경이 아니라서 T-DirectMap이 아니다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 단일 파일(`offsetbox.py`) 1함수+1속성, 실질 변경 ~4줄, has-repro로 재현·localize가 쉬움. 그러나 픽스가 "속성→프로퍼티 전환"이라는 비자명한 이디엄을 요구하고, 왜 그게 옳은지에 도메인 지식(피클 모델)이 필요해 T1/T2의 "픽스 자명" 구간을 넘는다. P2P가 173개로 넓어 regression-trap이 있으나 모두 같은 `test_pickle.py` 내라 진짜 cross-module trap은 아님. 공식 라벨 `<15 min fix`와 대체로 일치하나, "올바른 일반화"를 모르면 naive 삭제로 `self.canvas` 참조부를 깨뜨릴 수 있어 시간라벨이 과소평가하는 함정이 있어 T2가 아닌 T3.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/offsetbox.py`, `DraggableBase.__init__` (및 클래스 본문).
- **근본원인**: `__init__`에서 `self.canvas = self.ref_artist.figure.canvas`로 GUI 캔버스를 **인스턴스 속성으로 저장**한다. 이 draggable 핸들러는 콜백 등록을 통해 figure의 객체 그래프에 살아남고, 그 안의 `self.canvas`가 피클 불가능한 `FigureCanvasQTAgg`/`FigureCanvas`를 직접 가리키므로 `pickle.dumps`가 캔버스를 직렬화하려다 실패한다.
- **수정요지**: 인스턴스 속성 `self.canvas = ...` 한 줄을 제거하고, 대신 클래스 수준에서 `canvas = property(lambda self: self.ref_artist.figure.canvas)`로 선언. 주석대로 "picklability 유지를 위해 attribute가 아닌 property". 이제 `self.canvas`는 매 접근마다 `ref_artist.figure.canvas`를 lazy 평가하므로 인스턴스 `__dict__`에 캔버스 참조가 남지 않아 피클 스트림에 끌려오지 않는다. `self._use_blit`, `self.cids` 등 기존 `self.canvas` 사용부는 property를 통해 동일하게 동작.

## 검증 (test_patch)
- **FAIL_TO_PASS** = `test_pickle.py::test_complete[png]` (배열 길이 1). 테스트 픽스처 `_generate_complete_test_figure`에 `plt.legend(draggable=True)`를 추가해 draggable legend를 도형에 포함시킨다.
- **픽스 증명**: 단순 round-trip 성공만 보지 않고, `pickletools.genops(pkl)`로 피클 스트림을 토큰화해 `assert "FigureCanvasAgg" not in [...]`로 **캔버스 참조가 스트림에 존재하지 않음**을 직접 검사한다. 즉 "예외가 안 났다"가 아니라 "객체 그래프에서 캔버스가 끊겼다"는 근본원인을 정조준. Agg 백엔드로 돌려 GUI 툴킷 비의존으로 만든 점도 견고.
- **overfit/regression**: FAIL_TO_PASS가 1개로 얇아 보이지만 genops 토큰 검사가 special-case 통과를 막아 overfit 위험을 낮춘다(단순 try/except 우회로는 통과 불가). P2P 173개(test_simple/test_no_pyplot/test_cmap[*] 등)가 일반 피클 경로와 `loaded.canvas.draw()` 정상성을 광범위하게 지켜, property 전환이 캔버스 접근을 깨지 않음을 보증.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 differential 신호("set_draggable 제거 시 피클 정상")가 핵심. `set_draggable` → `DraggableLegend(self)` → 베이스 `DraggableBase`로 콜체인을 타고, `offsetbox.py`에서 `self.canvas = ...`로 GUI 캔버스를 인스턴스에 박는 한 줄을 찾는다. annotation도 같은 베이스를 쓰므로 "annotation도 동일 에러"라는 부가 정보와 합치 — 베이스 클래스가 진짜 결함 지점.
2. **픽스와 일반화**: 캔버스를 인스턴스 상태로 들고 있을 이유가 없다(항상 `ref_artist.figure.canvas`에서 파생 가능). 따라서 저장을 제거하고 `canvas`를 lazy property로 만든다. 이는 "피클 불가 객체는 직렬화 그래프에 넣지 말고 unpickle 후 재참조"라는 matplotlib 피클 모델과 정합 — legend/annotation 뿐 아니라 `DraggableBase`의 모든 서브클래스에 일반적으로 옳다.
3. **regression 안전**: `self.canvas`를 읽던 `_use_blit`, `cids`, `on_motion`의 `restore_region` 등이 property로 투명하게 동작해야 하고, 173개 P2P(특히 `test_complete`의 `loaded.canvas.draw()`)가 unpickle 후 캔버스가 정상 재생성·접근됨을 지킨다.
4. **함정 회피**: 오라클 없는 에이전트는 (a) `self.canvas` 줄을 그냥 삭제만 하고 property를 안 만들어 `AttributeError`로 회귀시키거나, (b) `DraggableLegend.__init__`만 고치고 공유 베이스를 못 잡아 annotation 케이스를 놓치거나, (c) `Figure.__getstate__`에 캔버스 제거 로직을 덧대는 과한 변경으로 빠지기 쉽다. property 이디엄으로 "참조를 lazy화"하는 최소·일반 해법이 정답.
