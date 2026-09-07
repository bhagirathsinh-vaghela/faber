// The HH:MM:SS stamp every card header shows, shared so every TranscriptCard
// renders the same format in the same header position.
export function messageTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
}
