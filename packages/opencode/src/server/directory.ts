export namespace Directory {
  // The directory a request targets: the query parameter, else the header, else
  // the server's own. Hono hands back a query value already decoded (hono 4.10.7
  // dist/utils/url.js: a value holding "%" goes through decodeURIComponent); the
  // header arrives URI-encoded (SDK directoryHeader), so only the header is decoded.
  export function from(req: { query(name: string): string | undefined; header(name: string): string | undefined }) {
    const query = req.query("directory")
    if (query) return query
    const header = req.header("x-opencode-directory")
    if (!header) return process.cwd()
    try {
      return decodeURIComponent(header)
    } catch {
      return header
    }
  }
}
