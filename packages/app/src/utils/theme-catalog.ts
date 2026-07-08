// Curated catalog of theme tokens exposed in the Customization settings pane,
// grouped by the chat element they affect (not by internal token name). Each
// entry maps a human label to the CSS custom property the chat UI actually
// reads. `type` drives which editor renders; `shared` notes when a token also
// styles another element so edits aren't surprising.

export type TokenType = "color" | "weight" | "size" | "family"

export interface TokenEntry {
  token: string
  label: string
  type: TokenType
  shared?: string
}

export interface TokenGroup {
  group: string
  entries: TokenEntry[]
}

// Groups are ordered most-reached first (surfaces, then chat boxes, then text,
// then markdown, then code). Related concerns are merged into one section so a
// setting is where you'd expect it (all background surfaces together, all text
// tiers together) rather than scattered across the list.
export const THEME_CATALOG: TokenGroup[] = [
  {
    group: "Surfaces & backgrounds",
    entries: [
      { token: "--background-base", label: "Page background", type: "color" },
      {
        token: "--background-stronger",
        label: "Session & dock background",
        type: "color",
        shared: "message area and prompt dock",
      },
      {
        token: "--surface-raised-stronger-non-alpha",
        label: "Input box background",
        type: "color",
        shared: "mention popup and thumbnails",
      },
      { token: "--background-weak", label: "Recessed background", type: "color" },
      { token: "--background-strong", label: "Raised background", type: "color" },
      { token: "--surface-base", label: "Surface", type: "color" },
      { token: "--surface-raised-base", label: "Raised surface", type: "color" },
      { token: "--border-weak-base", label: "Subtle border", type: "color" },
    ],
  },
  {
    group: "Message boxes",
    entries: [
      { token: "--box-bg-user", label: "User box background", type: "color" },
      { token: "--box-border-user", label: "User box border", type: "color" },
      { token: "--box-accent-user", label: "User box accent", type: "color" },
      { token: "--box-bg-assistant", label: "Assistant box background", type: "color" },
      { token: "--box-border-assistant", label: "Assistant box border", type: "color" },
      { token: "--box-accent-assistant", label: "Assistant box accent", type: "color" },
      { token: "--box-bg-task", label: "Task box background", type: "color" },
      { token: "--box-border-task", label: "Task box border", type: "color" },
      { token: "--box-accent-task", label: "Task box accent", type: "color" },
      { token: "--box-bg-tool", label: "Tool box background", type: "color" },
      { token: "--box-border-tool", label: "Tool box border", type: "color" },
      { token: "--box-accent-tool", label: "Tool box accent", type: "color" },
    ],
  },
  {
    group: "Text",
    entries: [
      { token: "--text-base", label: "Body text color", type: "color" },
      { token: "--text-base-weight", label: "Body text weight", type: "weight" },
      { token: "--text-strong", label: "Strong text (input, filenames)", type: "color" },
      { token: "--text-weak", label: "Secondary text (blockquotes, captions)", type: "color" },
      { token: "--text-weaker", label: "Muted text (timestamps, todos)", type: "color" },
      { token: "--text-critical-base", label: "Error text", type: "color" },
      { token: "--text-success-base", label: "Success text", type: "color" },
      { token: "--text-warning-base", label: "Warning text", type: "color" },
    ],
  },
  {
    group: "Markdown",
    entries: [
      { token: "--markdown-heading", label: "Heading color (all levels)", type: "color" },
      { token: "--markdown-strong", label: "Bold color", type: "color" },
      { token: "--markdown-emph", label: "Italic color", type: "color" },
      { token: "--markdown-link", label: "Link color", type: "color" },
      { token: "--markdown-list-item", label: "Bullet color", type: "color" },
      { token: "--markdown-list-enumeration", label: "Number color", type: "color" },
      { token: "--markdown-code", label: "Inline code color", type: "color" },
      { token: "--markdown-code-family", label: "Inline code font", type: "family" },
      { token: "--markdown-code-weight", label: "Inline code weight", type: "weight" },
      { token: "--markdown-code-size", label: "Inline code size", type: "size" },
      { token: "--markdown-heading-1-size", label: "H1 size", type: "size" },
      { token: "--markdown-heading-1-weight", label: "H1 weight", type: "weight" },
      { token: "--markdown-heading-2-size", label: "H2 size", type: "size" },
      { token: "--markdown-heading-2-weight", label: "H2 weight", type: "weight" },
      { token: "--markdown-heading-3-size", label: "H3 size", type: "size" },
      { token: "--markdown-heading-3-weight", label: "H3 weight", type: "weight" },
      { token: "--markdown-heading-4-size", label: "H4 size", type: "size" },
      { token: "--markdown-heading-4-weight", label: "H4 weight", type: "weight" },
      { token: "--markdown-heading-5-size", label: "H5 size", type: "size" },
      { token: "--markdown-heading-5-weight", label: "H5 weight", type: "weight" },
      { token: "--markdown-heading-6-size", label: "H6 size", type: "size" },
      { token: "--markdown-heading-6-weight", label: "H6 weight", type: "weight" },
    ],
  },
  {
    group: "Code syntax",
    entries: [
      { token: "--syntax-keyword", label: "Keyword", type: "color" },
      { token: "--syntax-string", label: "String", type: "color" },
      { token: "--syntax-primitive", label: "Number / primitive", type: "color" },
      { token: "--syntax-property", label: "Property", type: "color" },
      { token: "--syntax-type", label: "Type", type: "color" },
      { token: "--syntax-constant", label: "Constant", type: "color" },
      { token: "--syntax-variable", label: "Variable", type: "color" },
      { token: "--syntax-operator", label: "Operator", type: "color" },
      { token: "--syntax-punctuation", label: "Punctuation", type: "color" },
      { token: "--syntax-comment", label: "Comment", type: "color" },
    ],
  },
]

// Selectable mono fonts (value = settings key resolved to a CSS family stack via
// monoFontFamily; label = i18n key). Shared by the Fonts pane and the inline-code
// font editor.
export const FONT_OPTIONS = [
  { value: "jetbrains-mono", label: "font.option.jetbrainsMono" },
  { value: "monaspace-neon", label: "font.option.monaspaceNeon" },
  { value: "geist-mono", label: "font.option.geistMono" },
  { value: "commit-mono", label: "font.option.commitMono" },
  { value: "maple-mono", label: "font.option.mapleMono" },
  { value: "fira-code", label: "font.option.firaCode" },
  { value: "cascadia-code", label: "font.option.cascadiaCode" },
  { value: "hack", label: "font.option.hack" },
  { value: "source-code-pro", label: "font.option.sourceCodePro" },
  { value: "inconsolata", label: "font.option.inconsolata" },
  { value: "intel-one-mono", label: "font.option.intelOneMono" },
  { value: "iosevka", label: "font.option.iosevka" },
  { value: "meslo-lgs", label: "font.option.mesloLgs" },
  { value: "roboto-mono", label: "font.option.robotoMono" },
  { value: "ubuntu-mono", label: "font.option.ubuntuMono" },
  { value: "ibm-plex-mono", label: "font.option.ibmPlexMono" },
] as const

// Code-block syntax-highlight themes. Each `value` is a stock Shiki bundled
// theme name (resolved by @pierre/diffs' bundled-theme fallback in
// highlightCode); label is a plain display name. Curated set of well-known,
// proven themes — github-dark is the default.
export const CODE_THEME_OPTIONS = [
  { value: "github-dark", label: "GitHub Dark" },
  { value: "github-dark-dimmed", label: "GitHub Dark Dimmed" },
  { value: "github-light", label: "GitHub Light" },
  { value: "dracula", label: "Dracula" },
  { value: "nord", label: "Nord" },
  { value: "one-dark-pro", label: "One Dark Pro" },
  { value: "monokai", label: "Monokai" },
  { value: "vitesse-dark", label: "Vitesse Dark" },
  { value: "vitesse-light", label: "Vitesse Light" },
  { value: "catppuccin-mocha", label: "Catppuccin Mocha" },
  { value: "tokyo-night", label: "Tokyo Night" },
  { value: "solarized-dark", label: "Solarized Dark" },
] as const
