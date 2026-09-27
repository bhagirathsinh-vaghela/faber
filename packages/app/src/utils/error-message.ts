// An SDK error carries the server's message under `data.message`; anything else
// falls back to its own message, then to the caller's generic text.
export function errorMessage(err: unknown, fallback: string) {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}
