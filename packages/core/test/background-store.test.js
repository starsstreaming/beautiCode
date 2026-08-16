import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundStore } from "../dist/background-store.js";
import { ApplyTransaction } from "../dist/apply-transaction.js";
import { MediaServerController } from "../dist/media-server.js";
import { SCHEMA_ID } from "../dist/constants.js";
import { COMMIT_MARKER_NAME } from "../dist/constants.js";

function mp4Fixture(marker = "AAAA") {
  const fileTypeBox = Buffer.alloc(24);
  fileTypeBox.writeUInt32BE(fileTypeBox.length, 0);
  fileTypeBox.write("ftyp", 4, "ascii");
  fileTypeBox.write("isom", 8, "ascii");
  fileTypeBox.writeUInt32BE(512, 12);
  fileTypeBox.write("isom", 16, "ascii");
  fileTypeBox.write("mp41", 20, "ascii");
  return Buffer.concat([fileTypeBox, Buffer.from(marker, "ascii")]);
}

function pngFixture() {
  return Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
}

async function writeFixtures(dir) {
  const imagePath = path.join(dir, "src.png");
  const videoPath = path.join(dir, "src.mp4");
  await fs.writeFile(imagePath, pngFixture());
  await fs.writeFile(videoPath, mp4Fixture("VID1"));
  return { imagePath, videoPath };
}

test("background store atomic image/video/clear + generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-store-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath, videoPath } = await writeFixtures(fixtures);
  const store = new BackgroundStore({ root: path.join(root, "data") });
  await store.init();

  let m = await store.readActiveManifest();
  assert.equal(m.schema, SCHEMA_ID);
  assert.equal(m.generation, 0);
  assert.equal(m.background, null);

  m = await store.commitImport({ type: "image", imagePath });
  assert.equal(m.generation, 1);
  assert.equal(m.background?.type, "image");
  assert.ok(m.background?.image.endsWith(".png"));

  m = await store.commitImport({ type: "video", imagePath, videoPath });
  assert.equal(m.generation, 2);
  assert.equal(m.background?.type, "video");
  assert.equal(m.background?.video, "background.mp4");
  const activeVideo = await store.activeVideoPath();
  assert.ok(activeVideo && (await fs.stat(activeVideo)).isFile());

  // Video-only: reuse active poster (no imagePath).
  const video2 = path.join(fixtures, "src2.mp4");
  await fs.writeFile(video2, mp4Fixture("VID2"));
  m = await store.commitImport({ type: "video", videoPath: video2 });
  assert.equal(m.generation, 3);
  assert.equal(m.background?.type, "video");
  assert.ok(m.background?.image);

  m = await store.commitImport({ type: "clear" });
  assert.equal(m.generation, 4);
  assert.equal(m.background, null);

  // Video-only with empty active → synthetic poster.
  m = await store.commitImport({ type: "video", videoPath });
  assert.equal(m.generation, 5);
  assert.equal(m.background?.type, "video");
  assert.equal(m.background?.image, "poster.png");

  await fs.rm(root, { recursive: true, force: true });
});

test("fresh commit marker blocks reads; stale marker is ignored", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-marker-"));
  const store = new BackgroundStore({
    root,
    commitMarkerStaleMs: 60_000,
  });
  await store.init();
  const marker = path.join(store.paths.activeDir, COMMIT_MARKER_NAME);
  await fs.writeFile(marker, "busy", "utf8");
  await assert.rejects(() => store.readActiveManifest(), /commit in progress/);

  // Make it stale
  const staleStore = new BackgroundStore({
    root,
    commitMarkerStaleMs: 1,
  });
  await new Promise((r) => setTimeout(r, 5));
  const m = await staleStore.readActiveManifest();
  assert.equal(m.generation, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("snapshot cleanup cannot target the snapshots root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-snapshot-path-"));
  const store = new BackgroundStore({ root });
  await store.init();
  await assert.rejects(
    () =>
      store.clearSnapshot({
        id: "forged",
        dir: store.paths.snapshotsDir,
        manifest: {
          schema: SCHEMA_ID,
          generation: 0,
          background: null,
          updatedAt: new Date().toISOString(),
        },
      }),
    /generated child/i,
  );
  assert.equal((await fs.stat(store.paths.snapshotsDir)).isDirectory(), true);
  await fs.rm(root, { recursive: true, force: true });
});

test("apply transaction rolls back when host verify fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-apply-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath } = await writeFixtures(fixtures);

  const store = new BackgroundStore({ root: path.join(root, "data") });
  await store.init();
  await store.commitImport({ type: "image", imagePath });

  const applies = [];
  const host = {
    async apply(payload) {
      applies.push(payload);
    },
    async verify() {
      return { status: "fail", reason: "forced failure for test" };
    },
  };

  const image2 = path.join(fixtures, "other.png");
  await fs.writeFile(image2, pngFixture());

  const media = new MediaServerController();
  const tx = new ApplyTransaction({
    store,
    media,
    host,
    offline: false,
  });

  const result = await tx.run({ type: "image", imagePath: image2 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rolledBack, true);

  // Active should still be generation-bumped restore of original image type
  const active = await store.readActiveManifest();
  assert.equal(active.background?.type, "image");
  // apply called for new + restore
  assert.ok(applies.length >= 2);
  // Codex CSP requires data: image; loopback URL is optional secondary.
  assert.match(applies[0].imageDataUrl ?? "", /^data:image\//);
  assert.ok(
    !applies[0].imageUrl ||
      applies[0].imageUrl.startsWith("http://127.0.0.1:"),
  );

  await media.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("apply transaction rolls back when readiness never becomes conclusive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-inconclusive-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath } = await writeFixtures(fixtures);
  const store = new BackgroundStore({ root: path.join(root, "data") });
  await store.init();

  let applyCount = 0;
  const host = {
    async apply() {
      applyCount += 1;
    },
    async verify() {
      return { status: "inconclusive", reason: "image still decoding" };
    },
  };
  const media = new MediaServerController();
  const tx = new ApplyTransaction({
    store,
    media,
    host,
    verifyDeadlineMs: 10,
  });

  const result = await tx.run({ type: "image", imagePath });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.rolledBack, true);
    assert.match(result.error, /inconclusive|decoding/i);
  }
  assert.equal((await store.readActiveManifest()).background, null);
  assert.ok(applyCount >= 2);

  await media.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("apply transaction offline success path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-off-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath, videoPath } = await writeFixtures(fixtures);
  const store = new BackgroundStore({ root: path.join(root, "data") });
  const media = new MediaServerController();
  const tx = new ApplyTransaction({ store, media, offline: true });

  const r1 = await tx.run({ type: "image", imagePath });
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(r1.mode, "image");

  const r2 = await tx.run({ type: "video", videoPath });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.mode, "video");
  assert.ok(media.activeVideo?.url.startsWith("http://127.0.0.1:"));
  assert.ok(media.activeImage?.srcUrl.includes("?t="));
  assert.ok(
    path.resolve(media.activeVideo.filePath).startsWith(
      `${path.resolve(store.paths.runtimeMediaDir)}${path.sep}`,
    ),
  );
  assert.ok(
    !path.resolve(media.activeVideo.filePath).startsWith(
      `${path.resolve(store.paths.activeDir)}${path.sep}`,
    ),
  );

  const r3 = await tx.run({ type: "clear" });
  assert.equal(r3.ok, true);
  assert.equal(media.activeImage, null);
  assert.equal(media.activeVideo, null);
  await media.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("live video payload uses a detached runtime copy outside active", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-video-runtime-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath, videoPath } = await writeFixtures(fixtures);
  const store = new BackgroundStore({ root: path.join(root, "data") });
  const payloads = [];
  const host = {
    async apply(payload) {
      payloads.push(payload);
    },
    async verify() {
      return { status: "pass", reason: "ok" };
    },
  };
  const media = new MediaServerController({ enabled: false });
  const tx = new ApplyTransaction({ store, media, host });

  const videoResult = await tx.run({ type: "video", imagePath, videoPath });
  assert.equal(videoResult.ok, true);
  const runtimePath = payloads.at(-1)?.video?.localPath;
  assert.equal(typeof runtimePath, "string");
  assert.ok(
    path.resolve(runtimePath).startsWith(
      `${path.resolve(store.paths.runtimeMediaDir)}${path.sep}`,
    ),
  );
  assert.ok(
    !path.resolve(runtimePath).startsWith(
      `${path.resolve(store.paths.activeDir)}${path.sep}`,
    ),
  );
  assert.deepEqual(await fs.readFile(runtimePath), await fs.readFile(videoPath));

  // The next active-directory promotion no longer depends on the renderer
  // releasing its video file immediately.
  const runtimeHandle = await fs.open(runtimePath, "r");
  try {
    const imageResult = await tx.run({ type: "image", imagePath });
    assert.equal(imageResult.ok, true);
  } finally {
    await runtimeHandle.close();
  }

  await media.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("busy mutex rejects concurrent apply", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-busy-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath } = await writeFixtures(fixtures);
  const store = new BackgroundStore({ root: path.join(root, "data") });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const host = {
    async apply() {
      await gate;
    },
    async verify() {
      return { status: "pass", reason: "ok" };
    },
  };
  const media = new MediaServerController();
  const tx = new ApplyTransaction({
    store,
    media,
    host,
  });
  const p1 = tx.run({ type: "image", imagePath });
  // give p1 time to set busy
  await new Promise((r) => setTimeout(r, 20));
  const p2 = await tx.run({ type: "image", imagePath });
  assert.equal(p2.ok, false);
  if (!p2.ok) assert.match(p2.error, /already in progress/);
  release();
  const r1 = await p1;
  assert.equal(r1.ok, true);
  await media.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("save/list/use theme keeps Chinese display name and ASCII id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-theme-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath, videoPath } = await writeFixtures(fixtures);
  const store = new BackgroundStore({ root: path.join(root, "data") });
  await store.init();
  await store.commitImport({ type: "video", imagePath, videoPath });

  const saved = await store.saveCurrentTheme("图片-测试主题");
  assert.equal(saved.name, "图片-测试主题");
  assert.match(saved.id, /^theme-[a-z0-9]+-[a-z0-9]+$/i);
  assert.equal(saved.type, "video");

  const listed = await store.listSavedThemes();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, saved.id);
  assert.equal(listed[0].name, "图片-测试主题");

  // Switch away then restore by ASCII folder id.
  await store.commitImport({ type: "image", imagePath });
  const restoredPack = await store.useSavedTheme(saved.id);
  const restored = restoredPack.manifest;
  assert.equal(restored.background?.type, "video");
  assert.ok(restored.generation >= 2);

  // Legacy non-ASCII directory still restorable via folder name.
  const legacyDir = path.join(store.paths.savedDir, "图片-legacy-ms4r2o0n");
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.copyFile(
    path.join(store.paths.activeDir, restored.background.image),
    path.join(legacyDir, restored.background.image),
  );
  await fs.copyFile(
    path.join(store.paths.activeDir, restored.background.video),
    path.join(legacyDir, restored.background.video),
  );
  await fs.writeFile(
    path.join(legacyDir, "background.json"),
    JSON.stringify(
      {
        schema: SCHEMA_ID,
        generation: 0,
        background: {
          type: "video",
          image: restored.background.image,
          video: restored.background.video,
        },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(legacyDir, "theme.json"),
    JSON.stringify(
      {
        id: "mojibake-not-folder",
        name: "旧主题",
        type: "video",
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  const listed2 = await store.listSavedThemes();
  const legacy = listed2.find((t) => t.name === "旧主题");
  assert.ok(legacy);
  assert.equal(legacy.id, "图片-legacy-ms4r2o0n");
  const usedLegacy = await store.useSavedTheme(legacy.id);
  assert.equal(usedLegacy.manifest.background?.type, "video");

  await fs.rm(root, { recursive: true, force: true });
});

test("video theme progress is bound per theme and invalid becomes null", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-theme-pos-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath, videoPath } = await writeFixtures(fixtures);
  const store = new BackgroundStore({ root: path.join(root, "data") });
  await store.init();
  await store.commitImport({ type: "video", imagePath, videoPath });

  const saved = await store.saveCurrentTheme("进度主题", {
    videoPositionSec: 12.3456,
  });
  assert.equal(saved.videoPositionSec, 12.346);

  const listed = await store.listSavedThemes();
  assert.equal(listed[0].videoPositionSec, 12.346);

  const updated = await store.updateSavedThemeVideoPosition(saved.id, 30.1);
  assert.equal(updated.ok, true);
  assert.equal(updated.positionSec, 30.1);

  // Identical rounded value skips rewrite but still ok.
  const same = await store.updateSavedThemeVideoPosition(saved.id, 30.1);
  assert.equal(same.ok, true);
  assert.equal(same.positionSec, 30.1);

  const bad = await store.updateSavedThemeVideoPosition(saved.id, -3);
  assert.equal(bad.ok, false);

  const pack = await store.useSavedTheme(saved.id);
  assert.equal(pack.manifest.background?.type, "video");
  assert.equal(pack.videoPositionSec, 30.1);

  // Image theme: no position field.
  await store.commitImport({ type: "image", imagePath });
  const imgTheme = await store.saveCurrentTheme("仅图片", {
    videoPositionSec: 9,
  });
  assert.equal(imgTheme.videoPositionSec, undefined);
  const imgUpdate = await store.updateSavedThemeVideoPosition(imgTheme.id, 5);
  assert.equal(imgUpdate.ok, false);

  await fs.rm(root, { recursive: true, force: true });
});

test("store lease blocks a second BackgroundStore instance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-store-lock-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath } = await writeFixtures(fixtures);
  const dataRoot = path.join(root, "data");
  const first = new BackgroundStore({ root: dataRoot });
  const second = new BackgroundStore({ root: dataRoot });
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const held = first.withExclusiveMutation(async () => gate);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    () => second.commitImport({ type: "image", imagePath }),
    /store mutation.*pid/i,
  );
  releaseGate();
  await held;
  const committed = await second.commitImport({ type: "image", imagePath });
  assert.equal(committed.background?.type, "image");
  await fs.rm(root, { recursive: true, force: true });
});

test("stale directory-swap journal recovers a complete next generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-recover-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath } = await writeFixtures(fixtures);
  const dataRoot = path.join(root, "data");
  const store = new BackgroundStore({
    root: dataRoot,
    commitMarkerStaleMs: 1,
  });
  const first = await store.commitImport({ type: "image", imagePath });

  const nextName = "tx-crash-fixture";
  const backupName = "active-backup-crash-fixture";
  const nextDir = path.join(store.paths.stagingDir, nextName);
  const backupDir = path.join(dataRoot, backupName);
  await fs.mkdir(nextDir, { recursive: true });
  await fs.copyFile(
    path.join(store.paths.activeDir, first.background.image),
    path.join(nextDir, first.background.image),
  );
  await fs.writeFile(
    path.join(nextDir, "background.json"),
    `${JSON.stringify(
      {
        ...first,
        generation: first.generation + 1,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.rename(store.paths.activeDir, backupDir);
  await fs.writeFile(
    path.join(dataRoot, ".beauticode-commit.json"),
    `${JSON.stringify(
      {
        version: 1,
        phase: "old-moved",
        nextDir: nextName,
        backupDir: backupName,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dataRoot, COMMIT_MARKER_NAME),
    "crashed",
    "utf8",
  );
  await new Promise((resolve) => setTimeout(resolve, 5));

  const recovered = await new BackgroundStore({
    root: dataRoot,
    commitMarkerStaleMs: 1,
  }).readActiveManifest();
  assert.equal(recovered.generation, first.generation + 1);
  await assert.rejects(() => fs.access(backupDir));
  await assert.rejects(() =>
    fs.access(path.join(dataRoot, ".beauticode-commit.json")),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("data root ownership refuses an unrelated non-empty directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-root-owner-"));
  const unrelated = path.join(root, "project");
  await fs.mkdir(unrelated);
  const keep = path.join(unrelated, "important.txt");
  await fs.writeFile(keep, "keep", "utf8");

  const store = new BackgroundStore({ root: unrelated });
  await assert.rejects(() => store.init(), /Refusing to adopt a non-empty/i);
  assert.equal(await fs.readFile(keep, "utf8"), "keep");
  await assert.rejects(() => fs.access(path.join(unrelated, "active")));

  await fs.rm(root, { recursive: true, force: true });
});

test("data root ownership adopts a valid legacy active manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-root-legacy-"));
  const active = path.join(root, "active");
  await fs.mkdir(active);
  await fs.writeFile(
    path.join(active, "background.json"),
    `${JSON.stringify({
      schema: SCHEMA_ID,
      generation: 0,
      background: null,
      updatedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  const store = new BackgroundStore({ root });
  assert.equal((await store.readActiveManifest()).generation, 0);
  const marker = JSON.parse(
    await fs.readFile(path.join(root, ".beauticode-root.json"), "utf8"),
  );
  assert.equal(marker.schema, "beauticode.data-root/v1");

  await fs.rm(root, { recursive: true, force: true });
});

test("data root tolerates tray logs created before the ownership marker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-root-log-"));
  await fs.mkdir(path.join(root, "logs"));
  await fs.writeFile(path.join(root, "logs", "tray.log"), "old tray\n", "utf8");

  const store = new BackgroundStore({ root });
  const manifest = await store.readActiveManifest();
  assert.equal(manifest.background, null);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, ".beauticode-root.json"), "utf8")).schema,
    "beauticode.data-root/v1",
  );

  await fs.rm(root, { recursive: true, force: true });
});

test("saved theme quota and deletion are enforced", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-theme-quota-"));
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const { imagePath } = await writeFixtures(fixtures);
  const store = new BackgroundStore({
    root: path.join(root, "data"),
    maxSavedThemes: 1,
  });
  await store.commitImport({ type: "image", imagePath });

  const first = await store.saveCurrentTheme("first");
  await assert.rejects(
    () => store.saveCurrentTheme("second"),
    /limit reached/i,
  );
  assert.equal(await store.deleteSavedTheme(first.id), true);
  assert.equal(await store.deleteSavedTheme(first.id), false);
  const second = await store.saveCurrentTheme("second");
  assert.equal((await store.listSavedThemes())[0].id, second.id);
  await assert.rejects(
    () => store.deleteSavedTheme("../active"),
    /invalid saved theme id/i,
  );

  await fs.rm(root, { recursive: true, force: true });
});
