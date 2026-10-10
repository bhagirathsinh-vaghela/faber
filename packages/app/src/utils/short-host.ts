// The first label of a hostname (my-host.example.ts.net:4096 -> my-host). An
// IPv4 address has no such label, so it is kept whole.
export function shortHost(name: string) {
  const host = name.replace(/:\d+$/, "")
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host
  return host.split(".")[0] || name
}
