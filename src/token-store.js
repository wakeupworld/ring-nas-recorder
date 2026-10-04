import fs from 'node:fs/promises'
import path from 'node:path'
import { readFileIfExists, writeFileAtomic } from './fs-utils.js'
import { log } from './log.js'
import { registerSecret } from './redact.js'

const TOKEN_MODE = 0o600

// Ring refresh tokens are single-use: every auth returns a new one and the old
// one stops working, so the latest token must survive container restarts.
export class TokenStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'refresh-token')
  }

  async #readRestricted(file) {
    const token = (await readFileIfExists(file))?.trim()
    if (!token) return undefined
    const { mode } = await fs.stat(file)
    if (mode & 0o077) {
      log.warn(`${file} is accessible to other users (mode ${(mode & 0o777).toString(8)}), tightening to 600`)
      await fs.chmod(file, TOKEN_MODE).catch((err) => log.warn(`chmod failed: ${err.message}`))
    }
    return token
  }

  // Order: rotated token in /data, then a bootstrap secret file, then (discouraged) env var.
  async load({ bootstrapFile, envToken }) {
    let token = await this.#readRestricted(this.file)
    if (token) {
      log.info(`Using refresh token from ${this.file}`)
    } else if (bootstrapFile && (token = (await readFileIfExists(bootstrapFile))?.trim())) {
      log.info(`Using bootstrap refresh token from ${bootstrapFile}`)
    } else if (envToken) {
      token = envToken
      log.warn('Using RING_REFRESH_TOKEN from the environment; prefer the `auth` command or a secret file')
    }
    registerSecret(token)
    return token
  }

  async save(token) {
    registerSecret(token)
    await writeFileAtomic(this.file, `${token}\n`, TOKEN_MODE)
  }
}
