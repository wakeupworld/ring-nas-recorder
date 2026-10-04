import { spawn } from 'node:child_process'
import { ReplaySubject, Subject } from 'rxjs'
import { log } from './log.js'

// Stand-in for RingApi so the container can be exercised without a Ring account.
// Streams are produced by ffmpeg's test pattern, through the same output args as real streams.
class MockCamera {
  constructor(id, name, isDoorbot, ffmpegPath) {
    this.id = id
    this.name = name
    this.isDoorbot = isDoorbot
    this.isOffline = false
    this.data = { subscribed: false }
    this.hasBattery = isDoorbot
    this.onMotionStarted = new Subject()
    this.onDoorbellPressed = new Subject()
    this.ffmpegPath = ffmpegPath
  }

  async streamVideo({ output }) {
    const onCallEnded = new ReplaySubject(1)
    const ff = spawn(
      this.ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error',
        '-re', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=15',
        '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        ...output,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    ff.on('exit', () => {
      onCallEnded.next()
      onCallEnded.complete()
    })
    return { onCallEnded, stop: () => ff.kill('SIGTERM') }
  }
}

export class MockRingApi {
  constructor({ refreshToken, ffmpegPath, eventIntervalSeconds }) {
    if (!refreshToken) {
      throw new Error('Refresh token is not valid.  Unable to authenticate with Ring servers.')
    }
    this.onRefreshTokenUpdated = new ReplaySubject(1)
    this.cameras = [
      new MockCamera(1001, 'Front Door', true, ffmpegPath),
      new MockCamera(1002, 'Back Yard', false, ffmpegPath),
    ]
    this.eventIntervalSeconds = eventIntervalSeconds
  }

  async getCameras() {
    this.onRefreshTokenUpdated.next({
      oldRefreshToken: undefined,
      newRefreshToken: `mock-rotated-token-${Date.now()}`,
    })
    let tick = 0
    this.timer = setInterval(() => {
      const camera = this.cameras[tick % this.cameras.length]
      const ding = camera.isDoorbot && tick % 3 === 2
      log.info(`MOCK: simulating ${ding ? 'doorbell press' : 'motion'} on ${camera.name}`)
      if (ding) camera.onDoorbellPressed.next({})
      else camera.onMotionStarted.next(null)
      tick++
    }, this.eventIntervalSeconds * 1000)
    return this.cameras
  }

  disconnect() {
    clearInterval(this.timer)
  }
}
