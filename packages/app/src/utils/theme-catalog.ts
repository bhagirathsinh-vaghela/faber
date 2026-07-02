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

export const THEME_CATALOG: TokenGroup[] = [
  {
    group: "Body text",
    entries: [
      { token: "--text-base", label: "Color", type: "color" },
      { token: "--text-base-weight", label: "Weight", type: "weight" },
    ],
  },
  {
    group: "Headings",
    entries: [
      { token: "--markdown-heading", label: "Color (all levels)", type: "color" },
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
    group: "Inline styles",
    entries: [
      { token: "--markdown-strong", label: "Bold color", type: "color" },
      { token: "--markdown-emph", label: "Italic color", type: "color" },
      { token: "--markdown-code", label: "Inline code color", type: "color" },
      { token: "--markdown-code-family", label: "Inline code font", type: "family" },
      { token: "--markdown-code-weight", label: "Inline code weight", type: "weight" },
      { token: "--markdown-code-size", label: "Inline code size", type: "size" },
      { token: "--markdown-link", label: "Link color", type: "color" },
    ],
  },
  {
    group: "Lists & quotes",
    entries: [
      { token: "--markdown-list-item", label: "Bullet color", type: "color" },
      { token: "--markdown-list-enumeration", label: "Number color", type: "color" },
      { token: "--text-weak", label: "Blockquote / caption color", type: "color", shared: "secondary text" },
    ],
  },
  {
    group: "Text tiers",
    entries: [
      { token: "--text-strong", label: "Strong text (input, filenames)", type: "color" },
      { token: "--text-weak", label: "Secondary text", type: "color", shared: "blockquotes" },
      { token: "--text-weaker", label: "Muted text (timestamps, todos)", type: "color" },
    ],
  },
  {
    group: "Code block syntax",
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
  {
    group: "Semantic",
    entries: [
      { token: "--text-critical-base", label: "Error text", type: "color" },
      { token: "--text-success-base", label: "Success text", type: "color" },
      { token: "--text-warning-base", label: "Warning text", type: "color" },
    ],
  },
  {
    group: "Chat boxes",
    entries: [
      { token: "--box-accent-assistant", label: "Assistant box accent", type: "color" },
      { token: "--box-accent-task", label: "Task box accent", type: "color" },
      { token: "--box-accent-tool", label: "Tool box accent", type: "color" },
    ],
  },
  {
    group: "Backgrounds",
    entries: [
      { token: "--background-base", label: "Page background", type: "color" },
      { token: "--surface-base", label: "Surface", type: "color" },
      { token: "--surface-raised-base", label: "Raised surface", type: "color" },
      { token: "--border-weak-base", label: "Subtle border", type: "color" },
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
