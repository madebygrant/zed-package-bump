use std::fs;
use zed_extension_api::{self as zed, Result};

/* the esbuild bundle is embedded at wasm compile time (build it first:
   `pnpm --dir lsp build`) and materialized into the extension's work
   dir on launch — the wasm cwd is the work dir, not the extension dir */
const SERVER_JS: &str = include_str!("../server/server.js");
const SERVER_FILENAME: &str = "package-bump-lsp.js";

struct PackageBumpExtension;

impl zed::Extension for PackageBumpExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(SERVER_FILENAME);

        let stale = fs::read_to_string(&server_path)
            .map(|existing| existing != SERVER_JS)
            .unwrap_or(true);
        if stale {
            /* write via temp + rename so a crash mid-write can't leave a
               torn file that still parses as truncated JS */
            let tmp_path = server_path.with_extension("js.tmp");
            fs::write(&tmp_path, SERVER_JS).map_err(|e| e.to_string())?;
            fs::rename(&tmp_path, &server_path).map_err(|e| e.to_string())?;
        }

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                server_path.to_string_lossy().to_string(),
                "--stdio".to_string(),
            ],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        let settings =
            zed::settings::LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        Ok(settings.initialization_options)
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        let settings =
            zed::settings::LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        Ok(settings.settings)
    }
}

zed::register_extension!(PackageBumpExtension);
