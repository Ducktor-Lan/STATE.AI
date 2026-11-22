const REDACTED = '[REDACTED]';
const sensitiveName = /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential|cookie|signature/i;

/** Parse a complete structured URL; malformed values must never be echoed back. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return REDACTED;
    url.username = '';
    url.password = '';
    // Query names are not a reliable indication of credentials; remove the entire query/fragment.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return REDACTED;
  }
}

/** No response/body, URL or exception from fetch is ever used as an error message. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const encoded of new Set([secret, encodeURIComponent(secret)])) {
      safe = safe.split(encoded).join(REDACTED);
    }
  }
  // Apostrophes are legal in URL paths/userinfo. Only the double quote is a JSON string boundary.
  safe = safe.replace(/https?:\/\/[^\s<>"]+/gi, (value) => redactUrl(value));
  return safe
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.~=-]+/gi, REDACTED)
    .replace(/((?:authorization|x-api-key|x-goog-api-key|api[_-]?key|access[_-]?token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${REDACTED}`);
}

export function redactValue(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 32) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1));
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    const safeKey = redactText(key, secrets);
    result[safeKey] = sensitiveName.test(key) ? REDACTED : redactValue(item, secrets, depth + 1);
  }
  return result;
}
