import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';

/** Own every asynchronous failure at the HTTP boundary, including event callbacks. */
export function guardHttpHandler(handler: (req: IncomingMessage, res: ServerResponse) => unknown) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    req.once('error', () => res.destroy());
    res.once('error', () => res.destroy());
    Promise.resolve().then(() => handler(req, res)).catch(() => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Request failed.' }));
    });
  };
}

export function parseLocalRequestUrl(req: IncomingMessage, res: ServerResponse): URL | null {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.startsWith('/\\')) throw new Error('Invalid request target');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.origin !== 'http://127.0.0.1') throw new Error('Invalid request target');
    return url;
  } catch {
    res.writeHead(400).end(JSON.stringify({ ok: false, error: 'Invalid request target.' }));
    return null;
  }
}

export async function streamLocalFile(file: string, res: ServerResponse): Promise<void> {
  const source = createReadStream(file);
  // Preserve a writable response for open failures; pipeline owns later errors.
  await once(source, 'open');
  await pipeline(source, res);
}

export function responseAbortSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  if (res.destroyed) controller.abort();
  else res.once('close', () => controller.abort());
  return controller.signal;
}
