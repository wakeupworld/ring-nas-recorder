import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { clipPath, safeName, writeFileAtomic } from '../src/fs-utils.js'
import { redact, registerSecret } from '../src/redact.js'
import { Storage } from '../src/storage.js'
import { TokenStore } from '../src/token-store.js'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'rnr-'))
const fakeToken = Buffer.from(JSON.stringify({ rt: 'x'.repeat(300), hid: 'abc' })).toString('base64')

test('camera names cannot escape the recordings root', () => {
  for (const evil of ['../../etc', '..', '/etc/passwd', 'a/../../b', '.hidden', '\u0000x', 'C:\\Windows', '．．/x']) {
    const p = clipPath('/recordings', evil, new Date(2026, 0, 1), 'motion')
    assert.ok(p.startsWith('/recordings/'), `${evil} -> ${p}`)
    assert.equal(path.relative('/recordings', p).split(path.sep).length, 3, `${evil} -> ${p}`)
  }
  assert.equal(safeName(''), 'unnamed')
  assert.equal(safeName('x'.repeat(500)).length, 80)
})

test('tokens and credentials are redacted from log output', () => {
  registerSecret('my-registered-secret-value')
  const out = redact(
    `token ${fakeToken} body {"refresh_token":"abc123","password":"hunter2"} Bearer eyJhbGci.x.y my-registered-secret-value`,
  )
  for (const leaked of [fakeToken, 'abc123', 'hunter2', 'eyJhbGci', 'my-registered-secret-value']) {
    assert.ok(!out.includes(leaked), `leaked ${leaked}: ${out}`)
  }
  assert.ok(redact('/recordings/Front Door/2026-10-03/2026-10-03_07-05-09_motion.mp4').includes('Front Door'))
})

test('persisted token is written atomically with mode 600', async () => {
  const dir = await tmp()
  const store = new TokenStore(dir)
  await store.save(fakeToken)
  await store.save(`${fakeToken}2`)
  const { mode } = await fs.stat(store.file)
  assert.equal(mode & 0o777, 0o600)
  assert.equal((await fs.readFile(store.file, 'utf8')).trim(), `${fakeToken}2`)
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')), [])
})

test('token file with loose permissions is tightened on load', async () => {
  const dir = await tmp()
  await writeFileAtomic(path.join(dir, 'refresh-token'), fakeToken, 0o644)
  const token = await new TokenStore(dir).load({})
  assert.equal(token, fakeToken)
  assert.equal((await fs.stat(path.join(dir, 'refresh-token'))).mode & 0o777, 0o600)
})

test('retention deletes only old mp4 files and never follows symlinks', async () => {
  const root = await tmp()
  const outside = await tmp()
  const day = path.join(root, 'Cam', '2026-01-01')
  await fs.mkdir(day, { recursive: true })
  const old = path.join(day, 'old.mp4')
  const keep = path.join(day, 'new.mp4')
  const notes = path.join(day, 'notes.txt')
  await Promise.all([fs.writeFile(old, 'x'), fs.writeFile(keep, 'x'), fs.writeFile(notes, 'x')])
  const past = new Date(Date.now() - 40 * 86400000)
  await fs.utimes(old, past, past)
  await fs.utimes(notes, past, past)
  const victim = path.join(outside, 'victim.mp4')
  await fs.writeFile(victim, 'x')
  await fs.utimes(victim, past, past)
  await fs.symlink(outside, path.join(root, 'link'))

  await new Storage({ recordingsDir: root, retentionDays: 30, minFreeGb: 0 }).applyRetention()
  assert.equal(await fs.stat(old).catch(() => null), null)
  assert.ok(await fs.stat(keep))
  assert.ok(await fs.stat(notes))
  assert.ok(await fs.stat(victim))
})
