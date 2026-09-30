export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

// Header values must be ByteStrings (the Headers IDL takes ByteString values:
// fetch.spec.whatwg.org/#headers-class), so the path is always URI-encoded, and
// the server always decodes it; encoding only a non-ASCII path would let a
// literal "%41" in an ASCII one be decoded.
export function directoryHeader(directory: string) {
  return encodeURIComponent(directory)
}

export function createOpencodeClient(config?: Config & { directory?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-opencode-directory": directoryHeader(config.directory),
    }
  }

  const client = createClient(config)
  return new OpencodeClient({ client })
}
