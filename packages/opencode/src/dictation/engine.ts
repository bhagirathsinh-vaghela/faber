export type Transcript = { text: string; final: boolean }

// Frames arrive as 16kHz mono PCM16 for as long as the user speaks; `stop`
// marks the end of the utterance. A streaming engine emits interim transcripts
// throughout, a batch engine emits one final at stop — the client renders both
// the same way.
export interface Engine {
  frame(data: ArrayBuffer): void
  // `rate` is the sample rate the client actually captured at, so the server
  // can reject audio a model-rate change has made stale rather than transcribe
  // it garbled.
  stop(rate: number): void
  close(): void
}

export type Host = {
  transcript(value: Transcript): void
  fail(message: string): void
  done(): void
}
