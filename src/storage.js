import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from './log.js'

const CLIP = /\.mp4$/i

// Only regular *.mp4 files are touched; symlinks are never followed or deleted.
async function listClips(dir, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return out
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listClips(full, out)
    else if (entry.isFile() && CLIP.test(entry.name)) {
      const { mtimeMs, size } = await fs.stat(full)
      out.push({ file: full, mtimeMs, size })
    }
  }
  return out
}

async function removeEmptyDirs(dir, root) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name), root)
  if (dir !== root && (await fs.readdir(dir).catch(() => ['?'])).length === 0) {
    await fs.rmdir(dir).catch(() => {})
  }
}

export async function freeBytes(dir) {
  const s = await fs.statfs(dir)
  return s.bavail * s.bsize
}

export class Storage {
  constructor({ recordingsDir, retentionDays, minFreeGb }) {
    this.root = path.resolve(recordingsDir)
    this.retentionDays = retentionDays
    this.minFreeBytes = minFreeGb * 1024 ** 3
  }

  async applyRetention() {
    if (this.retentionDays <= 0) return
    const cutoff = Date.now() - this.retentionDays * 86400000
    let removed = 0
    for (const clip of await listClips(this.root)) {
      if (clip.mtimeMs < cutoff) {
        await fs.rm(clip.file, { force: true })
        removed++
      }
    }
    if (removed) {
      await removeEmptyDirs(this.root, this.root)
      log.info(`Retention: deleted ${removed} clip(s) older than ${this.retentionDays} day(s)`)
    }
  }

  // Returns false when the dataset is still below MIN_FREE_GB after pruning the oldest clips.
  async ensureFreeSpace() {
    if (this.minFreeBytes <= 0) return true
    let free = await freeBytes(this.root)
    if (free >= this.minFreeBytes) return true
    const clips = (await listClips(this.root)).sort((a, b) => a.mtimeMs - b.mtimeMs)
    let removed = 0
    for (const clip of clips) {
      if (free >= this.minFreeBytes) break
      await fs.rm(clip.file, { force: true })
      free = await freeBytes(this.root)
      removed++
    }
    if (removed) {
      await removeEmptyDirs(this.root, this.root)
      log.warn(`Low space: deleted ${removed} oldest clip(s) to keep ${(this.minFreeBytes / 1024 ** 3).toFixed(1)} GB free`)
    }
    return free >= this.minFreeBytes
  }
}
