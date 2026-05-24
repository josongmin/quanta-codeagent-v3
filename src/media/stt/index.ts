export {
  createDeepgramAdapter,
  DEEPGRAM_ENDPOINT,
  type DeepgramAdapterOpts,
  type FetchLike,
} from "./deepgram-adapter"
export { headlessSpeechToText } from "./headless-stub"
export {
  createWhisperAdapter,
  WHISPER_ENDPOINT,
  WHISPER_MODEL,
  type WhisperAdapterOpts,
} from "./openai-whisper-adapter"
export type { SpeechToTextPort } from "./port"
export {
  createSttFromEnv,
  requiresExtraConfirm,
  SOFT_CONFIDENCE_FLOOR,
  type SttRegistryOpts,
  type SttSelection,
  selectSttAdapter,
} from "./registry"
export type { SttError, Transcript } from "./types"
