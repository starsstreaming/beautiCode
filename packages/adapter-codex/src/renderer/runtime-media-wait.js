/* Images and video attachments both need a cancellable native-event wait. */
(({ isCurrent }) => {
    const pending = new Set();
    const wait = (element, events, ready, timeoutMs = 2500) => new Promise(resolve => {
        if (!isCurrent() || !element) {
            resolve(false);
            return;
        }
        if (ready()) {
            resolve(true);
            return;
        }
        let timer, done = false;
        const finish = value => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            for (const event of events)
                element.removeEventListener(event, onReady);
            element.removeEventListener("error", onError);
            pending.delete(cancel);
            resolve(Boolean(value && isCurrent()));
        };
        const onReady = () => finish(ready());
        const onError = () => finish(false);
        const cancel = () => finish(false);
        pending.add(cancel);
        for (const event of events)
            element.addEventListener(event, onReady);
        element.addEventListener("error", onError);
        timer = setTimeout(() => finish(ready()), timeoutMs);
    });
    return { wait, dispose() { for (const cancel of [...pending])
            cancel(); } };
})
