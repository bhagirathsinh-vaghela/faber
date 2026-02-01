---
name: bun-file-io
description: Use this when you are working on file operations like reading, writing, scanning, or deleting files. It summarizes the preferred file APIs and patterns used in this repo. It also notes when to use filesystem helpers for directories.
---

## Use this when

- File I/O or scans in `packages/opencode`
- Directory ops or external tools

## Bun file APIs

- `Bun.file(path)` lazy; call `text`, `json`, `stream`, `arrayBuffer`, `bytes`, `exists` to read
- Metadata: `file.size`, `file.type`, `file.name`
- `Bun.write(dest, input)` writes strings, buffers, Blobs, Responses, files
- `Bun.file(...).delete()` deletes file
- `file.writer()` → FileSink for incremental writes
- `Bun.Glob` + `Array.fromAsync(glob.scan({ cwd, absolute, onlyFiles, dot }))` for scans
- `Bun.which` to find binary, `Bun.spawn` to run
- `Bun.readableStreamToText/Bytes/JSON` for stream output

## When to use node:fs

- `node:fs/promises` for directories (`mkdir`, `readdir`, recursive ops)

## Repo patterns

- Prefer Bun APIs over Node `fs`
- Check `Bun.file(...).exists()` before reading
- Binary/large files: `arrayBuffer()` + MIME via `file.type`
- `Bun.Glob` + `Array.fromAsync` for scans
- Decode stderr: `Bun.readableStreamToText`
- Large writes: `Bun.write(Bun.file(path), text)`

## Quick checklist

- Bun APIs first
- `path.join`/`path.resolve` for paths
- Prefer `.catch(...)` over `try/catch`
