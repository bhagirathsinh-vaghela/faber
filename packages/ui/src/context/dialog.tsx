import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { captureFocus } from "../util/focus"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
  restore: () => boolean
}

const Context = createContext<ReturnType<typeof init>>()
// Per dialog, provided to its own content: whether close() has started for it.
const Instance = createContext<() => boolean>()

function init() {
  const [active, setActive] = createSignal<Active | undefined>()
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }
  // Where focus goes when a dialog closes. The app registers this (it points at
  // the prompt input) since this context lives below the app layer and can't
  // reach the prompt itself. Skipped when something already claimed focus.
  const restore = { current: undefined as (() => void) | undefined }

  onCleanup(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  // A dialog left focus behind if the active element is the body, the overlay,
  // or nothing at all — i.e. Kobalte's default trigger-restore or a plain
  // dismiss. If a real element holds focus (a session dock, a chained dialog's
  // input) the close was intentional about focus, so leave it alone.
  const focusOrphaned = () => {
    const el = document.activeElement
    if (!el || el === document.body) return true
    return el.closest("[data-component=dialog-overlay]") !== null
  }

  const runRestore = (restoreTarget?: () => boolean) => {
    const fn = restore.current
    // Deferred past teardown so Kobalte's own focus-restore runs first and we
    // can see whether anything claimed focus before we override it.
    requestAnimationFrame(() => {
      if (active()) return
      if (!focusOrphaned()) return
      // Prefer the element that held focus before this dialog opened; it's the
      // truest "put me back where I was". Only when it's gone (unmounted while
      // the dialog was up) fall back to the app-registered target (the prompt).
      if (restoreTarget?.()) return
      fn?.()
    })
  }

  const close = () => {
    const current = active()
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
    current.setClosing(true)

    const id = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    timer.current = setTimeout(() => {
      timer.current = undefined
      current.dispose()
      if (active()?.id === id) setActive(undefined)
      lock.value = false
      runRestore(current.restore)
    }, 100)
  }

  createEffect(() => {
    if (!active()) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))
  })

  const show = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    // Snapshot focus before anything mounts or disposes — this is still the
    // element the user was on (the trigger button, the prompt) at the instant
    // show() runs. Chaining to a new dialog reuses the outgoing dialog's
    // snapshot so focus tracks back to the original pre-dialog element, not the
    // dialog content that's about to unmount.
    const current = active()
    const restore = current?.restore ?? captureFocus()

    // Immediately dispose any existing dialog when showing a new one
    if (current) {
      current.dispose()
      setActive(undefined)
    }

    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false

    const id = Math.random().toString(36).slice(2)
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              close()
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay data-component="dialog-overlay" onClick={close} />
              <Instance.Provider value={closing}>{element()}</Instance.Provider>
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return

    setActive({ id, node, dispose, owner, onClose, setClosing, restore })
  }

  return {
    get active() {
      return active()
    },
    close,
    show,
    setRestore(fn: (() => void) | undefined) {
      restore.current = fn
    },
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">{ctx.active?.node}</div>
    </Context.Provider>
  )
}

// For code inside a dialog's content: false once that dialog is dismissed
// (close() started) or disposed (closed, or replaced by another dialog). A
// request that outlives its dialog checks this before acting on the dialog.
export function useDialogOpen() {
  const closing = useContext(Instance)
  let disposed = false
  onCleanup(() => (disposed = true))
  return () => !disposed && !closing?.()
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.active
    },
    show(element: DialogElement, onClose?: () => void) {
      const base = ctx.active?.owner ?? owner
      ctx.show(element, base, onClose)
    },
    close() {
      ctx.close()
    },
    setRestore(fn: (() => void) | undefined) {
      ctx.setRestore(fn)
    },
  }
}
