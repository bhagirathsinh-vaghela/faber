import * as i18n from "@solid-primitives/i18n"

import { dict as desktopEn } from "./en"
import { dict as appEn } from "../../../app/src/i18n/en"

type Dictionary = i18n.Flatten<typeof appEn & typeof desktopEn>

const dict = i18n.flatten({ ...appEn, ...desktopEn }) as Dictionary

const translate = i18n.translator(() => dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}
