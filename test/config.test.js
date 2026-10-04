import assert from 'node:assert/strict'
import test from 'node:test'
import { inSchedule, loadConfig, parseSchedule } from '../src/config.js'
import { clipPath, safeName } from '../src/fs-utils.js'

test('defaults are live-recording friendly', () => {
  const c = loadConfig({})
  assert.deepEqual(c.triggers, ['motion', 'ding'])
  assert.equal(c.clipSeconds, 45)
  assert.deepEqual(c.continuousSchedule, [])
})

test('rejects unknown triggers and out-of-range values', () => {
  assert.throws(() => loadConfig({ TRIGGERS: 'motion,person' }))
  assert.throws(() => loadConfig({ CLIP_SECONDS: '2' }))
  assert.throws(() => loadConfig({ SEGMENT_SECONDS: '900' }))
})

test('schedule windows, including ones that wrap midnight', () => {
  const w = parseSchedule('22:00-06:00')
  assert.equal(inSchedule(w, new Date(2026, 0, 1, 23, 30)), true)
  assert.equal(inSchedule(w, new Date(2026, 0, 1, 5, 59)), true)
  assert.equal(inSchedule(w, new Date(2026, 0, 1, 12, 0)), false)
  assert.equal(inSchedule(parseSchedule('always'), new Date()), true)
  assert.throws(() => parseSchedule('10pm-6am'))
})

test('clip paths are grouped by camera and day', () => {
  const p = clipPath('/recordings', 'Front Door', new Date(2026, 9, 3, 7, 5, 9), 'motion')
  assert.equal(p, '/recordings/Front Door/2026-10-03/2026-10-03_07-05-09_motion.mp4')
  assert.equal(safeName('Garage/Side: "Cam"'), 'Garage_Side_ _Cam_')
})
