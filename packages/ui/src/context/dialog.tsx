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

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
}

const Context = createContext<ReturnType<typeof init>>()

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

  const runRestore = () => {
    const fn = restore.current
    if (!fn) return
    // Deferred past teardown so Kobalte's own focus-restore runs first and we
    // can see whether anything claimed focus before we override it.
    requestAnimationFrame(() => {
      if (active()) return
      if (!focusOrphaned()) return
      fn()
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
      runRestore()
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
    // Immediately dispose any existing dialog when showing a new one
    const current = active()
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
              {element()}
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return

    setActive({ id, node, dispose, owner, onClose, setClosing })
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
