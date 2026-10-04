#!/usr/bin/env node
// Fails on any high/critical production advisory that is not explicitly accepted below.
import { execFileSync } from 'node:child_process'

const ACCEPTED = {
  // ip <= 2.0.1 isPublic()/isPrivate() misclassification; no patched release exists.
  // Pulled in by werift (WebRTC) via ring-client-api, which only calls isV4/isV6,
  // toBuffer, toString and isLoopback (werift/lib/ice/src/{utils,stun/attributes}.js),
  // so the affected functions are never reached. Re-check whenever werift is bumped.
  'GHSA-2p57-rm9w-gvfp': 'ip isPublic SSRF categorization (no fix upstream)',
}

let raw
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' })
} catch (err) {
  raw = err.stdout
}
const report = JSON.parse(raw)
const failures = []
for (const [name, vuln] of Object.entries(report.vulnerabilities || {})) {
  if (!['high', 'critical'].includes(vuln.severity)) continue
  const advisories = vuln.via.filter((v) => typeof v === 'object')
  // Entries whose `via` is only other package names inherit their advisories from those packages.
  for (const adv of advisories) {
    const id = adv.url?.split('/').pop()
    if (!ACCEPTED[id]) failures.push(`${name}: ${id} ${adv.title}`)
  }
}

for (const [id, why] of Object.entries(ACCEPTED)) console.log(`accepted ${id}: ${why}`)
if (failures.length) {
  console.error(`Unaccepted high/critical advisories:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('npm audit: no unaccepted high/critical advisories')
