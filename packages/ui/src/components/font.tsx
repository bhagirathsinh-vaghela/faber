import { Style, Link } from "@solidjs/meta"
import inter from "../assets/fonts/inter.woff2"
import ibmPlexMonoRegular from "../assets/fonts/ibm-plex-mono.woff2"
import ibmPlexMonoMedium from "../assets/fonts/ibm-plex-mono-medium.woff2"
import ibmPlexMonoBold from "../assets/fonts/ibm-plex-mono-bold.woff2"

import jetbrainsMonoVariable from "../assets/fonts/jetbrains-mono-variable.woff2"
import sourceCodeProVariable from "../assets/fonts/source-code-pro-variable.woff2"
import geistMonoVariable from "../assets/fonts/geist-mono-variable.woff2"

import cascadiaCode from "../assets/fonts/cascadia-code-nerd-font.woff2"
import cascadiaCodeBold from "../assets/fonts/cascadia-code-nerd-font-bold.woff2"
import firaCode from "../assets/fonts/fira-code-nerd-font.woff2"
import firaCodeBold from "../assets/fonts/fira-code-nerd-font-bold.woff2"
import hack from "../assets/fonts/hack-nerd-font.woff2"
import hackBold from "../assets/fonts/hack-nerd-font-bold.woff2"
import inconsolata from "../assets/fonts/inconsolata-nerd-font.woff2"
import inconsolataBold from "../assets/fonts/inconsolata-nerd-font-bold.woff2"
import intelOneMono from "../assets/fonts/intel-one-mono-nerd-font.woff2"
import intelOneMonoBold from "../assets/fonts/intel-one-mono-nerd-font-bold.woff2"
import jetbrainsMono from "../assets/fonts/jetbrains-mono-nerd-font.woff2"
import jetbrainsMonoBold from "../assets/fonts/jetbrains-mono-nerd-font-bold.woff2"
import mesloLgs from "../assets/fonts/meslo-lgs-nerd-font.woff2"
import mesloLgsBold from "../assets/fonts/meslo-lgs-nerd-font-bold.woff2"
import robotoMono from "../assets/fonts/roboto-mono-nerd-font.woff2"
import robotoMonoBold from "../assets/fonts/roboto-mono-nerd-font-bold.woff2"
import sourceCodePro from "../assets/fonts/source-code-pro-nerd-font.woff2"
import sourceCodeProBold from "../assets/fonts/source-code-pro-nerd-font-bold.woff2"
import ubuntuMono from "../assets/fonts/ubuntu-mono-nerd-font.woff2"
import ubuntuMonoBold from "../assets/fonts/ubuntu-mono-nerd-font-bold.woff2"
import iosevka from "../assets/fonts/iosevka-nerd-font.woff2"
import iosevkaBold from "../assets/fonts/iosevka-nerd-font-bold.woff2"
import geistMono from "../assets/fonts/geist-mono.woff2"
import geistMonoBold from "../assets/fonts/geist-mono-bold.woff2"
import monaspaceNeon from "../assets/fonts/monaspace-neon.woff2"
import monaspaceNeonBold from "../assets/fonts/monaspace-neon-bold.woff2"
import commitMono from "../assets/fonts/commit-mono.woff2"
import commitMonoBold from "../assets/fonts/commit-mono-bold.woff2"
import mapleMono from "../assets/fonts/maple-mono.woff2"
import mapleMonoBold from "../assets/fonts/maple-mono-bold.woff2"

type MonoFont = {
  family: string
  regular: string
  bold: string
}

export const MONO_NERD_FONTS = [
  {
    // Match the system-installed family name (iTerm2 uses "JetBrainsMono Nerd
    // Font", no space in "JetBrainsMono"). Registering the bundled woff2 under
    // this exact name means the web UI renders identically to the terminal
    // whether or not the font is installed locally.
    family: "JetBrainsMono Nerd Font",
    regular: jetbrainsMono,
    bold: jetbrainsMonoBold,
  },
  {
    family: "JetBrains Mono Nerd Font",
    regular: jetbrainsMono,
    bold: jetbrainsMonoBold,
  },
  {
    family: "Fira Code Nerd Font",
    regular: firaCode,
    bold: firaCodeBold,
  },
  {
    family: "Cascadia Code Nerd Font",
    regular: cascadiaCode,
    bold: cascadiaCodeBold,
  },
  {
    family: "Hack Nerd Font",
    regular: hack,
    bold: hackBold,
  },
  {
    family: "Source Code Pro Nerd Font",
    regular: sourceCodePro,
    bold: sourceCodeProBold,
  },
  {
    family: "Inconsolata Nerd Font",
    regular: inconsolata,
    bold: inconsolataBold,
  },
  {
    family: "Roboto Mono Nerd Font",
    regular: robotoMono,
    bold: robotoMonoBold,
  },
  {
    family: "Ubuntu Mono Nerd Font",
    regular: ubuntuMono,
    bold: ubuntuMonoBold,
  },
  {
    family: "Intel One Mono Nerd Font",
    regular: intelOneMono,
    bold: intelOneMonoBold,
  },
  {
    family: "Meslo LGS Nerd Font",
    regular: mesloLgs,
    bold: mesloLgsBold,
  },
  {
    family: "Iosevka Nerd Font",
    regular: iosevka,
    bold: iosevkaBold,
  },
  {
    family: "Geist Mono",
    regular: geistMono,
    bold: geistMonoBold,
  },
  {
    family: "Monaspace Neon",
    regular: monaspaceNeon,
    bold: monaspaceNeonBold,
  },
  {
    family: "Commit Mono",
    regular: commitMono,
    bold: commitMonoBold,
  },
  {
    family: "Maple Mono",
    regular: mapleMono,
    bold: mapleMonoBold,
  },
] satisfies MonoFont[]

// The real weights each bundled font can render, keyed by the settings font id
// (FONT_OPTIONS value). A font's @font-face set below registers exactly these
// faces, so the weight picker must offer only these values — anything else the
// browser snaps to the nearest face. `list` = discrete static weights.
// Fonts gain a continuous `{ min, max, step }` range here once a variable
// woff2 is bundled for them.
export type FontWeights = { list: number[] } | { min: number; max: number; step: number }

export const FONT_WEIGHTS: Record<string, FontWeights> = {
  "ibm-plex-mono": { list: [400, 500, 700] },
  "jetbrains-mono": { min: 100, max: 800, step: 10 },
  "monaspace-neon": { list: [400, 700] },
  "geist-mono": { min: 100, max: 900, step: 10 },
  "commit-mono": { list: [400, 700] },
  "maple-mono": { list: [400, 700] },
  "fira-code": { list: [400, 700] },
  "cascadia-code": { list: [400, 700] },
  hack: { list: [400, 700] },
  "source-code-pro": { min: 200, max: 900, step: 10 },
  inconsolata: { list: [400, 700] },
  "intel-one-mono": { list: [400, 700] },
  iosevka: { list: [400, 700] },
  "meslo-lgs": { list: [400, 700] },
  "roboto-mono": { list: [400, 700] },
  "ubuntu-mono": { list: [400, 700] },
}

const monoNerdCss = MONO_NERD_FONTS.map(
  (font) => `
        @font-face {
          font-family: "${font.family}";
          src: url("${font.regular}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 400;
        }
        @font-face {
          font-family: "${font.family}";
          src: url("${font.bold}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 700;
        }`,
).join("")

export const Font = () => {
  return (
    <>
      <Style>{`
        @font-face {
          font-family: "Inter";
          src: url("${inter}") format("woff2-variations");
          font-display: swap;
          font-style: normal;
          font-weight: 100 900;
        }
        @font-face {
          font-family: "Inter Fallback";
          src: local("Arial");
          size-adjust: 100%;
          ascent-override: 97%;
          descent-override: 25%;
          line-gap-override: 1%;
        }
        @font-face {
          font-family: "JetBrains Mono Variable";
          src: url("${jetbrainsMonoVariable}") format("woff2-variations");
          font-display: swap;
          font-style: normal;
          font-weight: 100 800;
        }
        @font-face {
          font-family: "Source Code Pro Variable";
          src: url("${sourceCodeProVariable}") format("woff2-variations");
          font-display: swap;
          font-style: normal;
          font-weight: 200 900;
        }
        @font-face {
          font-family: "Geist Mono Variable";
          src: url("${geistMonoVariable}") format("woff2-variations");
          font-display: swap;
          font-style: normal;
          font-weight: 100 900;
        }
        @font-face {
          font-family: "IBM Plex Mono";
          src: url("${ibmPlexMonoRegular}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 400;
        }
        @font-face {
          font-family: "IBM Plex Mono";
          src: url("${ibmPlexMonoMedium}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 500;
        }
        @font-face {
          font-family: "IBM Plex Mono";
          src: url("${ibmPlexMonoBold}") format("woff2");
          font-display: swap;
          font-style: normal;
          font-weight: 700;
        }
        @font-face {
          font-family: "IBM Plex Mono Fallback";
          src: local("Courier New");
          size-adjust: 100%;
          ascent-override: 97%;
          descent-override: 25%;
          line-gap-override: 1%;
        }
${monoNerdCss}
      `}</Style>
      <Link rel="preload" href={inter} as="font" type="font/woff2" crossorigin="anonymous" />
      <Link rel="preload" href={ibmPlexMonoRegular} as="font" type="font/woff2" crossorigin="anonymous" />
      <Link rel="preload" href={jetbrainsMonoVariable} as="font" type="font/woff2" crossorigin="anonymous" />
    </>
  )
}
