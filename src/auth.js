#!/usr/bin/env node
import { createHash } from 'node:crypto'
import readline from 'node:readline'
import { RingRestClient } from 'ring-client-api/rest-client'
import { useLogger } from 'ring-client-api/util'
import { loadConfig } from './config.js'
import { redact } from './redact.js'
import { TokenStore } from './token-store.js'

// Interactive login that writes the refresh token straight to /data/refresh-token
// (mode 600) instead of printing it, so it never lands in shell history, app YAML or logs.

useLogger({
  logInfo: () => {},
  logError: (message) => process.stderr.write(`${redact(message)}\n`),
})

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.startsWith(question)) rl.output.write(question)
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('The auth command is interactive; run it with `docker run --rm -it ...`.')
    process.exit(2)
  }
  const config = loadConfig()
  const store = new TokenStore(config.dataDir)

  console.log('Log in to Ring. Credentials are sent only to Ring and are not stored.')
  const email = await ask('Ring email: ')
  const password = await ask('Ring password: ', { hidden: true })
  const client = new RingRestClient({ email, password, controlCenterDisplayName: config.controlCenterDisplayName })

  let auth
  try {
    auth = await client.getCurrentAuth()
  } catch (err) {
    if (!client.promptFor2fa) throw err
    for (let attempt = 1; ; attempt++) {
      console.log(client.promptFor2fa)
      const code = await ask('2FA code: ')
      try {
        auth = await client.getAuth(code)
        break
      } catch {
        if (attempt >= 5) throw new Error('Too many incorrect 2FA codes')
        console.log('Incorrect code, try again.')
      }
    }
  }

  await store.save(auth.refresh_token)
  const fingerprint = createHash('sha256').update(auth.refresh_token).digest('hex').slice(0, 12)
  console.log(`Saved refresh token to ${store.file} (mode 600, fingerprint ${fingerprint}).`)
  console.log('Start or restart the app now. Revoke access any time in Ring app > Control Center > Authorized Client Devices.')
}

main().catch((err) => {
  console.error(`Login failed: ${redact(err?.message || err)}`)
  process.exit(1)
})
