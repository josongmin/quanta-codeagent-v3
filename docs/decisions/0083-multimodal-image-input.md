# ADR-0083: Multi-modal image input (dual-provider)

- **상태**: Accepted
- **날짜**: 2026-05-22
- **관련**: `src/llm/types.ts`(ContentBlock), ADR-0079(content-block mapping), `v0-dev-feature-review.md`(멀티모달). 둘 다 1급 — OpenAI vision + Anthropic Messages images.

## 맥락

v3는 텍스트-only 입력이었다. 스크린샷·다이어그램·UI 목업 디버깅 같은 use-case가 SOTA 코딩 에이전트(v0 voice/image, Cursor 이미지 붙여넣기)에 보편화됐다. OpenAI(`image_url` content part)와 Anthropic(Messages `image` base64 source) 둘 다 vision을 지원한다.

## 결정

1. **`ContentBlock`에 `ImageBlock` 추가** (`src/llm/types.ts`):
   ```ts
   export interface ImageBlock { type: "image"; data: string /* base64, no data: prefix */; mediaType: string }
   ```
   입력(user) 측에만 등장 — 모델은 이미지를 스트림백하지 않으므로 `assembleFromEvents`는 절대 생성 안 함.

2. **두 어댑터 직렬화**:
   - Anthropic: `{type:"image", source:{type:"base64", media_type, data}}` (`toAnthropicContent` case).
   - OpenAI: user message content를 **배열 형태**로 widen — `[{type:"text",...},{type:"image_url",image_url:{url:"data:<mediaType>;base64,<data>"}}]`. 이미지 없으면 기존 plain-string 형태 유지(byte-identical).

3. **CLI `--image <path>`** (repeatable, `src/apps/cli/image-loader.ts`): 확장자→mediaType(png/jpeg/webp/gif 4종), 20MB cap, 미지원/초과 시 시작 전 throw+exit 1. 첫 user turn에만 첨부 후 drain(이후 REPL 줄은 text-only).

4. **compaction 처리**: `blockChars`는 이미지를 고정 추정(≈1.5k 토큰, base64 길이로 threshold 폭주 방지), `renderBlock`은 `(image <mediaType>)` placeholder(요약은 이미지를 못 보므로 존재만 표기).

## 근거

- **dual-provider 동급**: 같은 `ImageBlock`이 두 어댑터에서 각자 native 형태로. surface(CLI)는 provider 무관.
- **byte-identical default-OFF**: `--image` 없으면 ContentBlock에 image 0개 → OpenAI plain-string 유지, Anthropic 변화 없음, compaction 영향 0.
- **확장자 화이트리스트 4종**: 두 provider 공통 수용 타입만. 미지원은 시작 전 loud-fail(provider 400 회피).
- **base64 prefix 분리**: `data`는 순수 base64; provider framing(`data:…` URL vs raw source)은 각 어댑터가 추가 → 한 ImageBlock이 양쪽 호환.

## 대안

- **provider별 별도 block 타입**: 기각 — surface가 provider를 알아야 함, 슬라이스 격리 위반.
- **파일 path를 모델에 그대로 전달**: 기각 — 모델은 FS 접근 없음, 실제 바이트 필요.
- **byte cap 없음**: 기각 — provider 400 + 메모리. 20MB로 fail-fast.

## 결과·트레이드오프

- **얻은 것**: 스크린샷/다이어그램 입력. dual-provider. CLI `--image`. 13 unit (adapter 5 + loader 8) green. tsc 0.
- **비용**: `ContentBlock` union +1 (compaction 2곳 + anthropic exhaustive default가 컴파일 강제로 잡아줌 — silent drop 불가). OpenAI ChatParam user content가 `string | UserContentPart[]`로 widen.

## 한계 (LIMITATIONS)

- (a) CLI seed turn에만 첨부 — 대화 중간 `--image` 재첨부는 미지원(REPL 슬래시 `/image`는 follow-up).
- (b) 이미지 토큰 계측은 고정 추정 — 정확한 tile-기반 계산은 provider별 별도.
- (c) image OUTPUT(생성)은 미흡수 — 입력만.

## 불변식 영향

- **byte-identical default**: image 0개면 모든 경로 무변경.
- **슬라이스 격리**: `ImageBlock`은 `@/llm` 공개. image-loader는 `src/apps/cli`(엔트리).
- **exhaustive 강제**: ContentBlock switch(anthropic/compaction)가 `never` default로 새 variant 누락을 컴파일 차단.
- **신규 npm dep 0**.
