import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const DIR_MODE = 0o750

// tmp file + fsync + rename + dir fsync, so a crash or power loss leaves either
// the old or the new contents, never a truncated token.
export async function writeFileAtomic(file, contents, mode = 0o640) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE })
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await fs.open(tmp, 'wx', mode)
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    // Datasets with a restricted NFSv4 ACL mode reject chmod; the ACL governs access there.
    await fs.chmod(tmp, mode).catch((err) => {
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(err.code)) throw err
    })
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
  const dirHandle = await fs.open(dir, 'r')
  try {
    await dirHandle.sync()
  } finally {
    await dirHandle.close()
  }
}

export async function readFileIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return undefined
    throw err
  }
}

const MAX_NAME = 80

// Camera names come from the Ring account, so treat them as untrusted path input.
export function safeName(name) {
  const cleaned = String(name ?? '')
    .normalize('NFKC')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+/, '')
    .slice(0, MAX_NAME)
    .trim()
  return cleaned || 'unnamed'
}

function pad(n) {
  return String(n).padStart(2, '0')
}

export function assertInside(root, target) {
  const base = path.resolve(root)
  const resolved = path.resolve(target)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refusing to write outside ${base}`)
  }
  return resolved
}

// Uses the container's local time (set TZ) so folders match the user's calendar day.
export function clipPath(root, cameraName, date, kind) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  return assertInside(root, path.join(root, safeName(cameraName), day, `${day}_${time}_${safeName(kind)}.mp4`))
}
