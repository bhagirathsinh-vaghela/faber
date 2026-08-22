import { test as base, expect } from "@playwright/test"
import { cleanupTestProject, createTestProject } from "./actions"
import { promptSelector } from "./selectors"
import { createSdk, dirSlug, getWorktree, sessionPath } from "./utils"

export const settingsKey = "settings.v3"

type TestFixtures = {
  sdk: ReturnType<typeof createSdk>
  gotoSession: (sessionID?: string) => Promise<void>
  withProject: <T>(
    callback: (project: {
      directory: string
      slug: string
      gotoSession: (sessionID?: string) => Promise<void>
    }) => Promise<T>,
    options?: { extra?: string[] },
  ) => Promise<T>
}

type WorkerFixtures = {
  directory: string
  slug: string
}

async function openSidebarProjects(worktrees: string[]) {
  const sdk = createSdk()
  for (const worktree of worktrees) {
    await sdk.global.projects.openAdd({ directory: worktree })
  }
}

async function closeSidebarProjects(worktrees: string[]) {
  const sdk = createSdk()
  for (const worktree of worktrees) {
    await sdk.global.projects.close({ directory: worktree }).catch(() => undefined)
  }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  directory: [
    async ({}, use) => {
      const directory = await getWorktree()
      await use(directory)
    },
    { scope: "worker" },
  ],
  slug: [
    async ({ directory }, use) => {
      await use(dirSlug(directory))
    },
    { scope: "worker" },
  ],
  sdk: async ({ directory }, use) => {
    await use(createSdk(directory))
  },
  gotoSession: async ({ page, directory }, use) => {
    const gotoSession = async (sessionID?: string) => {
      await page.goto(sessionPath(directory, sessionID))
      await expect(page.locator(promptSelector)).toBeVisible()
    }
    await use(gotoSession)
  },
  withProject: async ({ page }, use) => {
    await use(async (callback, options) => {
      const directory = await createTestProject()
      const slug = dirSlug(directory)
      const projectWorktrees = [directory, ...(options?.extra ?? [])]
      await openSidebarProjects(projectWorktrees)

      const gotoSession = async (sessionID?: string) => {
        await page.goto(sessionPath(directory, sessionID))
        await expect(page.locator(promptSelector)).toBeVisible()
      }

      try {
        await gotoSession()
        return await callback({ directory, slug, gotoSession })
      } finally {
        await closeSidebarProjects(projectWorktrees)
        await cleanupTestProject(directory)
      }
    })
  },
})

export { expect }
