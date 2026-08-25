// Diagnostics for a transcript showing nothing over a populated store.
//
// The failure is intermittent and leaves no error behind: the store keeps the
// turns (the dock goes on reporting their token counts) while none of them
// reaches the visible box, and by the time anyone looks the geometry that
// explains it has been overwritten. Only a reading taken at the moment of
// repair carries it, so each one records what it saw and what it did.
//
// `__transcriptProbe()` in the console returns them, newest last.

export interface TranscriptProbeEntry {
  at: number
  event: string
  detail: Record<string, unknown>
}

const LIMIT = 64
const entries: TranscriptProbeEntry[] = []

export function probe(event: string, detail: Record<string, unknown> = {}) {
  entries.push({ at: Date.now(), event, detail })
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT)
}

export function probeDump() {
  return entries.map((entry) => ({ ...entry, ago: Date.now() - entry.at }))
}

if (typeof window !== "undefined") {
  ;(window as unknown as { __transcriptProbe: typeof probeDump }).__transcriptProbe = probeDump
}
