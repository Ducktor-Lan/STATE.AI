import type { IncomingMessage, ServerResponse } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'INVALID_REQUEST') {
    super(message); this.name = 'HttpError';
  }
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function assertLocalRequest(request: IncomingMessage, port: number): void {
  const rawHost = request.headers.host;
  if (!rawHost || /[\s/@\\?#]/u.test(rawHost)) throw new HttpError(403, 'A local Host header is required.', 'FORBIDDEN_HOST');
  let host: URL;
  try { host = new URL(`http://${rawHost}`); } catch { throw new HttpError(403, 'Invalid Host header.', 'FORBIDDEN_HOST'); }
  if (!['127.0.0.1', 'localhost'].includes(host.hostname) || Number(host.port || 80) !== port) {
    throw new HttpError(403, 'Host must address this local service.', 'FORBIDDEN_HOST');
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new HttpError(403, 'Invalid Origin header.', 'FORBIDDEN_ORIGIN'); }
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || Number(parsed.port || 80) !== port || parsed.origin !== origin) {
      throw new HttpError(403, 'Only a local same-service Origin is permitted.', 'FORBIDDEN_ORIGIN');
    }
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? '')
    && request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Cross-site changes are forbidden.', 'FORBIDDEN_ORIGIN');
  }
}
export async function readJson(request: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType && contentType !== 'application/json') throw new HttpError(415, 'Use Content-Type: application/json.', 'UNSUPPORTED_MEDIA_TYPE');
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    request.resume(); throw new HttpError(413, `JSON request exceeds ${maxBytes} bytes.`, 'BODY_TOO_LARGE');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) { request.resume(); throw new HttpError(413, `JSON request exceeds ${maxBytes} bytes.`, 'BODY_TOO_LARGE'); }
    chunks.push(buffer);
  }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'Request body is not valid JSON.', 'INVALID_JSON'); }
}
export function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  response.end(JSON.stringify(value));
}
export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/u.test(id)) throw new HttpError(400, 'Invalid record identifier.');
  return id;
}
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Decode once and require both lexical and real paths to remain under the run-owned root. */
export async function confinedFile(root: string, pieces: string[]): Promise<string> {
  if (!pieces.length || pieces.some(piece => !piece || piece === '.' || piece === '..'
    || /[\\/\0:%]/u.test(piece))) throw new HttpError(400, 'Invalid artifact path.', 'INVALID_PATH');
  const candidate = resolve(root, ...pieces);
  if (!within(resolve(root), candidate)) throw new HttpError(403, 'Artifact path escapes its run.', 'INVALID_PATH');
  let canonicalRoot: string, canonicalFile: string;
  try { [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(candidate)]); }
  catch (error) {
    if (isObject(error) && error.code === 'ENOENT') throw new HttpError(404, 'Artifact not found.', 'NOT_FOUND');
    throw error;
  }
  if (!within(canonicalRoot, canonicalFile)) throw new HttpError(403, 'Artifact symlink escapes its run.', 'INVALID_PATH');
  const stat = await lstat(canonicalFile);
  if (!stat.isFile()) throw new HttpError(404, 'Artifact not found.', 'NOT_FOUND');
  return canonicalFile;
}
