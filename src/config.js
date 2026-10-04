function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function int(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${value}"`)
  return n
}

function list(value) {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

// "always", "off", or comma-separated HH:MM-HH:MM windows (may wrap midnight).
export function parseSchedule(value) {
  const v = (value || 'off').trim().toLowerCase()
  if (v === 'off' || v === '') return []
  if (v === 'always') return [{ start: 0, end: 24 * 60 }]
  return v.split(',').map((part) => {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/)
    if (!m) throw new Error(`Invalid CONTINUOUS_SCHEDULE window "${part}" (expected HH:MM-HH:MM)`)
    const start = Number(m[1]) * 60 + Number(m[2])
    const end = Number(m[3]) * 60 + Number(m[4])
    if (start >= 24 * 60 || end > 24 * 60) throw new Error(`Invalid time in "${part}"`)
    return { start, end }
  })
}

export function inSchedule(windows, date = new Date()) {
  const minute = date.getHours() * 60 + date.getMinutes()
  return windows.some(({ start, end }) =>
    start <= end ? minute >= start && minute < end : minute >= start || minute < end,
  )
}

export function loadConfig(env = process.env) {
  const config = {
    refreshToken: env.RING_REFRESH_TOKEN?.trim() || '',
    refreshTokenFile: env.RING_REFRESH_TOKEN_FILE || '/run/secrets/ring_refresh_token',
    dataDir: env.DATA_DIR || '/data',
    recordingsDir: env.RECORDINGS_DIR || '/recordings',
    cameraFilter: list(env.CAMERAS),
    triggers: list(env.TRIGGERS ?? 'motion,ding'),
    clipSeconds: int(env.CLIP_SECONDS, 45, 'CLIP_SECONDS'),
    cooldownSeconds: int(env.COOLDOWN_SECONDS, 15, 'COOLDOWN_SECONDS'),
    maxConcurrentStreams: int(env.MAX_CONCURRENT_STREAMS, 2, 'MAX_CONCURRENT_STREAMS'),
    continuousCameras: list(env.CONTINUOUS_CAMERAS),
    continuousSchedule: parseSchedule(env.CONTINUOUS_SCHEDULE),
    segmentSeconds: int(env.SEGMENT_SECONDS, 300, 'SEGMENT_SECONDS'),
    retentionDays: int(env.RETENTION_DAYS, 30, 'RETENTION_DAYS'),
    minFreeGb: int(env.MIN_FREE_GB, 5, 'MIN_FREE_GB'),
    minClipBytes: int(env.MIN_CLIP_BYTES, 50000, 'MIN_CLIP_BYTES'),
    dryRun: bool(env.DRY_RUN),
    mock: bool(env.MOCK),
    mockEventIntervalSeconds: int(env.MOCK_EVENT_INTERVAL_SECONDS, 20, 'MOCK_EVENT_INTERVAL_SECONDS'),
    exitAfterSeconds: int(env.EXIT_AFTER_SECONDS, 0, 'EXIT_AFTER_SECONDS'),
    debug: bool(env.DEBUG),
    ffmpegPath: env.FFMPEG_PATH || '/usr/bin/ffmpeg',
    controlCenterDisplayName: env.CONTROL_CENTER_NAME || 'ring-nas-recorder',
  }

  const badTriggers = config.triggers.filter((t) => !['motion', 'ding'].includes(t))
  if (badTriggers.length) throw new Error(`TRIGGERS supports motion,ding (got ${badTriggers.join(',')})`)
  if (config.clipSeconds < 5 || config.clipSeconds > 600) throw new Error('CLIP_SECONDS must be 5-600')
  // Ring ends live sessions after ~10 minutes regardless of what the client asks for.
  if (config.segmentSeconds < 30 || config.segmentSeconds > 590) throw new Error('SEGMENT_SECONDS must be 30-590')
  if (config.retentionDays < 0 || config.minFreeGb < 0) throw new Error('RETENTION_DAYS and MIN_FREE_GB must be >= 0')
  if (config.maxConcurrentStreams < 1) throw new Error('MAX_CONCURRENT_STREAMS must be >= 1')
  return config
}
