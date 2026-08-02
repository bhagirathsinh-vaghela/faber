// Bun resolves `with { type: "file" }` to the asset's on-disk path, and embeds
// the asset in a compiled binary. TypeScript has no built-in knowledge of it.
declare module "*.wasm" {
  const path: string
  export default path
}
