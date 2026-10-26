/* Shared across media handoffs, with explicit full-dispose ownership. */
(({ createController, policy }) => {
    const REV = 1;
    const installed = () => window.__BEAUTICODE_GUEST__;
    return {
        setActive(active) {
            let owner = installed();
            if (!active) {
                owner?.controller.setActive(false);
                return;
            }
            if (owner?.rev !== REV) {
                owner?.controller.dispose();
                owner = { rev: REV, controller: createController({ policy }) };
                window.__BEAUTICODE_GUEST__ = owner;
            }
            owner.controller.setActive(true);
        },
        sync() { installed()?.controller.sync(); },
        dispose() {
            installed()?.controller.dispose();
            delete window.__BEAUTICODE_GUEST__;
        },
    };
})
