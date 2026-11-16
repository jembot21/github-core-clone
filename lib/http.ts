// HTTP plumbing shared by every surface: JSON replies with the headers the wire
// contract requires, JSON errors, and request-body reading. Git protocol replies
// are binary and do not go through here.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** A fresh non-empty request id, as the contract requires on every REST reply. */
export function requestId(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}

/** Answer with a JSON body and the contract headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with no body at all (a 204). */
export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId(), 'content-length': 0 });
  res.end();
}

/** The GitHub error shape: a JSON object with a string message. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Read a whole request body. Bodies here are JSON or git packs; both fit in memory. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a request body as JSON. An empty body reads as an empty object; a body
 * that is not JSON is the caller's 400, reported by returning null after the
 * caller checks `malformed` — so this returns { value } or { malformed: true }.
 */
export function parseJsonBody(raw: Buffer): { value: Record<string, unknown> } | { malformed: true } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { value: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { malformed: true };
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { malformed: true };
  }
}

/** The request's base URL (scheme + host) for building absolute links. */
export function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** A string field from a JSON body, or null when absent or not a string. */
export function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

/** A boolean field from a JSON body, or null when absent or not a boolean. */
export function boolField(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];
  return typeof value === 'boolean' ? value : null;
}
