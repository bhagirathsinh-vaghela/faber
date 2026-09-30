import { createSignal } from "solid-js"
import type { VoicePreference } from "@opencode-ai/sdk/v2/client"

// A directory's store starts on the saved preference rather than on none, so
// its own bootstrap fetch of the same value is not taken for a voice change.
export const seedVoice = (global: VoicePreference): VoicePreference => ({ name: global.name, version: global.version })

// A voice reaches this client by the event stream, a fetch, and a save's
// reply, in no fixed order; the server's version says which is newest. An
// equal version is the same write, and a value stored before versions is 0.
export const newer = (current: VoicePreference, incoming: VoicePreference) =>
  (incoming.version ?? 0) >= (current.version ?? 0)

// The one way a voice reaches the stores: applied only when it is not older
// than the one held.
export const voiceStore = (read: () => VoicePreference, write: (preference: VoicePreference) => void) =>
  (preference: VoicePreference) => {
    if (newer(read(), preference)) write(preference)
  }

// With no saved voice the server speaks the config default (tts.ts /speak), so
// that default is the voice a reading is in.
export const spokenVoice = (saved: string, fallback: string | undefined) => saved || fallback || ""

// Saves run one at a time, in the order asked: the server versions them in
// arrival order, so two in flight could store the earlier pick last. A failed
// run does not hold up the next.
export function serial() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(run: () => Promise<T>) => {
    const next = tail.then(run)
    tail = next.catch(() => {})
    return next
  }
}

// The picker shows the latest pick until that pick's save settles, either
// way, then the voice in effect; an earlier pick settling does not move it.
export function picker(save: (id: string) => Promise<unknown>) {
  const [pending, setPending] = createSignal<string>()
  const picks = { latest: 0 }
  return {
    pending,
    pick: (id: string) => {
      const pick = ++picks.latest
      setPending(id)
      const done = () => {
        if (pick === picks.latest) setPending(undefined)
      }
      return save(id).then(done, done)
    },
  }
}

// The layout's effect runs once on mount with the voice already in effect;
// only a later, different voice re-voices.
export function voiceApplier(initial: string, revoice: () => void) {
  let applied = initial
  return (voice: string) => {
    if (voice === applied) return
    applied = voice
    revoice()
  }
}
