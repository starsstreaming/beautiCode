import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
const read = name => fs.readFile(new URL("../src/renderer/" + name, import.meta.url), "utf8");
const lifecycleSource = await read("runtime-video-lifecycle.js");
const elementSource = await read("runtime-video-element.js");
const controlsSource = await read("runtime-controls.js");
test("media replacement preserves the tone through the existing public accessor", () => {
    const create = vm.runInNewContext(controlsSource, {});
    const controls = create({
        root: {getAttribute:()=>null},
        previous: {isBackgroundTone:()=>"light",isMuted:()=>false,isFishMode:()=>true},
        normalizedVideo:null,isCurrent:()=>true,hasBackgroundMedia:()=>true,
        getStage:()=>null,getVideo:()=>null,setAttrs(){},
    });
    assert.equal(controls.tone,"light");
    assert.equal(controls.muted,false);
    assert.equal(controls.fish,true);
});
test("a permanent decode error after handoff completes cannot stay pending forever", () => {
    let handoff = { ready: true }, video;
    class Video extends EventTarget {
        constructor() { super(); this.style = {}; this.src = "blob:synthetic"; this.currentTime = 0; }
        setAttribute() { }
        removeAttribute() { }
    }
    const context = { document: { createElement: () => new Video(), addEventListener() { }, removeEventListener() { } }, setTimeout, clearTimeout };
    const controls = { applyPendingStartAt() { }, applyMuteState() { } };
    const lifecycle = vm.runInNewContext(lifecycleSource, context)({
        isCurrent: () => true, isDocHidden: () => false, getVideo: () => video,
        hasHandoff: () => Boolean(handoff?.ready), onChange() { }, onReady() { handoff = null; },
        controls, toChineseMediaError: () => "decode failure",
    });
    const bind = vm.runInNewContext(elementSource, context);
    const stage = { children: [], appendChild(v) { video = v; } };
    const binding = bind({ stage, handoff, getHandoff: () => handoff, isCurrent: () => true,
        isDocHidden: () => false, lifecycle, controls, revoke() { } });
    lifecycle.markReady();
    video.error = { code: 3 };
    video.dispatchEvent(new Event("error"));
    assert.equal(lifecycle.failed, true);
    assert.equal(lifecycle.error.message, "decode failure");
    lifecycle.dispose();
    binding.dispose();
});
