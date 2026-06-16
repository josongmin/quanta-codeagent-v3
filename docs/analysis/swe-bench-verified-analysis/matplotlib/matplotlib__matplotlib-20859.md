---
instance_id: matplotlib__matplotlib-20859
repo: matplotlib/matplotlib
base_commit: 64619e53e9d0ed417daba287ac0d3a06943a54d5
version: "3.4"
difficulty: "<15 min fix"
created_at: 2021-08-19T09:03:04Z
fail_to_pass: 1
pass_to_pass: 88
gold_files: [lib/matplotlib/legend.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`SubFigure`에 legend를 추가하면 `TypeError: Legend needs either Axes or Figure as parent`가 발생한다.
원인은 `Legend.__init__`이 parent 타입을 `Figure`에 대해서만 `isinstance` 체크하는데, `SubFigure`는 `Figure`의 서브클래스가 아니라 공통 베이스 `FigureBase`만 공유하기 때문이다.
이슈 본문이 트레이스백과 함께 정확한 라인(legend.py L437)과 "`FigureBase`로 체크하면 고쳐진다"는 픽스까지 직접 명시한다.

## 유형 (정형화)

- **L (Localization) = L0**: 이슈에 네이티브 트레이스백 + 정확한 파일/라인(`legend.py:441`, L433-442 permalink)이 박혀 있고, 리포터가 고칠 라인까지 지목. grep 한 방.
- **S (Repair Strategy) = S1**: 정형 결함클래스(타입체크 over-narrow). `isinstance(parent, Figure)` → `isinstance(parent, FigureBase)`로 기계적 치환. 이슈가 사실상 픽스를 명세함.
- **K (Knowledge) = K-Domain**: 일반 파이썬 추론만으로는 부족. `SubFigure`/`Figure`/`FigureBase` 클래스 계층(둘 다 `FigureBase` 상속, `SubFigure`는 `Figure`의 서브클래스가 **아님**)이라는 matplotlib 내부 지식이 있어야 "왜 `Figure`가 아니라 `FigureBase`인가"를 확신할 수 있다.
- **primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 타입강제(S1). 자명한 한 줄짜리가 아니라 올바른 베이스클래스 선택이라는 약한 도메인 판단이 있어 T-LocTrivial보다는 T-DirectMap.
- **왜 S1인가 (APR 관점)**: PAR/TBar식 결함 템플릿 "too-narrow type guard → widen to common base"에 정확히 매칭된다. 조건식을 추론으로 합성(S2)할 필요가 없고, 후보를 생성·검증(S3/S4)할 필요도 없다. 정답이 클래스 계층에서 유일하게 결정된다.

## 난이도 티어

**T2 (쉬움)**. 공식 라벨 `<15 min fix`와 일치.

- 파일수 1개, 골드 헌크 2개, 실질 변경 ~3줄(가드 한 줄 + 에러메시지 2줄). 구조적 컷 "1파일·<5줄 ≈ 48% solve" 구간.
- localize 직접성 최상(L0, has-repro). repro 신호는 가장 강한 easiness 지표.
- T1이 아닌 이유: 픽스가 "이슈가 거의 적어준" 순수 자명형이긴 하나, `Figure` vs `FigureBase` 선택이 클래스 계층 지식(K-Domain)을 요구하고, P2P가 89개로 넓어 약한 regression-trap이 있다. T1의 K-Gen 조건을 충족하지 못함.
- T3 이상이 아닌 이유: 추론 합성·다중 후보·cross-file 조율이 전혀 없다.

## 골드패치 분석

- **건드린 파일·함수**: `lib/matplotlib/legend.py`의 `Legend.__init__`.
- **근본원인**: parent 타입 분기에서 `from matplotlib.figure import Figure`를 import하고 `elif isinstance(parent, Figure)`로 검사. `SubFigure`는 `FigureBase`를 상속하지만 `Figure`의 인스턴스가 아니므로 이 분기를 통과하지 못하고 `else`의 `raise TypeError`로 떨어진다.
- **수정요지**:
  1. 순환 import 회피용 로컬 import를 `Figure` → `FigureBase`로 교체.
  2. `elif isinstance(parent, Figure)` → `elif isinstance(parent, FigureBase)`로 가드 확장. 이로써 `Figure`와 `SubFigure` 양쪽이 `isaxes=False` 경로로 들어가 `set_figure(parent)`가 호출됨.
  3. 에러메시지를 `"Legend needs either Axes or Figure as parent"` → `"Legend needs either Axes or FigureBase as parent"`로 일관화.

## 검증 (test_patch)

- **FAIL_TO_PASS** = `test_subfigure_legend` 1개. `plt.figure().subfigures()`로 `SubFigure`를 만들고 `ax.plot(..., label=...)` 후 `subfig.legend()` 호출, `leg.figure is subfig`를 단언. 픽스 전엔 `TypeError`로 죽고, 후엔 legend가 subfig를 figure로 잡아 통과.
- **픽스 증명**: 단언 `leg.figure is subfig`는 `FigureBase` 분기에서 `set_figure(parent)`가 실행됐음을 직접 관측한다. 단순 "예외 안 남"이 아니라 parent 바인딩까지 검증해 약한 teeth는 아님.
- **overfit 관점**: 픽스가 `SubFigure` special-case가 아니라 공통 베이스 `FigureBase`로 일반화하므로, 테스트가 `SubFigure`만 검증해도 `Figure` 경로(P2P의 `TestLegendFigureFunction::*`)가 그대로 살아남는다. CEGIS식 과소명세 위험 낮음.
- **regression 관점**: P2P 89개 중 `TestLegendFunction`/`TestLegendFigureFunction` 그룹이 Axes·Figure parent 경로를 광범위하게 커버. `FigureBase`는 `Figure`의 슈퍼타입이므로 기존 `Figure`/Axes 분기 동작이 보존됨(regression-trap은 넓지만 안전하게 통과).

## 모범답안 (오라클 기반)

1. **localize 경로**: 트레이스백 마지막 프레임 `legend.py:441 raise TypeError("Legend needs either Axes or Figure as parent")`로 직행. `Legend.__init__`의 parent 타입 분기(`isinstance(parent, Figure)`)가 범인임을 즉시 확정. 이슈 본문의 L433-442 permalink가 이를 재확인.
2. **픽스와 일반화 근거**: `Figure`와 `SubFigure`의 MRO를 확인하면 둘 다 `FigureBase`를 상속하고 `SubFigure`는 `Figure`를 상속하지 **않음**을 알 수 있다. 따라서 가드를 공통 베이스 `FigureBase`로 넓히는 것이 `SubFigure`만 따로 `or isinstance(parent, SubFigure)`로 추가하는 것보다 올바른 일반화 — 향후 `FigureBase`의 다른 서브타입도 자동 수용하고 special-case 누적을 막는다. import와 에러메시지도 같은 어휘로 맞춰 일관성 유지.
3. **regression 안전**: `Figure`/Axes parent를 쓰는 기존 모든 legend 경로(`test_legend_*`, `TestLegendFunction`, `TestLegendFigureFunction`)를 깨지 않아야 함. `FigureBase`가 `Figure`의 상위타입이라 기존 분기 진입 조건이 포함관계로 유지되므로 안전.
4. **함정 회피**: (a) `SubFigure`를 직접 import해 `isinstance(parent, (Figure, SubFigure))`로 좁게 패치하면 통과는 하나 일반화가 부족 — 베이스로 올리는 게 정답. (b) 순환 import 주의 — 로컬 import를 그대로 유지하되 심볼만 교체. (c) `figure.py`의 `get_default_bbox_extra_artists`(hints에서 언급된 `bbox_inches="tight"` 누락) 후속 이슈는 **이 인스턴스 범위 밖**이며 별도 이슈로 분리됨 — 골드패치는 legend.py만 건드리므로 scope를 넓히면 안 됨.
