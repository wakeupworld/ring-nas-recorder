import { redact } from './redact.js'

function emit(stream, level, args) {
  stream.write(`${new Date().toISOString()} ${level} ${args.map(redact).join(' ')}\n`)
}

export const log = {
  debugEnabled: false,
  info: (...args) => emit(process.stdout, 'INFO ', args),
  warn: (...args) => emit(process.stderr, 'WARN ', args),
  error: (...args) => emit(process.stderr, 'ERROR', args),
  debug: (...args) => {
    if (log.debugEnabled) emit(process.stdout, 'DEBUG', args)
  },
}
