import * as i18n from "@solid-primitives/i18n"
import { createEffect } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"

export type Locale = "en"

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  init: () => {
    const dict: Dictionary = i18n.flatten({ ...en, ...uiEn })
    const t = i18n.translator(() => dict, i18n.resolveTemplate)

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.lang = "en"
    })

    return {
      locale: () => "en" as Locale,
      t,
    }
  },
})
