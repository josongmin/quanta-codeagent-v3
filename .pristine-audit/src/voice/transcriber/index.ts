/**
 * Voice / transcriber barrel (ADR-0208).
 *
 * Re-exports the port + adapters. NO registry — voice-cmd.ts owns
 * adapter selection so the surface decides which provider to wire (env
 * fan-out is a surface concern, not a port concern).
 */

export {
  createDeepgramTranscriber,
  DEEPGRAM_ENDPOINT_V3,
  DEEPGRAM_MODEL_DEFAULT,
  type DeepgramTranscriberOpts,
} from "./deepgram-transcriber"
export {
  createLocalWhisperTranscriber,
  defaultWhisperBinarySpawner,
  defaultWhisperFs,
  type LocalWhisperOpts,
  type WhisperBinaryChild,
  type WhisperBinarySpawner,
  type WhisperFileSystem,
} from "./local-whisper-transcriber"

export {
  createOpenAIWhisperTranscriber,
  type FetchLike,
  WHISPER_ENDPOINT_V3,
  WHISPER_MODEL_V3,
  type WhisperTranscriberOpts,
} from "./openai-whisper-transcriber"
export type {
  TranscribeReq,
  TranscriberError,
  TranscriberPort,
  TranscriptSegment,
  VoiceTranscript,
} from "./port"
