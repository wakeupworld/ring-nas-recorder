import fs from 'node:fs/promises'
import path from 'node:path'
import { firstValueFrom } from 'rxjs'
import { DIR_MODE, clipPath } from './fs-utils.js'
import { log } from './log.js'

class Semaphore {
  constructor(max) {
    this.available = max
    this.waiters = []
  }

  tryAcquire() {
    if (this.available > 0) {
      this.available--
      return true
    }
    return false
  }

  async acquire() {
    if (this.tryAcquire()) return
    await new Promise((resolve) => this.waiters.push(resolve))
  }

  release() {
    const next = this.waiters.shift()
    if (next) next()
    else this.available++
  }
}

export class Recorder {
  constructor(config, storage) {
    this.config = config
    this.storage = storage
    this.streams = new Semaphore(config.maxConcurrentStreams)
    this.busy = new Set()
    this.lastEnded = new Map()
    this.active = new Set()
  }

  isBusy(camera) {
    return this.busy.has(camera.id)
  }

  inCooldown(camera) {
    const ended = this.lastEnded.get(camera.id)
    return ended !== undefined && Date.now() - ended < this.config.cooldownSeconds * 1000
  }

  // Event clips are dropped rather than queued: a clip that starts late is worse than none.
  async recordEvent(camera, kind) {
    if (this.isBusy(camera)) {
      log.debug(`[${camera.name}] ${kind} ignored, already recording`)
      return undefined
    }
    if (this.inCooldown(camera)) {
      log.debug(`[${camera.name}] ${kind} ignored, in cooldown`)
      return undefined
    }
    if (!this.streams.tryAcquire()) {
      log.warn(`[${camera.name}] ${kind} skipped: MAX_CONCURRENT_STREAMS (${this.config.maxConcurrentStreams}) reached`)
      return undefined
    }
    return this.#record(camera, kind, this.config.clipSeconds)
  }

  async recordSegment(camera) {
    if (this.isBusy(camera)) return undefined
    await this.streams.acquire()
    return this.#record(camera, 'continuous', this.config.segmentSeconds)
  }

  async #record(camera, kind, seconds) {
    this.busy.add(camera.id)
    const started = new Date()
    const finalPath = clipPath(this.config.recordingsDir, camera.name, started, kind)
    const partPath = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.part`)
    try {
      if (this.config.dryRun) {
        log.info(`[${camera.name}] DRY_RUN: would record ${seconds}s ${kind} clip to ${finalPath}`)
        return finalPath
      }
      if (!(await this.storage.ensureFreeSpace())) {
        log.error(`[${camera.name}] ${kind} skipped: less than MIN_FREE_GB free on ${this.config.recordingsDir}`)
        return undefined
      }
      await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: DIR_MODE })
      log.info(`[${camera.name}] ${kind}: starting ${seconds}s live recording`)
      await this.#stream(camera, seconds, partPath)

      const size = (await fs.stat(partPath).catch(() => undefined))?.size ?? 0
      if (size < this.config.minClipBytes) {
        await fs.rm(partPath, { force: true })
        log.warn(`[${camera.name}] ${kind}: stream produced ${size} bytes, discarding (camera offline or stream refused?)`)
        return undefined
      }
      await fs.rename(partPath, finalPath)
      log.info(`[${camera.name}] saved ${finalPath} (${(size / 1048576).toFixed(1)} MB)`)
      return finalPath
    } catch (err) {
      await fs.rm(partPath, { force: true }).catch(() => {})
      log.error(`[${camera.name}] ${kind} recording failed: ${err?.message || err}`)
      return undefined
    } finally {
      this.busy.delete(camera.id)
      this.lastEnded.set(camera.id, Date.now())
      this.streams.release()
    }
  }

  async #stream(camera, seconds, outputPath) {
    const session = await camera.streamVideo({
      output: ['-t', String(seconds), '-movflags', '+faststart', '-f', 'mp4', '-y', outputPath],
    })
    this.active.add(session)
    // Guard against Ring never ending the call (network drop, ffmpeg hang).
    const timeout = setTimeout(() => {
      log.warn(`[${camera.name}] stream did not end on its own, stopping`)
      session.stop()
    }, (seconds + 45) * 1000)
    try {
      await firstValueFrom(session.onCallEnded)
    } finally {
      clearTimeout(timeout)
      this.active.delete(session)
    }
  }

  stopAll() {
    for (const session of this.active) session.stop()
  }
}
