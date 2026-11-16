import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { fileFingerprint, validateSceneProject, type ValidatedSceneProject } from './scene-project.js';
import { createSceneSnapshot, type SceneSnapshot } from './scene-snapshot.js';

export interface SceneResourceHandle {
  srcUrl: string;
  project: Record<string, unknown>;
  dispose(): Promise<void>;
}
interface Resource {
  validated: ValidatedSceneProject;
  snapshot: SceneSnapshot;
  handle: SceneResourceHandle;
  controllers: Set<AbortController>;
  transfers: Set<Promise<void>>;
}

/** Capability-scoped, read-only PKG transport. It cannot execute scenes or expose other files. */
export class SceneResourceServer {
  private readonly trusted: Set<string>;
  private server: http.Server | null = null;
  private listening: Promise<void> | null = null;
  private port = 0;
  private closed = false;
  private assets = new Map<string, Resource>();
  private sockets = new Set<Socket>();
  private requests = new Set<Promise<void>>();
  private active: SceneResourceHandle | null = null;
  private staging: { controller: AbortController; promise: Promise<SceneResourceHandle> } | null = null;
  private closing: Promise<void> | null = null;
  get hasActive(): boolean { return this.active !== null; }
  constructor(options: { trustedOrigins: readonly string[] }) {
    if (!options || !Array.isArray(options.trustedOrigins) || options.trustedOrigins.length === 0) {
      throw new Error('At least one exact trusted origin is required.');
    }
    for (const origin of options.trustedOrigins) {
      try {
        const parsed = new URL(origin);
        if (!parsed.hostname || parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash ||
            origin !== `${parsed.protocol}//${parsed.host}`) throw new Error('invalid origin');
      } catch { throw new Error('An exact trusted origin is required.'); }
    }
    this.trusted = new Set(options.trustedOrigins);
  }
  stage(projectPath: string): Promise<SceneResourceHandle> {
    if (this.closed) return Promise.reject(new Error('Scene server is closed.'));
    if (this.staging || [...this.assets.values()].some(resource => resource.handle !== this.active)) {
      return Promise.reject(new Error('A scene candidate is already staged.'));
    }
    const controller = new AbortController();
    const promise = this.prepare(projectPath, controller.signal);
    this.staging = { controller, promise };
    void promise.finally(() => {
      if (this.staging?.promise === promise) this.staging = null;
    }).catch(() => {});
    return promise;
  }
  private async prepare(projectPath: string, signal: AbortSignal): Promise<SceneResourceHandle> {
    const validated = await validateSceneProject(projectPath, { signal });
    const snapshot = await createSceneSnapshot(validated, signal);
    try {
      signal.throwIfAborted();
      await this.ensureListening();
      signal.throwIfAborted();
      if (this.closed) throw new Error('Scene server is closed.');
      const token = randomBytes(16).toString('hex');
      let disposal: Promise<void> | null = null;
      const handle: SceneResourceHandle = {
        srcUrl: `http://127.0.0.1:${this.port}/scene/${token}/scene.pkg?t=${token}`,
        project: JSON.parse(JSON.stringify(validated.project)) as Record<string, unknown>,
        dispose: () => {
          if (!disposal) disposal = (async () => {
            const resource = this.assets.get(token);
            if (!resource) return;
            this.assets.delete(token);
            if (this.active === handle) this.active = null;
            for (const controller of resource.controllers) controller.abort();
            await Promise.allSettled([...resource.transfers]);
            await snapshot.dispose();
          })();
          return disposal;
        },
      };
      this.assets.set(token, { validated, snapshot, handle, controllers: new Set(), transfers: new Set() });
      return handle;
    } catch (error) { await snapshot.dispose(); throw error; }
  }
  async commit(handle: SceneResourceHandle | null): Promise<void> {
    if (handle === this.active) return;
    if (this.closed) throw new Error('Scene server is closed.');
    if (handle && ![...this.assets.values()].some(resource => resource.handle === handle)) throw new Error('Scene resource is not a live candidate from this server.');
    const previous = this.active;
    this.active = handle;
    await previous?.dispose();
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.closeResources();
    return this.closing;
  }
  private async closeResources(): Promise<void> {
    this.closed = true;
    this.active = null;
    const staging = this.staging;
    staging?.controller.abort();
    await staging?.promise.catch(() => {});
    await this.listening?.catch(() => {});
    const resources = [...this.assets.values()];
    for (const resource of resources) for (const controller of resource.controllers) controller.abort();
    const server = this.server; this.server = null;
    for (const socket of this.sockets) socket.destroy();
    const stopped = server ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
    const disposed = await Promise.allSettled(resources.map(resource => resource.handle.dispose()));
    await Promise.allSettled([...this.requests]);
    await stopped;
    if (disposed.some(result => result.status === 'rejected')) throw new Error('Scene resources could not be released.');
  }
  private async ensureListening(): Promise<void> {
    if (this.closed) throw new Error('Scene server is closed.');
    if (this.server) return;
    if (this.listening) return this.listening;
    this.listening = (async () => {
      const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30000 }, (req, res) => {
        if (this.requests.size >= 4) { res.writeHead(503).end(); return; }
        const task = this.serve(req, res).catch(() => { if (res.destroyed) return; if (!res.headersSent) res.writeHead(404).end(); else res.destroy(); });
        this.requests.add(task);
        void task.finally(() => this.requests.delete(task));
      });
      server.headersTimeout = 10000;
      server.keepAliveTimeout = 1000;
      server.maxRequestsPerSocket = 50;
      server.on('connection', socket => {
        if (this.sockets.size >= 32) { socket.destroy(); return; }
        this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string' || this.closed) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw new Error('Scene server closed during startup.');
      }
      this.server = server; this.port = address.port;
    })();
    try { await this.listening; } finally { this.listening = null; }
  }
  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (req.headers.host !== `127.0.0.1:${this.port}` || !origin || origin === 'null' || !this.trusted.has(origin)) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); res.writeHead(405).end(); return; }
    // Match the raw request target so URL normalization cannot turn traversal into an accepted route.
    const match = /^\/scene\/([a-f0-9]{32})\/scene\.pkg\?t=([a-f0-9]{32})$/.exec(req.url ?? '');
    if (!match) {
      res.writeHead(/^\/scene\/[a-f0-9]{32}\/scene\.pkg(?:\?|$)/.test(req.url ?? '') ? 403 : 404).end(); return;
    }
    const token = match[1]!;
    if (token !== match[2]) { res.writeHead(403).end(); return; }
    const resource = this.assets.get(token);
    if (!resource || this.closed) { res.writeHead(404).end(); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', abort); res.once('close', close);
    resource.controllers.add(controller);
    const transfer = this.sendResource(req, res, token, resource, origin, controller.signal);
    resource.transfers.add(transfer);
    try { await transfer; }
    finally {
      resource.transfers.delete(transfer);
      resource.controllers.delete(controller);
      req.removeListener('aborted', abort); res.removeListener('close', close);
    }
  }
  private async sendResource(req: http.IncomingMessage, res: http.ServerResponse, token: string, resource: Resource, origin: string, signal: AbortSignal): Promise<void> {
    const validated = await validateSceneProject(resource.validated.projectPath, { signal });
    signal.throwIfAborted();
    if (validated.identity !== resource.validated.identity || validated.pkgPath !== resource.validated.pkgPath || this.assets.get(token) !== resource || this.closed) { res.writeHead(404).end(); return; }
    const opened = await fs.open(resource.snapshot.file, 'r');
    try {
      const stat = await opened.stat();
      signal.throwIfAborted();
      if (!stat.isFile() || fileFingerprint(stat) !== resource.snapshot.fingerprint || this.assets.get(token) !== resource || this.closed || res.destroyed) { res.writeHead(404).end(); return; }
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', stat.size);
      if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
      const stream = opened.createReadStream({ autoClose: false, start: 0, end: stat.size - 1 });
      try { await pipeline(stream, res, { signal }); }
      finally { stream.destroy(); }
    } finally { await opened.close(); }
  }
}
