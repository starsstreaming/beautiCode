import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

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
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid request target');
    return new URL(req.url, 'http://127.0.0.1');
  } catch {
    res.writeHead(400).end(JSON.stringify({ ok: false, error: 'Invalid request target.' }));
    return null;
  }
}

export async function streamLocalFile(file: string, res: ServerResponse): Promise<void> {
  await pipeline(createReadStream(file), res);
}

export function responseAbortSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  if (res.destroyed) controller.abort();
  else res.once('close', () => controller.abort());
  return controller.signal;
}
