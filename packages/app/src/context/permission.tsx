import { createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "./global-sync"
import { useParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

function shouldAutoAccept(perm: PermissionRequest) {
  return perm.permission === "edit"
}

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasAutoAcceptPermissionConfig(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  if (isNonAllowRule(config.edit)) return true
  if (isNonAllowRule(config.write)) return true

  return false
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const params = useParams()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()

    const permissionsEnabled = createMemo(() => {
      const directory = decode64(params.dir)
      if (!directory) return false
      const [store] = globalSync.child(directory)
      return hasAutoAcceptPermissionConfig(store.config.permission)
    })

    const respond: PermissionRespondFn = (input) => {
      globalSDK.client.permission.respond(input).catch(() => undefined)
    }

    function isAutoAccepting(sessionID: string, directory?: string) {
      if (!directory) return false
      const [store] = globalSync.child(directory)
      return store.auto_accept[sessionID] === true
    }

    function set(sessionID: string, directory: string, enabled: boolean) {
      globalSDK.client.permission.setAutoAccept({ directory, sessionID, enabled }).catch(() => undefined)
    }

    return {
      respond,
      autoResponds(permission: PermissionRequest, directory?: string) {
        return isAutoAccepting(permission.sessionID, directory) && shouldAutoAccept(permission)
      },
      isAutoAccepting,
      toggleAutoAccept(sessionID: string, directory: string) {
        set(sessionID, directory, !isAutoAccepting(sessionID, directory))
      },
      enableAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) return
        set(sessionID, directory, true)
      },
      disableAutoAccept(sessionID: string, directory: string) {
        set(sessionID, directory, false)
      },
      permissionsEnabled,
    }
  },
})
