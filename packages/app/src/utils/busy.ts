import { busyShown, type BusyFacts } from "@opencode-ai/ui/util/busy-tint"

// Sessions marked busy on Send before the server's turn exists. A complete frame
// computed in that gap omits them and must not undo the press; the hold expires
// so a lost confirmation cannot pin a dot on.
const HOLD_MS = 30_000
const pressed = new Map<string, number>()

export function hold(id: string, now = Date.now()) {
  pressed.set(id, now)
}

export function release(id: string) {
  pressed.delete(id)
}

// The ids shown busy that a complete frame omits. That frame lists every active
// session on the server, so each of these went idle through a missed push.
export function stale(shown: Record<string, BusyFacts>, live: Record<string, unknown>, now = Date.now()) {
  return Object.entries(shown)
    .filter(([id, facts]) => !(id in live) && busyShown(facts) && !(now - (pressed.get(id) ?? -HOLD_MS) < HOLD_MS))
    .map(([id]) => id)
}
