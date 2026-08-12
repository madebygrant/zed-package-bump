# Package Bump (Zed extension)

Flags outdated npm packages in `package.json` and adds code actions to bump the version numbers. It only edits the file — running `npm install` (or pnpm/yarn) afterwards is up to you.

Open a `package.json` and outdated packages get underlined with a message like:

```
react: 18.3.1 → 19.1.0 (major)
```

The severity matches the size of the update: major = warning, minor = info, patch = hint.

Put the cursor on a package line and press `cmd-.`:

- **Update `<name>` to `<latest>`** — updates that package, keeping your `^` or `~` prefix.
- **Update all N outdated packages** — updates the whole file at once.

Version ranges the extension can't safely rewrite (`workspace:`, `file:`, `*`, `>=`, etc.) are ignored.

## Install

Not on the Zed extension store yet, so it goes in as a dev extension.

You need `rustup` (Zed compiles the wasm part itself) and [pnpm](https://pnpm.io):

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
npm install -g pnpm
```

Clone this repository, then build the language server:

```sh
pnpm --dir lsp install
pnpm --dir lsp build
```

In Zed, press `cmd-shift-x`, click **Install Dev Extension**, and pick the repository folder. Open a `package.json` to check it works.

If a project's `.zed/settings.json` sets a `language_servers` allowlist for JSON, add `"package-bump-lsp"` to it or the server won't start there.

## Settings

`message_style` picks the diagnostic format. Default is `"complete"` (`eslint: 9.39.4 → 10.8.1 (major)`); `"compact"` drops the name and current version, `"level"` is just `major`/`minor`/`patch`.

```jsonc
{
  "lsp": {
    "package-bump-lsp": {
      "settings": { "message_style": "compact" }
    }
  }
}
```

## Development

`src/lib.rs` is a Rust wasm shim. It embeds the bundled server (`server/server.js`) at compile time via `include_str!`, writes it to the extension work dir on launch, and runs it with Zed's managed Node.

The server reads `dist-tags.latest` from the npm registry (abbreviated metadata, cached in memory for 5 minutes). All four dependency sections are scanned, and a package listed in more than one section is flagged in each. Prereleases compare per semver, so `^1.0.0-rc.1` is flagged once `1.0.0` ships.

After editing `lsp/src/`, rebuild with `pnpm --dir lsp build`, then Zed → Extensions → Package Bump → **Rebuild** and reopen the file. LSP logs are under `dev: open language server logs`.

Commit `server/server.js` together with `lsp/src` changes; CI rebuilds the bundle and fails if the committed copy is stale.
