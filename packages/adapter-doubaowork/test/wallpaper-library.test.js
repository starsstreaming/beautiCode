import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverWorkshopRoots,
  mediaForProject,
  mergeWallpaperLibrary,
  pathsFromLibraryFolders,
} from "../dist/wallpaper-library.js";

test("Steam library folders reveal the workshop root without a hardcoded drive", () => {
  const text = `"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"E:\\\\steam"\n\t}\n}\n`;
  assert.deepEqual(pathsFromLibraryFolders(text), ["E:\\steam"]);
  const roots = discoverWorkshopRoots([text], (dir) => dir === "E:\\steam\\steamapps\\workshop\\content\\431960");
  assert.deepEqual(roots, ["E:\\steam\\steamapps\\workshop\\content\\431960"]);
});

test("a scene project keeps project.json and uses its preview poster", () => {
  const item = mediaForProject("E:\\steam\\steamapps\\workshop\\content\\431960\\3286906338\\project.json", {
    title: "Pikachu - Champ",
    type: "scene",
    file: "scene.pkg",
  }, (file) => file.endsWith("preview.gif"));
  assert.equal(item.themeType, "scene");
  assert.equal(item.title, "Pikachu - Champ");
  assert.equal(item.mediaPath, "E:\\steam\\steamapps\\workshop\\content\\431960\\3286906338\\preview.gif");
});

test("merging a library scan keeps existing theme bindings", () => {
  const record = mergeWallpaperLibrary({
    version: 1,
    roots: ["C:\\old"],
    bindings: { abc: { themeId: "theme-1", source: "src" } },
  }, ["E:\\steam\\steamapps\\workshop\\content\\431960"]);
  assert.equal(record.bindings.abc.themeId, "theme-1");
  assert.deepEqual(record.roots, ["E:\\steam\\steamapps\\workshop\\content\\431960"]);
});
