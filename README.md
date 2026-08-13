# Package Bump (Zed extension)

Flags outdated npm packages in `package.json` and adds code actions to bump the version numbers. It only edits the file — running `npm install` (or pnpm/yarn) afterwards is up to you.

Open a `package.json` and outdated packages get underlined with a message like:

```
react: 18.3.1 → 18.3.4 (patch) | 18.4.0 (minor) | 19.1.0 (major)
```

Every available step is listed — the newest patch, minor, and major above your current version (only tiers that exist are shown). The severity matches the biggest available update: major = warning, minor = info, patch = hint.

Packages with known security vulnerabilities get a second diagnostic, checked against the npm advisory database (the same data `npm audit` uses):

```
lodash 4.17.20: 5 vulnerabilities (worst: high, fix: 4.18.0) — Command Injection in lodash
```

High and critical advisories show as errors, with a clickable link to the GitHub advisory. `fix:` names the smallest stable, non-deprecated version that clears every advisory, and `cmd-.` offers **Update `<name>` to `<version>` (fixes all N vulnerabilities)** — useful when the safe version is closer than latest. Note this checks the version written in `package.json`, not what's actually installed in `node_modules`.

Put the cursor on a package line and press `cmd-.`:

- **Update `<name>` to `<version>` (patch/minor/major)** — one action per available tier, keeping your `^` or `~` prefix.
- **Update all N outdated packages** — updates the whole file to the newest versions at once.

Deprecated versions get a warning with the maintainer's message:

```
request 2.88.2 is deprecated: request has been deprecated, see https://github.com/request/request/issues/3142
```

Nothing deprecated is ever suggested as a bump target, vulnerability fixes included. If everything above your version is deprecated there's no action to offer, so you get a note instead:

```
request 2.88.2 → 2.88.3 (patch) is deprecated — no update offered
```

Version ranges the extension can't safely rewrite (`workspace:`, `file:`, `*`, `>=`, etc.) are ignored. So are manifests under `node_modules` — npm overwrites those on the next install.

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

`message_style` picks the diagnostic format. Default is `"compact"` (`→ 10.8.1 (major)`); `"complete"` adds the name, current version, and registry update date (`eslint: 9.39.4 → 10.8.1 (major) — updated 2026-08-12`), `"level"` is just `major`/`minor`/`patch`.

Vulnerability messages follow the same setting, marked with `⚠`: compact is `⚠ 5 vulnerabilities (high)`, level is `⚠ high`.

Deprecation messages use `⛔` and shorten the same way: compact is `⛔ deprecated: <message>`, level is `⛔ deprecated`. The no-update note goes to `⛔ 2.88.3 (patch) deprecated — no update offered`, then `⛔ no update`.

`check_vulnerabilities` turns the security check off when set to `false` (default `true`).

```jsonc
{
  "lsp": {
    "package-bump-lsp": {
      "settings": {
        "message_style": "complete",
        "check_vulnerabilities": true
      }
    }
  }
}
```

## Development

`src/lib.rs` is a Rust wasm shim. It embeds the bundled server (`server/server.js`) at compile time via `include_str!`, writes it to the extension work dir on launch, and runs it with Zed's managed Node.

The server reads `dist-tags.latest` from the npm registry (abbreviated metadata, cached in memory for 5 minutes). All four dependency sections are scanned, and a package listed in more than one section is flagged in each. Prereleases compare per semver, so `^1.0.0-rc.1` is flagged once `1.0.0` ships.

Vulnerabilities come from the registry's bulk advisories endpoint (`/-/npm/v1/security/advisories/bulk`), a few POSTs per file, cached for an hour per `name@version`. Suggested fix versions are themselves audited before being shown — a candidate that turns out to carry its own advisories is skipped for the next clean one. The declared version (range prefix stripped) is what gets checked — lockfile-aware checking of actually-installed versions would be a separate feature.

After editing `lsp/src/`, rebuild with `pnpm --dir lsp build`, then Zed → Extensions → Package Bump → **Rebuild** and reopen the file. LSP logs are under `dev: open language server logs`.

Commit `server/server.js` together with `lsp/src` changes; CI rebuilds the bundle and fails if the committed copy is stale.
