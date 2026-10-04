import { statSync } from 'node:fs'

const file = `${process.env.DATA_DIR || '/data'}/heartbeat`
try {
  process.exit(Date.now() - statSync(file).mtimeMs < 180000 ? 0 : 1)
} catch {
  process.exit(1)
}
