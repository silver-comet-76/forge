// Shared transport helpers for every surface: the store instance, auth, JSON answers and body
// reading. app.ts, rest.ts, graphql.ts and mcp.ts all import from here; none imports the others.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The shop token the trial sets; the suite presents it as `Authorization: Bearer <token>`. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The forge's one store: every surface reads and writes the same repositories. */
export const store = new Store();

let requestCounter = 0;
/** A per-request id, as GitHub's X-GitHub-Request-Id header carries. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with a 204 and no body. */
export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query of a request URL, or empty params when it does not parse. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read a request body whole. Empty when there is none. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** True when the request carries the trial's bearer token (or any non-empty one when unset). */
export function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (SHOP_TOKEN === '') return token !== '';
  return token === SHOP_TOKEN;
}

export function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** Parse a JSON body; returns null (and answers 400) when it is not valid JSON. */
export function parseJsonBody(res: ServerResponse, body: Buffer): Record<string, unknown> | unknown[] | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown> | unknown[];
    return null;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return null;
  }
}
