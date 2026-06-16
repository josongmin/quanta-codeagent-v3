---
instance_id: matplotlib__matplotlib-24637
repo: matplotlib/matplotlib
base_commit: a9ba9d5d3fe9d5ac15fbdb06127f97d381148dd0
version: "3.6"
difficulty: "15 min - 1 hour"
created_at: 2022-12-06T03:42:05Z
fail_to_pass: 1
pass_to_pass: 29
gold_files: [lib/matplotlib/offsetbox.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [has-repro]
---

## 문제 요약
`AnnotationBbox` 아티스트에 `set_gid()`로 gid를 설정해도 SVG로 저장하면 해당 gid가 출력 SVG에 포함되지 않는다. 이슈 작성자는 동일 부류의 누락을 고친 PR #15087을 인용하며 `AnnotationBbox`가 그 수정에서 빠진 것 같다고 정확히 지목한다. 메인테이너 힌트가 해법을 거의 명시한다: `AnnotationBbox.draw`가 시작에서 `open_group()`, 끝에서 `close_group()`를 호출해 전체를 gid를 가진 SVG `<g>` 요소로 감싸면 된다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈가 클래스(`AnnotationBbox`)와 누락 동작(gid 미전달)을 직접 지목하고, 참조 PR #15087이 동일 패턴(`open_group`/`close_group` 래핑)을 보여준다. `offsetbox.py`의 `AnnotationBbox.draw`로 좁히는 데 약간의 추적만 필요. grep `class AnnotationBbox` → `def draw` 한두 단계.
- **S (Repair Strategy) = S1 (+S5)**: 픽스가 사실상 명세돼 있다 — 다른 아티스트들이 이미 쓰는 정형 패턴(`renderer.open_group(...)`/`close_group(...)`)을 `draw` 본문에 끼워넣는 기계적 수리. 보조로 S5가 약간: "전체를 하나의 gid로 감쌀지, 내부 아티스트별로 줄지"는 코드만으론 결정 안 돼 이슈 토론/관례에서 "AnnotationBbox 전체를 하나로" 스펙을 채택한다.
- **K (Knowledge) = K-Domain**: matplotlib 렌더러의 group 프로토콜(`open_group`/`close_group`이 SVG `<g id=...>`로 매핑되는 메커니즘, gid는 `get_gid()`로)이라는 프레임워크 내부 지식이 병목. 일반 파이썬 추론만으론 정확한 API를 못 짚는다.
- **Primary = T-DirectMap**: 위치가 명확하고 픽스가 기존 결함클래스(gid 미전달)의 기계적 가드/래핑 추가에 템플릿 매칭된다. S2식 식 합성도, L2/L3 탐색도 없다.

## 난이도 티어
- **Tier = T2 (쉬움)**. 구조적 피처: 단일 파일(`offsetbox.py`) 단일 함수(`AnnotationBbox.draw`), 골드 패치는 순수 **+2줄**(open/close 한 줄씩), localize 직접성 높음, has-repro(이슈에 완전한 재현 스크립트), 참조 PR이 정확한 패턴 제공. P2P trap 약함 — 29개 PASS_TO_PASS가 모두 SVG 백엔드 테스트지만 추가가 순수 additive(기존 draw 동작 불변, 그룹 래핑만)이라 깨질 여지 거의 없음.
- 공식 라벨은 "15 min - 1 hour"로 T3 경계에 가깝지만, 그 시간은 SVG 스펙 read-up과 테스트 작성 비용(메인테이너가 "good first issue"라며 명시)이지 추론 난이도가 아니다. 에이전트 관점에서 픽스 자체는 자명하므로 T2로 내린다. K-Domain이 유일한 상향 요인이나 참조 PR이 그 지식을 대신 제공해 상쇄.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/offsetbox.py`의 `AnnotationBbox.draw(self, renderer)`.
- **근본원인**: `draw`가 내부 아티스트들(`arrow_patch`, `patch`, `offsetbox`)을 순차 그리기만 하고 자신의 gid를 렌더러 group으로 전혀 전달하지 않음. 다른 SVG-gid 지원 아티스트들이 쓰는 `open_group`/`close_group` 래핑이 PR #15087에서 이 클래스만 누락됨.
- **수정요지**: visibility/`_check_xy` 가드를 통과한 직후 `self.update_positions(renderer)` 호출 **전에** `renderer.open_group(self.__class__.__name__, gid=self.get_gid())`를, 모든 자식 draw가 끝난 뒤 `self.stale = False` 직전에 `renderer.close_group(self.__class__.__name__)`를 삽입. 이로써 SVG 백엔드가 자식 요소들을 `<g id="...">`로 감싼다.

## 검증 (test_patch)
- **FAIL_TO_PASS** (1개): `test_annotationbbox_gid`. `OffsetImage`+`AnnotationBbox`를 만들고 `ab.set_gid("a test for issue 20044")` 후 `fig.savefig(fd, format='svg')`로 SVG 버퍼를 얻어 `'<g id="a test for issue 20044">'` 문자열이 포함됐는지 단언.
- **픽스 증명**: 골드의 `open_group(..., gid=self.get_gid())`가 정확히 그 `<g id=...>` 요소를 SVG에 방출하므로 테스트가 RED→GREEN.
- **overfit 관점**: 테스트가 단일 gid 문자열 substring만 확인해 얇아 보이나, 픽스도 그만큼 일반적(임의 gid를 `get_gid()`로 그대로 전달)이라 special-case 통과 위험 없음. gid 값에 의존하는 분기가 없으므로 CEGIS류 과적합 불가.
- **regression 관점**: 29개 PASS_TO_PASS는 전부 기존 SVG 백엔드 동작(gid/url/metadata/rasterized/visibility 등). 패치가 순수 group 래핑 추가라 자식 draw 순서·내용 불변, 회귀 가능성 낮음.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈가 `AnnotationBbox` + "gid not passed to renderer"를 직접 명시하고 PR #15087을 동일-부류 선례로 인용 → `offsetbox.py`에서 `class AnnotationBbox`의 `def draw`를 연다. 다른 아티스트의 `open_group`/`close_group` 사용을 grep해 정확한 API와 인자(`gid=self.get_gid()`)를 확인.
2. **픽스**: `draw` 진입 가드(`get_visible`/`_check_xy`) 직후 `renderer.open_group(self.__class__.__name__, gid=self.get_gid())`, 자식 draw 종료 후 `renderer.close_group(self.__class__.__name__)` 삽입. 올바른 일반화인 이유: gid 값을 해석/하드코딩하지 않고 `get_gid()`를 그대로 렌더러 프로토콜에 위임 → 임의 gid·임의 백엔드에 동작.
3. **regression 안전**: open/close를 자식 draw 바깥에 대칭으로 감싸고 가드(early return) 이후에 배치해야, 보이지 않는 박스에서 group을 열고 안 닫는 비대칭이나 빈 group 방출을 피한다. 기존 draw 경로·순서는 그대로라 SVG/PDF/PNG 백엔드 PASS_TO_PASS 불변.
4. **함정 회피**: (a) 힌트가 던진 "내부 아티스트별 개별 gid" 방향으로 가면 과설계 — 오라클은 "전체를 하나의 gid로 감싸기"를 택한다. (b) `open_group`을 가드 **앞**(early return 전)에 두면 invisible 케이스에서 group 누수. (c) gid가 `None`일 때 — `get_gid()`는 기본 None을 반환하고 렌더러가 이를 처리하므로 별도 None 가드 불필요(추가하면 over-engineering).
