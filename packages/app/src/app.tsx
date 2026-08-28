import "@/index.css"
import { ErrorBoundary, Show, type ParentProps } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@opencode-ai/ui/font"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { DiffComponentProvider } from "@opencode-ai/ui/context/diff"
import { CodeComponentProvider } from "@opencode-ai/ui/context/code"
import { I18nProvider } from "@opencode-ai/ui/context"
import { CodeThemeProvider } from "@opencode-ai/ui/context/code-theme"
import { DiffThemeProvider } from "@opencode-ai/ui/context/diff-theme"
import { Diff } from "@opencode-ai/ui/diff"
import { Code } from "@opencode-ai/ui/code"
import { ThemeProvider } from "@opencode-ai/ui/theme"
import { GlobalSyncProvider } from "@/context/global-sync"
import { PermissionProvider } from "@/context/permission"
import { LayoutProvider, useLayout } from "@/context/layout"
import { BoxDefaultsProvider } from "@opencode-ai/ui/context/box-defaults"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { normalizeServerUrl, ServerProvider, useServer } from "@/context/server"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { StashProvider } from "@/context/stash"
import { FileProvider } from "@/context/file"
import { CommentsProvider } from "@/context/comments"
import { ModelsProvider } from "@/context/models"
import { RecentProvider } from "@/context/recent"
import { TickerProvider } from "@/context/ticker"
import { MruProvider } from "@/context/mru"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { CommandProvider } from "@/context/command"
import { LanguageProvider, useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { HighlightsProvider } from "@/context/highlights"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "./pages/error"
import { lazy, loadChunk } from "@/utils/chunk"
import { Suspense } from "solid-js"

// eagerly start fetching the route chunks at boot so they download in parallel
// with the main bundle instead of after the route matches — the session
// transcript can't paint until this chunk is loaded
const sessionChunk = () => import("@/pages/session")
const Home = lazy(() => import("@/pages/home"))
const Session = lazy(sessionChunk)
// The boot-time warm fetch is the request most likely to meet a flaky link, and
// an unhandled rejection here would surface as a console error for a failure the
// route load already retries on its own.
loadChunk(sessionChunk).catch(() => undefined)
const Loading = () => <div class="size-full" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.locale, t: language.t }}>{props.children}</I18nProvider>
}

// Feeds the user's chosen code-block theme (appearance setting) into the ui
// package's CodeTheme context, so Markdown code fences highlight with it.
function CodeThemeBridge(props: ParentProps) {
  const settings = useSettings()
  return <CodeThemeProvider value={settings.appearance.codeTheme}>{props.children}</CodeThemeProvider>
}

// Feeds the user's chosen diff theme (appearance setting) into the ui package's
// DiffTheme context, so edit/apply_patch diff previews highlight with it.
function DiffThemeBridge(props: ParentProps) {
  const settings = useSettings()
  return <DiffThemeProvider value={settings.appearance.diffTheme}>{props.children}</DiffThemeProvider>
}

// Feeds the per-box collapse defaults + current view mode into the ui package's
// BoxDefaults context, so transcript boxes pick their default open state per
// mode. Must sit inside both SettingsProvider and LayoutProvider.
function BoxDefaultsBridge(props: ParentProps) {
  const settings = useSettings()
  const layout = useLayout()
  return (
    <BoxDefaultsProvider
      mode={() => (layout.reader.opened() ? "reader" : "normal")}
      collapsed={settings.boxes.collapsed}
      open={layout.boxes.open}
      setOpen={layout.boxes.setOpen}
    >
      {props.children}
    </BoxDefaultsProvider>
  )
}

declare global {
  interface Window {
    __OPENCODE__?: { updaterEnabled?: boolean; serverPassword?: string; deepLinks?: string[] }
  }
}

function MarkedProviderWithNativeParser(props: ParentProps) {
  const platform = usePlatform()
  return <MarkedProvider nativeParser={platform.parseMarkdown}>{props.children}</MarkedProvider>
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <LanguageProvider>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <DialogProvider>
                <MarkedProviderWithNativeParser>
                  <DiffComponentProvider component={Diff}>
                    <CodeComponentProvider component={Code}>{props.children}</CodeComponentProvider>
                  </DiffComponentProvider>
                </MarkedProviderWithNativeParser>
              </DialogProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.url} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: { defaultUrl?: string }) {
  const platform = usePlatform()

  const stored = (() => {
    if (platform.platform !== "web") return
    const result = platform.getDefaultServerUrl?.()
    if (result instanceof Promise) return
    if (!result) return
    return normalizeServerUrl(result)
  })()

  const defaultServerUrl = () => {
    if (props.defaultUrl) return props.defaultUrl
    if (stored) return stored
    if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
    if (import.meta.env.DEV)
      return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`

    return window.location.origin
  }

  return (
    <ServerProvider defaultUrl={defaultServerUrl()}>
      <ServerKey>
        <GlobalSDKProvider>
          <GlobalSyncProvider>
            <Router
              root={(props) => (
                <TickerProvider>
                  <SettingsProvider>
                    <CodeThemeBridge>
                      <DiffThemeBridge>
                        <PermissionProvider>
                          <LayoutProvider>
                            <BoxDefaultsBridge>
                              <ModelsProvider>
                                <CommandProvider>
                                  <HighlightsProvider>
                                    <MruProvider>
                                      <RecentProvider>
                                        <Layout>{props.children}</Layout>
                                      </RecentProvider>
                                    </MruProvider>
                                  </HighlightsProvider>
                                </CommandProvider>
                              </ModelsProvider>
                            </BoxDefaultsBridge>
                          </LayoutProvider>
                        </PermissionProvider>
                      </DiffThemeBridge>
                    </CodeThemeBridge>
                  </SettingsProvider>
                </TickerProvider>
              )}
            >
              <Route
                path="/"
                component={() => (
                  <Suspense fallback={<Loading />}>
                    <Home />
                  </Suspense>
                )}
              />
              <Route path="/:dir" component={DirectoryLayout}>
                <Route path="/" component={() => <Navigate href="session" />} />
                <Route
                  path="/session/:id?"
                  component={(p) => (
                    <Show when={p.params.id ?? "new"}>
                      <TerminalProvider>
                        <FileProvider>
                          <PromptProvider>
                            <StashProvider>
                              <CommentsProvider>
                                <Suspense fallback={<Loading />}>
                                  <Session />
                                </Suspense>
                              </CommentsProvider>
                            </StashProvider>
                          </PromptProvider>
                        </FileProvider>
                      </TerminalProvider>
                    </Show>
                  )}
                />
              </Route>
            </Router>
          </GlobalSyncProvider>
        </GlobalSDKProvider>
      </ServerKey>
    </ServerProvider>
  )
}
