---
instance_id: matplotlib__matplotlib-20676
repo: matplotlib/matplotlib
base_commit: 6786f437df54ca7780a047203cbcfaa1db8dc542
version: "3.4"
difficulty: "<15 min fix"
created_at: 2021-07-19T10:10:07Z
fail_to_pass: 2
pass_to_pass: 32
gold_files: [lib/matplotlib/widgets.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`interactive=True`로 `SpanSelector`를 생성하기만 해도(선택 동작 없이) 축의 xlim이 강제로 0을 포함하도록 확장된다. 재현 코드에서 `ax.plot([10, 20], [10, 20])`로 데이터 범위가 (10,20)인데, 셀렉터 생성 직후 하한이 0(마진 제외)으로 떨어진다. Matplotlib 3.4(구 `span_stays`)에서는 (10,20)+마진을 유지했으므로 회귀. 원인은 edge handle을 데이터 좌표 x=0에 그려 오토스케일이 0을 포함하게 되는 것.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `SpanSelector` + `interactive`를 직접 지목한다. `widgets.py`의 `SpanSelector` 생성 경로(`_setup_edge_handle`)로 좁게 수렴되나, "왜 0이 끼는가"는 `extents`→`_rect`(0,0) 초기값까지 데이터플로우를 한 단계 따라가야 보인다. L0 핀포인트는 아님.
- **S2 (Constraint-Reasoning)**: 고칠 함수(`_setup_edge_handle`)는 좁혀지지만, 올바른 초기값을 "추론으로 합성"해야 한다. `self.extents`(=(0,0))를 핸들 초기위치로 쓰는 게 결함이고, 불변식 "핸들 생성이 기존 축 범위를 바꾸면 안 된다"를 만족하는 값=축의 현재 bound(`get_xbound`/`get_ybound`)를 골라야 한다. 후보 난사(S3)가 아니라 의미 추론.
- **K-Domain**: matplotlib 오토스케일/데이터좌표 트랜스폼·`ToolLineHandles` 내부 동작 이해가 병목. x=0 라인이 왜 xlim을 끄는지(데이터 좌표 아티스트가 autoscale에 반영)는 프레임워크 지식.
- **primary = T-ConstraintReason**: 위치는 거의 잡히나 픽스 자체가 "올바른 초기 위치 식"을 의미적으로 합성하는 데 본질이 있다.

## 난이도 티어
**T3 (중간)**. 구조적 피처: 1파일·1함수·실질 +5/-1줄(단일 헌크), `has-repro`로 재현 명확. 그러나 `<15 min fix` 공식 라벨보다 약간 위로 본 이유는 두 가지다. (1) localize가 L0이 아니라 L1 — 결함이 `_setup_edge_handle`에 있지만 증상(xlim=0)과 코드 사이에 `extents` getter가 (0,0)을 돌려준다는 인과 사슬을 짚어야 한다. (2) `regression-trap`: `test_span_selector_drag`, `test_span_selector_direction`, `test_tool_line_handle` 등 32개 P2P가 핸들/드래그/방향 동작을 검사하므로, 초기위치만 바꾸고 이후 onmove 갱신 동작은 그대로 유지해야 한다. overfit 위험은 낮고(픽스가 일반적 bound 사용), 멀티파일/멀티헌크가 아니라 T4까지는 아님.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/widgets.py` 의 `SpanSelector._setup_edge_handle`.
- **근본원인**: `_setup_edge_handle`가 `ToolLineHandles(self.ax, self.extents, ...)`로 핸들을 생성하는데, 생성 시점의 `self.extents`는 `_rect`가 `(0,0)` 크기로 초기화돼 있어 `(0, 0)`을 반환한다(위 `extents` getter: `vmin=_rect.get_x()=0`). 결과적으로 데이터 좌표 x=0(또는 y=0)에 핸들 라인이 그려지고, 이 아티스트가 오토스케일에 포함돼 축 하한을 0까지 끌어내린다.
- **수정요지**: 초기 핸들 위치를 (0,0) 대신 **현재 축 bound**로 잡는다. `direction=='horizontal'`이면 `positions = self.ax.get_xbound()`, 아니면 `self.ax.get_ybound()`을 사용해 `ToolLineHandles(self.ax, positions, ...)`로 전달. 축 경계 위에 핸들을 두므로 오토스케일이 기존 범위를 넘어 확장하지 않는다.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `test_span_selector_bound[horizontal]`, `test_span_selector_bound[vertical]` 신규 2개. `ax.plot([10,20],[10,30])` 후 `SpanSelector(..., interactive=True)` 생성 직후 `ax.get_xbound()`/`get_ybound()`가 생성 전과 동일함을 단언(=핵심 회귀 방어). 또한 `tool._edge_handles.positions == list(bound)`로 핸들이 축 bound에 놓였는지 확인.
- **픽스 증명**: 패치 전에는 핸들이 0에 그려져 bound가 변하므로 첫 `assert ax.get_xbound() == x_bound`에서 실패. 패치 후 bound 위에 그려져 통과. 이어 `press`/`onmove` 이벤트 후에도 bound 불변 + 핸들이 실제 press/release 좌표로 갱신됨을 확인해, 픽스가 "초기위치만" 고치고 인터랙션 갱신 경로는 보존함을 증명.
- **overfit/regression**: overfit 위험 낮음 — `get_xbound` 사용은 특정 입력(10,20)에 맞춘 게 아니라 어떤 데이터 범위에도 일반화. regression은 P2P 32개(drag/direction/handles)가 가드. 다만 FAIL_TO_PASS가 "생성 시 bound 불변"만 직접 검증하므로, onmove 단언이 갱신 동작까지 봐주는 점이 overfit 차단에 기여.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 신호 "interactive 생성만으로 xlim에 0이 낀다" → `SpanSelector.__init__`에서 `interactive`일 때만 도는 경로 추적 → `_setup_edge_handle`이 `ToolLineHandles(self.ax, self.extents, ...)`를 호출함을 발견. `self.extents` getter가 `_rect`(0,0)에서 `(0,0)`을 반환함을 확인하면 "왜 0인가"가 확정된다.
2. **픽스와 일반화**: 초기 핸들 좌표를 데이터 0이 아니라 **현재 축 범위**로 잡아야 오토스케일 불변. `direction`에 따라 `get_xbound()`/`get_ybound()`를 써서 축 경계 위에 핸들을 둔다. 특정 숫자가 아니라 축 상태에서 파생하므로 모든 데이터에 올바른 일반화.
3. **regression 안전**: `extents` setter는 이후 `_edge_handles.set_data(self.extents)`로 핸들을 다시 그리므로, 초기값만 바꿔도 press/onmove 갱신 경로는 그대로다. drag/direction/handles P2P 32개를 깨지 않으려면 setter나 onmove 로직을 건드리지 말고 생성 시 초기위치 한 곳만 수정해야 한다.
4. **함정 회피**: 흔한 오답은 (a) `extents` getter나 `_rect` 초기 크기를 바꿔 다른 표시 동작을 깨뜨리거나, (b) 핸들을 `set_visible(False)`로 숨겨 증상만 가려 인터랙션 시 다시 0이 끼는 것, (c) 생성 후 오토스케일을 강제 복원해 부작용을 남기는 것. 정답은 결함의 원천(초기 좌표 0)을 축 bound로 교체하는 최소 수정이며, 오라클의 onmove 단언이 (b)류 회피를 강제한다.
