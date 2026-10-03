import { createStore, produce } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog, useDialogOpen } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/util/binary"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/utils/error-message"

export type SessionRef = { id: string; directory: string; title: string }

// Session lifecycle actions for the sidebar (rename, archive, the delete
// dialog) and the home overview (all of them). Each resolves to whether it
// succeeded; where to navigate afterwards differs per surface, so it stays
// with the caller.
export function useSessionActions() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()

  const fail = (title: string) => (err: unknown) => {
    showToast({ title, description: errorMessage(err, language.t("common.requestFailed")) })
    return false
  }

  // Ahead of the server's event, for a store this client already holds; the
  // event removes the same records everywhere else.
  const drop = (session: SessionRef, withDescendants: boolean) => {
    const setStore = globalSync.existing(session.directory)?.[1]
    if (!setStore) return
    setStore(
      produce((draft) => {
        if (!withDescendants) {
          const match = Binary.search(draft.session, session.id, (s) => s.id)
          if (match.found) draft.session.splice(match.index, 1)
          return
        }
        const removed = new Set([session.id])
        const stack = [session.id]
        while (stack.length) {
          const parent = stack.pop()
          for (const item of draft.session) {
            if (item.parentID !== parent || removed.has(item.id)) continue
            removed.add(item.id)
            stack.push(item.id)
          }
        }
        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )
  }

  // "unknown" when the check itself failed; callers refuse on it rather than
  // proceed, but say so instead of claiming the session is live.
  const live = (session: SessionRef): Promise<boolean | "unknown"> =>
    sdk.client.session
      .live({ directory: session.directory, sessionID: session.id })
      .then((x) => x.data?.live ?? ("unknown" as const))
      .catch(() => "unknown" as const)

  // Refuses (with a toast naming why) when the session is live or its liveness
  // could not be read. Asks the server, not the recent hub: an archived
  // session, or one aged out of the hub, can still be running.
  const idle = async (session: SessionRef, title: string) => {
    const state = await live(session)
    if (state === false) return true
    showToast({ title: state === true ? title : language.t("session.live.unknown.title") })
    return false
  }

  const starredRefusal = (action: "archive" | "delete") =>
    language.t(action === "archive" ? "session.archive.starred.title" : "session.delete.starred.title")

  return {
    rename: (session: SessionRef, title: string) => {
      const next = title.trim()
      if (!next || next === session.title) return Promise.resolve(true)
      return sdk.client.session
        .update({ directory: session.directory, sessionID: session.id, title: next })
        .then((x) => {
          if (x.data?.title !== next) throw new Error(language.t("common.requestFailed"))
          return true
        })
        .catch(fail(language.t("session.rename.failed.title")))
    },
    // Unguarded: the sidebar archives the session it has open, which a ping
    // keeps live. A surface that should refuse a live session calls `idle`
    // first (the overview's recent rows).
    archive: async (session: SessionRef) => {
      return sdk.client.session
        .update({ directory: session.directory, sessionID: session.id, time: { archived: Date.now() } })
        .then((x) => {
          if (!x.data?.time.archived) throw new Error(language.t("common.requestFailed"))
          drop(session, false)
          return true
        })
        .catch(fail(language.t("session.archive.failed.title")))
    },
    // No local insert: the session.updated event returns it to every client's
    // sidebar, this one included.
    unarchive: (session: SessionRef) =>
      sdk.client.session
        .update({ directory: session.directory, sessionID: session.id, time: { archived: null } })
        .then((x) => {
          if (x.data?.time.archived) throw new Error(language.t("common.requestFailed"))
          return true
        })
        .catch(fail(language.t("session.unarchive.failed.title"))),
    idle: (session: SessionRef, action: "archive" | "delete") =>
      idle(session, language.t(action === "archive" ? "session.archive.live.title" : "session.delete.live.title")),
    star: (session: SessionRef, starred: boolean) =>
      sdk.client.session
        .update({ directory: session.directory, sessionID: session.id, starred })
        .then((x) => {
          if ((x.data?.starred === true) !== starred) throw new Error(language.t("common.requestFailed"))
          return true
        })
        .catch(fail(language.t(starred ? "session.star.failed.title" : "session.unstar.failed.title"))),
    // A menu shows the reason on the disabled item; a keybind, which has no
    // item, toasts it.
    starredRefusal,
    refuseStarred: (action: "archive" | "delete") => showToast({ title: starredRefusal(action) }),
    delete: (session: SessionRef) =>
      sdk.client.session
        .delete({ directory: session.directory, sessionID: session.id })
        .then((x) => {
          if (!x.data) throw new Error(language.t("common.requestFailed"))
          drop(session, true)
          return true
        })
        .catch(fail(language.t("session.delete.failed.title"))),
  }
}

// `before` runs at confirm time, ahead of the delete, for a caller that must
// read state the delete removes (the sidebar's next session to show). `guard`
// refuses a live session at confirm time: the server deletes a busy one without
// complaint, and a row shown as not live can start working while the confirm is
// up. The sidebar leaves it off, since the session it deletes is usually the
// one open and kept warm, and the server stops a session before removing it.
// Dismissing before the delete is sent cancels it; after, the delete stands.
export function DialogDeleteSession(props: {
  session: SessionRef
  guard?: boolean
  before?: () => void
  onDeleted?: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const actions = useSessionActions()
  const open = useDialogOpen()
  const [state, setState] = createStore({ busy: false })

  const confirm = async () => {
    setState("busy", true)
    const idle = props.guard ? await actions.idle(props.session, "delete") : true
    if (!open()) return
    if (!idle) {
      setState("busy", false)
      dialog.close()
      return
    }
    props.before?.()
    const ok = await actions.delete(props.session)
    if (ok) props.onDeleted?.()
    if (!open()) return
    setState("busy", false)
    dialog.close()
  }

  return (
    <Dialog title={language.t("session.delete.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <span class="text-14-regular text-text-strong">
          {language.t("session.delete.confirm", { name: props.session.title })}
        </span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" disabled={state.busy} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={state.busy} onClick={confirm} autofocus>
            {language.t("session.delete.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function DialogRenameSession(props: { session: SessionRef }) {
  const dialog = useDialog()
  const language = useLanguage()
  const actions = useSessionActions()
  const open = useDialogOpen()
  const [state, setState] = createStore({ title: props.session.title, busy: false })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setState("busy", true)
    const ok = await actions.rename(props.session, state.title)
    if (!open()) return
    setState("busy", false)
    if (ok) dialog.close()
  }

  return (
    <Dialog title={language.t("session.rename.title")} class="w-full max-w-[480px] mx-auto">
      <form onSubmit={submit} class="flex flex-col gap-6 p-6 pt-0">
        <TextField
          autofocus
          type="text"
          label={language.t("session.rename.label")}
          value={state.title}
          onChange={(value) => setState("title", value)}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={state.busy || !state.title.trim()}>
            {language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
