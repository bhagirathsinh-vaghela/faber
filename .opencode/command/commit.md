---
description: git commit and push
subagent: true
---

commit and push

make sure it includes a conventional prefix, with a scope when the change sits
in one area, like
feat(app):
fix(tool):
docs:
chore:

prefer to explain WHY something was done from an end user perspective instead of
WHAT was done.

do not do generic messages like "improved agent experience" be very specific
about what user facing changes were made

if there are changes do a git pull --rebase
if there are conflicts DO NOT FIX THEM. notify me and I will fix them

## GIT DIFF

!`git diff`

## GIT DIFF --cached

!`git diff --cached`

## GIT STATUS --short

!`git status --short`
