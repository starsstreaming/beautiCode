# beauticode-desktop

Windows-only aggregate test package for the beautiCode desktop hosts.

```text
beauticode-desktop dsh install|status|uninstall
beauticode-desktop codex install|status|uninstall
beauticode-desktop workbuddy install|status|uninstall
beauticode-desktop cursor install|status|uninstall
beauticode-desktop doubao install|status|uninstall
```

`status` is read-only. The package carries its own compiled adapters and
host runners; it does not require the beautiCode source repository or private
workspace packages at runtime.
