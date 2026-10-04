#!/usr/bin/env node
import fs from 'node:fs/promises'
import { RingApi } from 'ring-client-api'
import { useLogger } from 'ring-client-api/util'
import { inSchedule, loadConfig } from './config.js'
import { log } from './log.js'
import { MockRingApi } from './mock.js'
import { Recorder } from './recorder.js'
import { Storage } from './storage.js'
import { TokenStore } from './token-store.js'
import { DIR_MODE } from './fs-utils.js'

// Clips 0640, folders 0750: readable by the app group (e.g. an SMB viewers group), never world-readable.
process.umask(0o027)

const config = loadConfig()
log.debugEnabled = config.debug
useLogger({ logInfo: (...m) => log.debug(...m), logError: (m) => log.error(m) })

async function createApi(refreshToken) {
  if (config.mock) {
    log.warn('MOCK=1: using simulated cameras, no connection to Ring')
    return new MockRingApi({
      refreshToken,
      ffmpegPath: config.ffmpegPath,
      eventIntervalSeconds: config.mockEventIntervalSeconds,
    })
  }
  return new RingApi({
    refreshToken,
    controlCenterDisplayName: config.controlCenterDisplayName,
    ffmpegPath: config.ffmpegPath,
    debug: config.debug,
    // Snapshot/status polling is unnecessary for recording and costs battery.
    avoidSnapshotBatteryDrain: true,
  })
}

function selectCameras(cameras) {
  if (!config.cameraFilter.length) return cameras
  const selected = cameras.filter(
    (c) => config.cameraFilter.includes(c.name.toLowerCase()) || config.cameraFilter.includes(String(c.id)),
  )
  const missing = config.cameraFilter.filter(
    (f) => !cameras.some((c) => c.name.toLowerCase() === f || String(c.id) === f),
  )
  if (missing.length) log.warn(`CAMERAS entries not found: ${missing.join(', ')}`)
  return selected
}

function isContinuous(camera) {
  return config.continuousCameras.includes(camera.name.toLowerCase()) || config.continuousCameras.includes(String(camera.id))
}

async function continuousLoop(camera, recorder, stopping) {
  while (!stopping.value) {
    if (inSchedule(config.continuousSchedule) && !camera.isOffline) {
      await recorder.recordSegment(camera)
    } else {
      await new Promise((r) => setTimeout(r, 30000))
    }
  }
}

async function assertWritable(dir) {
  const probe = `${dir}/.write-test-${process.pid}`
  try {
    await fs.writeFile(probe, '')
    await fs.rm(probe)
  } catch (err) {
    const uid = process.getuid?.()
    const gid = process.getgid?.()
    log.error(`UID ${uid} / GID ${gid} cannot write to ${dir} (${err.code}).`)
    log.error('Grant that user/group Modify on the dataset or share mounted there (see README, Permissions).')
    process.exit(1)
  }
}

async function main() {
  for (const dir of [config.dataDir, config.recordingsDir]) {
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE })
    await assertWritable(dir)
  }

  const tokens = new TokenStore(config.dataDir)
  const refreshToken = await tokens.load({ bootstrapFile: config.refreshTokenFile, envToken: config.refreshToken })
  if (!refreshToken) {
    log.error(`No refresh token. Run the interactive login once; it writes ${tokens.file}:`)
    log.error('  docker run --rm -it --user 568:568 -v <data dataset>:/data ring-nas-recorder:latest auth')
    process.exit(2)
  }

  const api = await createApi(refreshToken)
  let saving = Promise.resolve()
  api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    saving = saving
      .then(() => tokens.save(newRefreshToken))
      .then(() => log.info('Refresh token rotated and saved'))
      .catch((err) => log.error(`Could not persist refresh token: ${err.message}`))
  })

  log.info('Authenticating with Ring and discovering cameras...')
  const cameras = selectCameras(await api.getCameras())
  if (!cameras.length) {
    log.error('No cameras found on this account (or none matched CAMERAS).')
    process.exit(3)
  }

  const storage = new Storage(config)
  const recorder = new Recorder(config, storage)
  const stopping = { value: false }

  for (const camera of cameras) {
    const battery = camera.hasBattery
    const continuous = isContinuous(camera) && config.continuousSchedule.length > 0
    log.info(
      `Camera "${camera.name}" (id ${camera.id}) ${battery ? 'battery' : 'wired'}` +
        `${camera.data?.subscribed ? ', Ring Protect' : ''}` +
        `, triggers: ${config.triggers.join('+') || 'none'}${continuous ? ', scheduled continuous' : ''}`,
    )
    if (continuous && battery) {
      log.warn(`"${camera.name}" is battery powered: continuous recording will drain it quickly`)
    }

    const onEvent = (kind) => () => {
      if (continuous && inSchedule(config.continuousSchedule)) return
      recorder.recordEvent(camera, kind)
    }
    if (config.triggers.includes('motion')) camera.onMotionStarted.subscribe(onEvent('motion'))
    if (config.triggers.includes('ding') && camera.isDoorbot) camera.onDoorbellPressed.subscribe(onEvent('ding'))
    if (continuous) continuousLoop(camera, recorder, stopping)
  }

  log.info(
    `Listening for events: ${config.clipSeconds}s clips -> ${config.recordingsDir}` +
      `${config.dryRun ? ' (DRY_RUN, nothing written)' : ''}`,
  )

  const heartbeat = async () => {
    await fs.writeFile(`${config.dataDir}/heartbeat`, new Date().toISOString()).catch(() => {})
  }
  await heartbeat()
  setInterval(heartbeat, 60000)
  const housekeeping = () =>
    storage
      .applyRetention()
      .then(() => storage.ensureFreeSpace())
      .catch((e) => log.error(`Housekeeping failed: ${e.message}`))
  await housekeeping()
  setInterval(housekeeping, 3600000)

  const shutdown = (signal) => {
    if (stopping.value) return
    stopping.value = true
    log.info(`${signal} received, stopping streams`)
    recorder.stopAll()
    api.disconnect()
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  if (config.exitAfterSeconds > 0) setTimeout(() => shutdown('EXIT_AFTER_SECONDS'), config.exitAfterSeconds * 1000)
}

process.on('unhandledRejection', (err) => log.error(`Unhandled: ${err?.message || err}`))

main().catch((err) => {
  log.error(err?.message || err)
  process.exit(1)
})
