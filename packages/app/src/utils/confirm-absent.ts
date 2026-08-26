// Decide whether a pre-allocated message is truly absent after a send failed,
// used to gate restoring the draft into the input. The read runs across the same
// window that dropped the send, so its answer is trustworthy only under three
// rules:
//
//   found       -> the message exists, not absent. Stop immediately.
//   NotFound    -> maybe absent, maybe the write still settling behind a
//                  just-recovered server. Believe it only if it HOLDS across
//                  every retry.
//   read failed -> the connection is still unhealthy. Unknown, not absent, so
//                  never restore on it.
//
// Only an unbroken run of NotFound answers returns true. Anything else (a find,
// or a read that could not complete) returns false, so a draft is restored only
// when the server has affirmatively and repeatedly denied the message over a
// working connection.
const ATTEMPTS = 3
const DELAY_MS = 400

function isNotFound(error: unknown) {
  return (error as { name?: string })?.name === "NotFoundError"
}

export async function confirmAbsent(
  read: () => Promise<unknown>,
  options: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? ATTEMPTS
  const delayMs = options.delayMs ?? DELAY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 0; attempt < attempts; attempt++) {
    const notFound = await read().then(
      () => false,
      (error) => isNotFound(error),
    )
    if (!notFound) return false
    if (attempt < attempts - 1) await sleep(delayMs)
  }
  return true
}
