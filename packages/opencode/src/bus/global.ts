import { EventEmitter } from "events"

export const GlobalBus = new EventEmitter<{
  event: [
    {
      directory?: string
      payload: any
    },
  ]
}>()

// One listener per connected SSE client. Many devices/tabs on one server is
// normal here, so the default cap of 10 would fire a spurious leak warning.
GlobalBus.setMaxListeners(0)
