# Appearance

Appearance settings (fonts, sizes, weights, colours, the diff and code themes, and per-box collapse defaults) are stored on the server and shared by every client connected to it. Named user themes layer an override diff over one of the built-in base themes, and each message box kind has its own background, border and accent. Font controls offer only the weights a font actually ships, with a continuous weight for fonts that have a variable axis. Diffs use the GitHub palette in every theme, the default colour scheme is dark, and floating surfaces over the transcript use frosted glass at four densities.

## How it works

### Server-stored preferences

| Route                       | Holds                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `/preference/appearance`    | the active look: font, size, weights, code and diff themes, CSS overrides per mode |
| `/preference/themes`        | named user themes (list, save, delete)                                             |
| `/preference/themes/active` | the id of the active user theme                                                    |
| `/preference/boxes`         | per-box-type collapse defaults, for normal and reader mode                         |

A user theme (`ThemePreference.Info`) is a built-in base (`baseId`) plus the same fields as the appearance record. Selecting one replaces the active base and replays its overrides and fonts. Themes support save-as, duplicate, rename and delete.

Changes publish preference events over the event stream. A client applies another client's change unless it has unsaved edits of its own, in which case its local edits win (`receive` in `packages/app/src/context/settings-sync.ts`).

### Colours and boxes

Overrides are CSS custom properties, kept separately for light and dark mode. Each message box kind (user, assistant, thinking, each tool) has independent background, border and accent tokens, and the session, dock and input-box surfaces are exposed as well. The customization pane is grouped by element.

Diff rows in edit and write tools use solid GitHub colours in every theme: green additions, red deletions, and GitHub's context colour for light and dark. The mode is keyed off the diff component's own colour-scheme attribute, driven by the app theme, rather than `light-dark()`, which follows the OS.

### Fonts

Each weight control is driven by the selected font's real faces, so a font that ships 400 and 700 offers those two. JetBrains Mono, Source Code Pro and Geist Mono bundle a variable woff2 ahead of their Nerd Font face, so their weight is a bounded numeric input that interpolates continuously while the Nerd face still supplies icon glyphs. Code-block and inline-code fonts are set separately.

### Colour scheme

The default scheme is dark. A saved preference wins, and "system" follows the OS.

### Glass

| Class          | Surface                    | Used by                                                                        |
| -------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `glass`        | 10% fill over an 8 px blur | the reader pill and other small floating pills                                 |
| `glass-medium` | 30% fill over a 16 px blur | the dictation and read-aloud panels, the scroll-to-bottom button               |
| `glass-dense`  | 55% fill over a 24 px blur | menus, selects, popovers, the hover card, the model picker, the question panel |
| `glass-heavy`  | 75% fill over a 24 px blur | the composer                                                                   |

Without `backdrop-filter` support, `glass` and `glass-medium` fall back to a mostly opaque fill so they still read as a surface. The dense values are the `--glass-dense` and `--glass-dense-blur` tokens in the UI theme stylesheet.

## Configuration

None in `opencode.json`. Everything here is set from Settings and stored through the preference routes.

## Why

- **Stored on the server.** Named themes were moved server-side so a look is shared by every client of the server.
- **Real font weights.** The weight inputs used to offer 100 to 900 while nearly every bundled font ships only 400 and 700, so most values snapped and did nothing.
- **GitHub diff colours.** Theme-derived diff colours were blended over the background, so additions and deletions were a faint wash until hovered, and they drifted per theme.
- **Dark by default.** Following the OS opened a machine in light mode in light, even though the theme is tuned for dark.
- **Glass levels.** Dense glass at 80% read as solid, so it dropped to 55%. Over the dimming scrim of the voice panels even 55% read as solid, so they got the lighter `glass-medium`; a popover holds text of its own and needs the denser surface.
- **No code-syntax colour group.** Fenced code is coloured by syntax highlighting, so a flat code-colour token group changed nothing and was removed.

## Code

| Area                | Pointer                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appearance record   | `packages/opencode/src/preference/appearance.ts` (`AppearancePreference`)                                                                                     |
| User themes         | `packages/opencode/src/preference/theme.ts` (`ThemePreference`)                                                                                               |
| Box defaults        | `packages/opencode/src/preference/boxes.ts` (`BoxPreference`)                                                                                                 |
| Routes              | `packages/opencode/src/server/routes/preference.ts` (`PreferenceRoutes`)                                                                                      |
| Customization UI    | `packages/app/src/components/settings-customization.tsx`                                                                                                      |
| Client sync         | `packages/app/src/context/settings-sync.ts` (`receive`)                                                                                                       |
| Base themes, scheme | `packages/ui/src/theme/` (`themes/`, `context.tsx`)                                                                                                           |
| Glass               | `packages/ui/src/styles/tailwind/utilities.css` (`glass`, `glass-medium`, `glass-dense`, `glass-heavy`), `packages/ui/src/styles/theme.css` (`--glass-dense`) |
