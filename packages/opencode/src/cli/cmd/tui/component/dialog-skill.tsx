import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo, createSignal } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { useKeybind } from "@tui/context/keybind"

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const local = useLocal()
  const keybind = useKeybind()
  const [showDescriptions, setShowDescriptions] = createSignal(false)
  const [query, setQuery] = createSignal("")

  const [skills] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return result.data ?? []
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = skills() ?? []
    const show = showDescriptions()
    const favorites = local.skill.favorite()
    const needle = query().trim()
    const showSections = needle.length === 0

    const favoriteOptions = showSections
      ? favorites.flatMap((name) => {
          const skill = list.find((s) => s.name === name)
          if (!skill) return []
          return [
            {
              title: skill.name,
              description: show ? skill.description : undefined,
              value: skill.name,
              category: "Favorites",
              onSelect: () => {
                props.onSelect(skill.name)
                dialog.clear()
              },
            },
          ]
        })
      : []

    const otherSkills = showSections ? list.filter((s) => !favorites.includes(s.name)) : list

    const skillOptions = otherSkills.map((skill) => ({
      title: skill.name,
      description: show ? skill.description : undefined,
      value: skill.name,
      category: showSections ? "Skills" : undefined,
      onSelect: () => {
        props.onSelect(skill.name)
        dialog.clear()
      },
    }))

    return [...favoriteOptions, ...skillOptions]
  })

  return (
    <DialogSelect
      title="Skills"
      placeholder="Search skills..."
      options={options()}
      onFilter={setQuery}
      keybind={[
        {
          keybind: { name: "tab", ctrl: false, meta: false, shift: false, leader: false },
          title: showDescriptions() ? "Hide descriptions" : "Show descriptions",
          onTrigger: () => setShowDescriptions((prev) => !prev),
        },
        {
          keybind: keybind.all.skill_favorite_toggle?.[0] ?? {
            name: "f",
            ctrl: true,
            meta: false,
            shift: false,
            leader: false,
          },
          title: "Favorite",
          onTrigger: (option) => {
            local.skill.toggleFavorite(option.value)
          },
        },
      ]}
    />
  )
}
