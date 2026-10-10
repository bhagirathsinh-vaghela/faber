// A theme override is keyed by CSS custom-property name, so a token whose name
// changes orphans every override a user already saved under the old one: it
// stops matching anything and their customized colour silently reverts, with
// nothing to say why. The old names are read forward here, the way a renamed
// config key is aliased.
const RENAMED: Record<string, string> = {
  "--box-accent-task": "--box-accent-subagent",
}

function mode(overrides: Record<string, string>) {
  let renamed: Record<string, string> | undefined
  for (const [old, current] of Object.entries(RENAMED)) {
    if (!(old in overrides)) continue
    renamed ??= { ...overrides }
    // A value saved under the current name is the user's later choice.
    if (!(current in overrides)) renamed[current] = overrides[old]
    delete renamed[old]
  }
  return renamed ?? overrides
}

export function legacyOverrides<
  T extends { overrides: { light: Record<string, string>; dark: Record<string, string> } },
>(value: T): T {
  const light = mode(value.overrides.light)
  const dark = mode(value.overrides.dark)
  if (light === value.overrides.light && dark === value.overrides.dark) return value
  return { ...value, overrides: { light, dark } }
}
