const secrets = new Set()

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value)
}

const PATTERNS = [
  [/("?(?:refresh_token|access_token|refreshToken|password|rt|pnc|authorization)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/((?:refresh_token|access_token|password)=)[^&\s]+/gi, '$1[REDACTED]'],
  // Ring refresh tokens are long base64 blobs; nothing legitimate in our logs looks like that.
  [/[A-Za-z0-9+/_-]{120,}={0,2}/g, '[REDACTED]'],
]

export function redact(input) {
  let text = typeof input === 'string' ? input : input instanceof Error ? input.stack || input.message : safeStringify(input)
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement)
  return text
}

function safeStringify(value) {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  } catch {
    return String(value)
  }
}
