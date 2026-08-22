export { HEADLESS_WAV_HEADER, headlessVoiceInput } from "./headless-stub"
export type { CaptureOpts, VoiceInputPort } from "./port"
export {
  buildSoxArgv,
  createSoxVoiceInput,
  defaultSoxSpawner,
  type SoxSpawnedChild,
  type SoxSpawner,
} from "./sox-capture"
export type { AudioBlob, CaptureError } from "./types"
