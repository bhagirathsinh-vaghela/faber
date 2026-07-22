import { Component, createMemo, createSignal, onMount, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import type { AppSkillsResponse } from "@opencode-ai/sdk/v2/client"

interface SkillItem {
  name: string
  description: string
  favorite: boolean
}

const FAVORITES = "favorites"
const SKILLS = "skills"

export interface DialogSkillProps {
  onSelect: (name: string) => void
}

export const DialogSkill: Component<DialogSkillProps> = (props) => {
  const sdk = useSDK()
  const local = useLocal()
  const dialog = useDialog()
  const language = useLanguage()
  const [showDescriptions, setShowDescriptions] = createSignal(false)

  // Seed the static skill list into a plain signal on mount. NOT createResource:
  // a resource is Suspense-coupled, so its pending state on open trips the
  // <Suspense> around <Session> and flickers the transcript. A signal never
  // suspends.
  const [skills, setSkills] = createSignal<AppSkillsResponse>([])
  onMount(async () => {
    const res = await sdk.client.app.skills()
    setSkills(res.data ?? [])
  })

  const items = createMemo((): SkillItem[] => {
    const favorites = local.skill.favorite()
    return skills()
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        favorite: favorites.includes(skill.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const select = (item: SkillItem | undefined) => {
    if (!item) return
    dialog.close()
    props.onSelect(item.name)
  }

  return (
    <Dialog title={language.t("dialog.skill.title")}>
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: language.t("dialog.skill.search"), autofocus: true }}
        emptyMessage={language.t("dialog.skill.empty")}
        key={(x) => x.name}
        items={items}
        filterKeys={["name", "description"]}
        groupBy={(x) => (x.favorite ? FAVORITES : SKILLS)}
        sortGroupsBy={(a, b) => (a.category === FAVORITES ? -1 : b.category === FAVORITES ? 1 : 0)}
        onSelect={select}
        onKeyEvent={(event, item) => {
          if (event.ctrlKey && event.key === "f" && item) {
            event.preventDefault()
            local.skill.toggleFavorite(item.name)
          }
          if (event.key === "Tab") {
            event.preventDefault()
            setShowDescriptions((prev) => !prev)
          }
        }}
        actions={(item) => (
          <IconButton
            icon="circle-check"
            variant="ghost"
            class={item.favorite ? "" : "opacity-30"}
            aria-label={language.t(item.favorite ? "dialog.skill.unfavorite" : "dialog.skill.favorite")}
            onClick={() => local.skill.toggleFavorite(item.name)}
          />
        )}
      >
        {(item) => (
          <div class="flex-1 min-w-0 flex flex-col text-left">
            <span class="truncate font-normal">{item.name}</span>
            <Show when={showDescriptions()}>
              <span class="truncate text-text-weak font-normal">{item.description}</span>
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
