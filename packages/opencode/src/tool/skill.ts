import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { PermissionNext } from "../permission/next"
import { Ripgrep } from "../file/ripgrep"
import { iife } from "@/util/iife"
import { Instance } from "../project/instance"
import { Global } from "@/global"
import { Session } from "@/session"
import { Coverage } from "@/session/coverage"

// This text is part of the skill tool's description, so it lands in tools[] —
// the front of Anthropic's cumulative prefix hash. A location that renders
// differently per worktree changes those bytes and invalidates the whole
// downstream cache, system prompt included. Home-relative is checked FIRST so
// a skill outside the worktree renders identically everywhere: testing the
// worktree first would strip the "~/" whenever the worktree contains home
// (cwd == ~), reclassifying every global skill as project-local.
function relativePath(absolute: string) {
  const home = Global.Path.home
  const worktree = Instance.worktree
  if (absolute.startsWith(home + path.sep)) return "~/" + path.relative(home, absolute)
  if (worktree !== "/" && absolute.startsWith(worktree + path.sep)) return path.relative(worktree, absolute)
  return absolute
}

// The body as it stands on disk, falling back to the pinned copy when the file
// is gone or unreadable. Exported so the per-turn reminder's post-compaction
// step (insertReminders in session/prompt.ts) reads the same current text this
// tool serves, rather than the pin's possibly-stale snapshot.
export async function current(skill: Skill.Info) {
  const text = await Bun.file(skill.location)
    .text()
    .catch(() => undefined)
  if (text === undefined) return skill.content
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? text.slice(match[0].length) : text
}

export const SkillTool = Tool.define("skill", async (ctx) => {
  const skills = ctx?.snapshot ? Object.values(ctx.snapshot.skills) : await Skill.all()
  skills.sort((a, b) => a.name.localeCompare(b.name))

  // Filter skills by agent permissions if agent provided
  const agent = ctx?.agent
  const accessibleSkills = agent
    ? skills.filter((skill) => {
        const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
        return rule.action !== "deny"
      })
    : skills

  const description =
    accessibleSkills.length === 0
      ? "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
      : [
          "Load a specialized skill that provides domain-specific instructions and workflows.",
          "",
          "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
          "",
          "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
          "",
          'Tool output includes a `<skill_content name="...">` block with the loaded content.',
          "",
          "IMPORTANT: When the user's message contains `[USE-SKILL:skill-name]` markers, you MUST invoke this tool for each referenced skill BEFORE responding to the user's request. Load all marked skills first, then proceed with the task.",
          "",
          "The following skills provide specialized sets of instructions for particular tasks",
          "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
          "",
          "<available_skills>",
          ...accessibleSkills.flatMap((skill) => [
            `  <skill>`,
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            `    <location>${relativePath(skill.location)}</location>`,
            `  </skill>`,
          ]),
          "</available_skills>",
        ].join("\n")

  const examples = accessibleSkills
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const parameters = z
    .object({
      name: z.string().describe(`The name of the skill from available_skills${hint}`),
    })
    .strict()

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, execCtx) {
      // Metadata comes from the pin, so the tool description and the loadable
      // set stay frozen for the session. The body is re-read from disk: it is
      // output rather than prompt, so serving the current text lets a skill be
      // edited and picked up on the next invocation without moving the prefix.
      const pinned = ctx?.snapshot ? ctx.snapshot.skills[params.name] : undefined
      const skill = pinned ?? (await Skill.get(params.name))

      if (!skill) {
        const available = accessibleSkills.map((s) => s.name).join(", ")
        throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
      }

      await execCtx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })

      if (skill.reminder) {
        const loaded = await Coverage.fingerprint(execCtx.sessionID)
        await Session.update(
          execCtx.sessionID,
          (draft) => {
            draft.activeSkills = [...new Set([...(draft.activeSkills ?? []), skill.name])]
            draft.loaded = loaded
          },
          { touch: false },
        )
      }

      const dir = path.dirname(skill.location)
      const base = pathToFileURL(dir).href

      const limit = 10
      const files = await iife(async () => {
        const arr = []
        for await (const file of Ripgrep.files({
          cwd: dir,
          follow: false,
          hidden: true,
          signal: execCtx.abort,
        })) {
          if (file.includes("SKILL.md")) {
            continue
          }
          arr.push(path.resolve(dir, file))
          if (arr.length >= limit) {
            break
          }
        }
        return arr
      }).then((f) => f.map((file) => `<file>${file}</file>`).join("\n"))

      return {
        title: `Loaded skill: ${skill.name}`,
        output: [
          `<skill_content name="${skill.name}">`,
          `# Skill: ${skill.name}`,
          "",
          (await current(skill)).trim(),
          "",
          `Base directory for this skill: ${base}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          files,
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
        metadata: {
          name: skill.name,
          dir,
        },
      }
    },
  }
})
