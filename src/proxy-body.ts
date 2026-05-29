export function isUtf8RequestBody(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  if (!normalized) return false;
  return normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized.endsWith('+json')
    || normalized === 'application/xml'
    || normalized === 'text/xml'
    || normalized.endsWith('+xml')
    || normalized === 'application/javascript'
    || normalized === 'text/javascript'
    || normalized === 'application/x-www-form-urlencoded';
}

export function encodeProxyRequestBody(
  body: unknown,
  contentType: string | undefined,
): { bodyEncoding?: 'utf8' | 'base64'; body?: string } {
  if (!Buffer.isBuffer(body) && typeof body !== 'string') {
    return {};
  }

  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const bodyEncoding = isUtf8RequestBody(contentType) ? 'utf8' as const : 'base64' as const;

  return {
    bodyEncoding,
    body: bodyEncoding === 'base64'
      ? rawBody.toString('base64')
      : rawBody.toString('utf8'),
  };
}
