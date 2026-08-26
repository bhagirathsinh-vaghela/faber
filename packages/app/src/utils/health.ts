// What the connection indicator is allowed to claim.
//
// Two independent facts feed it, and they answer different questions:
//   polled - can an HTTP request reach the server right now?
//   stream - is the live event stream attached and delivering?
//
// Only the stream can support the claim the user actually reads off a green
// dot, which is "what I am looking at is current". A reachable server with a
// dead stream is a page that will happily sit on a stale transcript, so
// collapsing the two into one boolean made the indicator assert freshness it
// could not verify — precisely the state a suspended mobile tab wakes into,
// since the poll always recovers and the stream frequently does not.
//
// Hence three states, not two. `live` is the only one that promises currency;
// `stale` says reachable-but-not-listening, which is what a detached tab and a
// half-open socket both are.

export type Health = "live" | "stale" | "down" | undefined

export function health(input: { polled?: boolean; stream?: boolean }): Health {
  // A stream that is attached and delivering is POSITIVE PROOF of a working
  // connection, and it outranks a failed poll. On a slow cellular link a poll
  // routinely times out while the stream is healthily delivering events, and
  // trusting the poll there would report a dead server the user can watch
  // working. Evidence that something succeeded beats evidence that something
  // else was slow.
  if (input.stream === true) return "live"
  if (input.polled === false) return "down"
  if (input.stream === false && input.polled === undefined) return "down"
  // Reachable, but nothing is feeding us events. Recoverable and usually
  // brief, so it is not a failure — but it is not currency either.
  if (input.polled === true) return "stale"
  return undefined
}
