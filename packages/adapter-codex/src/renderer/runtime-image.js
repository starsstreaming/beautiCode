/* Private state belongs to this module; callers receive operations and read-only views. */
(({ isCurrent, ensureStage, setAttrs, dataImageUrl, remoteImageUrl, sources }) => {
    const waiter = createMediaWaiter({ isCurrent });
    const errorHandlers = new Map();
    const IMAGE_INPUT_ID = "beauticode-image-input";
    const { revoke, fetchAsObjectUrl } = sources;
    let imageFailed = false, imageObjectUrl = null, imgEl = null, resolvedPoster = dataImageUrl;
    const teardownImageBlob = () => {
        waiter.dispose();
        for (const [img, handler] of errorHandlers)
            img.removeEventListener("error", handler);
        errorHandlers.clear();
        if (imageObjectUrl)
            revoke(imageObjectUrl);
        imageObjectUrl = null;
    };
    const resolvePoster = async () => {
        if (dataImageUrl) {
            resolvedPoster = dataImageUrl;
            imageFailed = false;
            return resolvedPoster;
        }
        if (remoteImageUrl) {
            try {
                let token = null;
                try {
                    token = new URL(remoteImageUrl, "http://127.0.0.1").searchParams.get("t");
                }
                catch (_) { }
                const obj = await fetchAsObjectUrl(remoteImageUrl, token);
                if (!isCurrent()) {
                    revoke(obj);
                    return null;
                }
                if (obj.startsWith("blob:"))
                    imageObjectUrl = obj;
                resolvedPoster = obj;
                imageFailed = false;
                return resolvedPoster;
            }
            catch (_) {
                imageFailed = true;
            }
        }
        resolvedPoster = null;
        return null;
    };
    const createImageInput = () => {
        let input = document.getElementById(IMAGE_INPUT_ID);
        if (input)
            return input;
        input = document.createElement("input");
        input.type = "file";
        input.id = IMAGE_INPUT_ID;
        input.accept = "image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.png,.webp,.avif";
        input.tabIndex = -1;
        input.setAttribute("aria-hidden", "true");
        Object.assign(input.style, {
            position: "fixed",
            width: "1px",
            height: "1px",
            opacity: "0",
            pointerEvents: "none",
        });
        (document.body || document.documentElement).appendChild(input);
        return input;
    };
    const doAttachImageFile = async () => {
        if (!isCurrent())
            return false;
        const input = document.getElementById(IMAGE_INPUT_ID);
        const file = input && input.files && input.files[0] ? input.files[0] : null;
        if (!file)
            return false;
        try {
            const objectUrl = URL.createObjectURL(file);
            if (imageObjectUrl && imageObjectUrl !== objectUrl)
                revoke(imageObjectUrl);
            imageObjectUrl = objectUrl;
            resolvedPoster = objectUrl;
            imageFailed = false;
            const stage = ensureStage();
            const img = ensurePosterImg(stage);
            const ready = await waitForImageReady(img);
            if (!isCurrent())
                return false;
            imageFailed = !ready;
            setAttrs();
            return Boolean(!imageFailed && img.getAttribute("src"));
        }
        catch (_) {
            imageFailed = true;
            setAttrs();
            return false;
        }
    };
    const ensurePosterImg = (stage) => {
        let img = stage.querySelector("img");
        if (!img) {
            img = document.createElement("img");
            img.alt = "";
            img.draggable = false;
            img.referrerPolicy = "no-referrer";
            stage.insertBefore(img, stage.firstChild);
        }
        if (!errorHandlers.has(img)) {
            const onError = () => { if (isCurrent()) {
                imageFailed = true;
                setAttrs();
            } };
            img.addEventListener("error", onError);
            errorHandlers.set(img, onError);
        }
        if (resolvedPoster && img.getAttribute("src") !== resolvedPoster) {
            img.src = resolvedPoster;
        }
        imgEl = img;
        return img;
    };
    const waitForImageReady = img => waiter.wait(img, ["load"], () => Boolean(img.complete && img.naturalWidth > 0));
    return { resolvePoster, ensurePosterImg, waitForImageReady, createImageInput, attach: doAttachImageFile, dispose: teardownImageBlob, reset() { imageFailed = false; }, fail() { imageFailed = true; }, clear() { teardownImageBlob(); resolvedPoster = null; imgEl = null; }, get failed() { return imageFailed; }, get element() { return imgEl; }, get poster() { return resolvedPoster; } };
})
