import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SKIN_CENTER_ORIGIN,
  SkinCatalogError,
  downloadApprovedAsset,
  getApprovedSkin,
  isSafeSkinId,
  listApprovedSkins,
  parseApprovedSkinCatalog,
} from "../dist/skin-catalog.js";

function pngFixture() {
  return Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
}

function jsonResponse(value, { url = `${SKIN_CENTER_ORIGIN}/api/catalog`, length } = {}) {
  const text = JSON.stringify(value);
  const response = new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(length ?? Buffer.byteLength(text)),
    },
  });
  return {
    ok: true,
    url,
    headers: response.headers,
    body: response.body,
    text: () => response.text(),
  };
}

test("skin catalog has one fixed production origin and safe IDs", () => {
  assert.equal(SKIN_CENTER_ORIGIN, "https://hnnulwh.cn");
  assert.equal(isSafeSkinId("skin-1c4966b620dd6227"), true);
  assert.equal(isSafeSkinId("skin-../local-file"), false);
  assert.equal(isSafeSkinId("skin-123"), false);
});

test("catalog parser keeps approved metadata and derives asset URLs", () => {
  const parsed = parseApprovedSkinCatalog({
    ok: true,
    skins: [
      {
        id: "skin-1c4966b620dd6227",
        name: "室内",
        type: "image",
        status: "approved",
        updatedAt: "2026-09-16T12:02:11.457Z",
        imageUrl: "https://attacker.invalid/read-me",
      },
    ],
  });
  assert.deepEqual(parsed, [
    {
      source: "hnnulwh",
      sourceSkinId: "skin-1c4966b620dd6227",
      sourceVersion: "updatedAt:2026-09-16T12:02:11.457Z",
      id: "skin-1c4966b620dd6227",
      name: "室内",
      type: "image",
      status: "approved",
      assetUrl: "https://hnnulwh.cn/api/skins/skin-1c4966b620dd6227/image",
    },
  ]);
});

test("catalog parser accepts the production approvedAt publication revision shape", () => {
  const [parsed] = parseApprovedSkinCatalog({
    ok: true,
    skins: [{
      id: "skin-1c4966b620dd6227",
      name: "生产主题",
      type: "image",
      status: "approved",
      createdAt: "2026-09-16T11:02:11.457Z",
      approvedAt: "2026-09-17T12:02:11.457Z",
    }],
  });
  assert.equal(parsed?.sourceVersion, "approved-at:2026-09-17T12:02:11.457Z");
});

test("catalog parser prioritizes explicit versions over publication revisions", () => {
  const base = {
    id: "skin-1c4966b620dd6227",
    name: "修订优先级",
    type: "image",
    status: "approved",
    updatedAt: "2026-09-17T12:02:11.457Z",
    approvedAt: "2026-09-18T12:02:11.457Z",
  };
  assert.equal(parseApprovedSkinCatalog({ skins: [{ ...base, version: "v7" }] })[0]?.sourceVersion, "version:v7");
  assert.equal(parseApprovedSkinCatalog({ skins: [base] })[0]?.sourceVersion, "updatedAt:2026-09-17T12:02:11.457Z");
  assert.equal(parseApprovedSkinCatalog({ skins: [{ ...base, updatedAt: "not-a-time", ETag: "W/\"catalog-7\"" }] })[0]?.sourceVersion, "etag:W/\"catalog-7\"");
  assert.equal(parseApprovedSkinCatalog({ skins: [{ ...base, updatedAt: "not-a-time", etag: undefined }] })[0]?.sourceVersion, "approved-at:2026-09-18T12:02:11.457Z");
  assert.throws(
    () => parseApprovedSkinCatalog({ skins: [{ ...base, updatedAt: "not-a-time", approvedAt: "2026-02-30T12:02:11Z" }] }),
    /publication revision/i,
  );
});

test("catalog parser fails closed for unpublished, malformed, or unversioned entries", () => {
  assert.throws(
    () =>
      parseApprovedSkinCatalog({
        skins: [
          {
            id: "skin-1c4966b620dd6227",
            name: "not approved",
            type: "image",
            status: "pending",
            updatedAt: "2026-09-16T12:02:11.457Z",
          },
        ],
      }),
    /approved/,
  );
  assert.throws(
    () =>
      parseApprovedSkinCatalog({
        skins: [
          {
            id: "skin-1c4966b620dd6227",
            name: "no version",
            type: "image",
            status: "approved",
          },
        ],
      }),
    /version/i,
  );
  assert.throws(
    () =>
      parseApprovedSkinCatalog({
        skins: [
          {
            id: "skin-1c4966b620dd6227",
            name: "bad type",
            type: "audio",
            status: "approved",
            version: "v1",
          },
        ],
      }),
    /type/,
  );
});

test("catalog client validates final origin and bounds JSON responses", async () => {
  await assert.rejects(
    () =>
      listApprovedSkins({
        fetchImpl: async () =>
          jsonResponse({ ok: true, skins: [] }, { url: "https://attacker.invalid/api/catalog" }),
      }),
    /trusted origin|redirect/i,
  );

  await assert.rejects(
    () =>
      listApprovedSkins({
        fetchImpl: async () =>
          jsonResponse({ ok: true, skins: [] }, { length: 512 * 1024 + 1 }),
      }),
    /size limit/i,
  );
});

test("metadata client requires an approved, versioned skin", async () => {
  await assert.rejects(
    () =>
      getApprovedSkin("skin-1c4966b620dd6227", {
        fetchImpl: async () =>
          jsonResponse({
            ok: true,
            skin: {
              id: "skin-1c4966b620dd6227",
              name: "室内",
              type: "image",
              status: "approved",
            },
          }, { url: `${SKIN_CENTER_ORIGIN}/api/skins/skin-1c4966b620dd6227` }),
      }),
    /version/i,
  );
});

test("asset client streams to a temp file and reuses media validation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-skin-catalog-"));
  const skin = parseApprovedSkinCatalog({
    skins: [{
      id: "skin-1c4966b620dd6227",
      name: "室内",
      type: "image",
      status: "approved",
      version: "v1",
    }],
  })[0];
  assert.ok(skin);
  try {
    const bytes = pngFixture();
    const downloaded = await downloadApprovedAsset(skin, "image", {
      directory: root,
      fetchImpl: async () => {
        const response = new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(bytes.length) },
        });
        return {
          ok: true,
          url: `${SKIN_CENTER_ORIGIN}/api/skins/${skin.id}/image`,
          headers: response.headers,
          body: response.body,
        };
      },
    });
    assert.equal(downloaded.bytes, bytes.length);
    assert.equal((await fs.readFile(downloaded.filePath)).equals(bytes), true);
    await fs.rm(downloaded.tempDir, { recursive: true, force: true });

    await assert.rejects(
      () =>
        downloadApprovedAsset(skin, "image", {
          directory: root,
          fetchImpl: async () => {
            const response = new Response(Buffer.from("not-an-image"), {
              status: 200,
              headers: { "content-type": "image/png" },
            });
            return {
              ok: true,
              url: `${SKIN_CENTER_ORIGIN}/api/skins/${skin.id}/image`,
              headers: response.headers,
              body: response.body,
            };
          },
        }),
      /signature|validation/i,
    );
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith(".hnnulwh-")), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("asset client creates a missing temp parent before streaming", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-skin-catalog-parent-"));
  const directory = path.join(root, "first-run", "gallery");
  const skin = parseApprovedSkinCatalog({
    skins: [{
      id: "skin-1c4966b620dd6227",
      name: "室内",
      type: "image",
      status: "approved",
      version: "v1",
    }],
  })[0];
  assert.ok(skin);
  try {
    const bytes = pngFixture();
    const downloaded = await downloadApprovedAsset(skin, "image", {
      directory,
      fetchImpl: async () => {
        const response = new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(bytes.length) },
        });
        return {
          ok: true,
          url: `${SKIN_CENTER_ORIGIN}/api/skins/${skin.id}/image`,
          headers: response.headers,
          body: response.body,
        };
      },
    });
    assert.equal((await fs.readFile(downloaded.filePath)).equals(bytes), true);
    await fs.rm(downloaded.tempDir, { recursive: true, force: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
