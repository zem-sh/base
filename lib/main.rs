//! Zem base addon.
//!
//! One addon process serving every built-in pane and its server-side behavior:
//! the general status items (time/date/cwd), the terminal PTY backend, the
//! system stats sampler, the git/version-control backend, the file explorer
//! backend and the markdown notes store.
//!
//! Each former standalone addon lives in its own module and contributes its own
//! panes, actions, config fields, collections and event handlers. The SDK keeps
//! only *one* handler per event name and a single `on_startup`, so this file
//! composes the shared events (`cwd_changed`, `project_cwd_changed`) from each
//! module's contribution.

mod explorer;
mod general;
mod notes;
mod stats;
mod terminal;
mod version_control;

use std::sync::Arc;

use zem_addon_sdk::{init, Action, Addon, AddonContext, Event};

/// Canonical manifest id. The host spawns the process with the short key
/// (`base`) via `ADDON_ID`, but events such as `settings_changed` carry this
/// canonical id, so both must be recognised (see `terminal::session`).
pub const ADDON_ID: &str = "sh.zem.base";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ctx = AddonContext::from_env();

    // Terminal session manager owns the PTYs. Settings are loaded in the
    // background: `get_settings` talks to the host's AddonDb socket, which may
    // not be up yet when this addon spawns (the server spawns addons before
    // that socket starts listening). Blocking on it here would trip the
    // server's 5s addon-socket timeout. Settings are re-applied live via the
    // `settings_changed` event either way.
    let terminal_mgr = terminal::session::SessionManager::new(ctx.clone());
    let settings_mgr = terminal_mgr.clone();
    tokio::spawn(async move {
        settings_mgr.load_settings().await;
    });

    let stats_state = Arc::new(stats::stats::State::new());

    let addon = Addon::new()
        .id(ADDON_ID)
        .name("base")
        .version("1.0.0")
        .description("Zem base panes: terminal, explorer, stats, version control, notes and status items")
        .min_zem_version("0.1.0")
        .author("zem")
        // ── Actions ────────────────────────────────────────────────────────
        .action(general::actions::server_time())
        .action(general::actions::server_date())
        .action(general::actions::current_dir())
        .action(version_control::actions::git_branch())
        .action(version_control::actions::git_changes())
        .action(version_control::actions::git_remote_status())
        .action(notes::actions::open_note())
        // Status-bar action listing every pane currently running a coding
        // agent. With no agents the view is empty and the action hides itself.
        .action(
            Action::new("agents")
                .title("Agents")
                .icon("nerd:robot")
                .description("Running coding agents — click to jump to the pane")
                .read_only()
                .location("statusbar-left"),
        )
        // ── Collections ────────────────────────────────────────────────────
        // The Agents collection is not the terminal pane's default: panes join
        // it dynamically while the agent detector finds a coding agent running
        // in the PTY (via the host's `extra.agent` collection rule).
        .collection("agent", "Agents")
        .collection("Explorer", "Explorer")
        .collection("Notes", "Notes")
        // ── Config ─────────────────────────────────────────────────────────
        .config(general::config::time_format_field())
        .config(general::config::date_format_field())
        .config(terminal::config::max_scrollback_size())
        .config(terminal::config::autosave_interval())
        .config(terminal::config::temp_cwd())
        .config(terminal::config::notify_duration())
        .config(terminal::config::notify_success())
        .config(terminal::config::agents_enabled())
        .configs(terminal::config::agent_fields())
        // ── Panes ──────────────────────────────────────────────────────────
        .pane(terminal::pane::terminal_pane(terminal_mgr.clone()))
        .pane(explorer::pane::explorer_pane())
        .pane(general::pane::general_pane())
        .pane(stats::pane::stats_pane(stats_state))
        .pane(version_control::pane::version_control_pane())
        .pane(notes::pane::notes_pane())
        // ── Events ─────────────────────────────────────────────────────────
        // One handler per event name: fan the shared events out to each
        // module that cares about them.
        .event(Event::on(
            "cwd_changed",
            |payload: serde_json::Value, ctx| {
                let ctx = ctx.clone();
                async move {
                    general::on_cwd_changed(&payload, &ctx).await;
                    version_control::on_cwd_changed(&payload, &ctx).await;
                    notes::on_cwd_changed(&payload, &ctx).await;
                    Ok(())
                }
            },
        ))
        .event(Event::on(
            "project_cwd_changed",
            |payload: serde_json::Value, ctx| {
                let ctx = ctx.clone();
                async move {
                    general::on_project_cwd_changed(&payload, &ctx).await;
                    version_control::on_project_cwd_changed(&payload, &ctx).await;
                    notes::on_project_cwd_changed(&payload, &ctx).await;
                    Ok(())
                }
            },
        ))
        // File changes are now driven by the server-side file watcher:
        // re-fetch git status and update the status bar.
        .event(Event::on(
            "file_changed",
            |payload: serde_json::Value, ctx| {
                let ctx = ctx.clone();
                async move {
                    version_control::on_file_changed(&payload, &ctx).await;
                    Ok(())
                }
            },
        ))
        .event(Event::on::<serde_json::Value, _, _>("server_stopped", {
            let mgr = terminal_mgr.clone();
            move |_payload, _ctx| {
                let mgr = mgr.clone();
                async move {
                    mgr.save_all_scrollback().await;
                    Ok(())
                }
            }
        }))
        .event(Event::on::<serde_json::Value, _, _>("settings_changed", {
            let mgr = terminal_mgr.clone();
            move |payload, _ctx| {
                let mgr = mgr.clone();
                async move {
                    mgr.handle_settings_changed(&payload).await;
                    Ok(())
                }
            }
        }))
        // ── Startup ────────────────────────────────────────────────────────
        .on_startup(|ctx| {
            let ctx = ctx.clone();
            async move {
                general::on_startup(&ctx).await;
                version_control::on_startup(&ctx).await;
                Ok(())
            }
        });

    init(addon).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use zem_addon_sdk::manifest_generator;

    /// The merged manifest must declare every pane kind and the shared surface.
    #[tokio::test]
    async fn manifest_declares_all_panes() {
        let ctx = AddonContext::from_env();
        let addon = Addon::new()
            .id(ADDON_ID)
            .pane(terminal::pane::terminal_pane(
                terminal::session::SessionManager::new(ctx),
            ))
            .pane(explorer::pane::explorer_pane())
            .pane(general::pane::general_pane())
            .pane(stats::pane::stats_pane(Arc::new(
                stats::stats::State::new(),
            )))
            .pane(version_control::pane::version_control_pane())
            .pane(notes::pane::notes_pane());
        let toml = manifest_generator(&addon);
        for kind in [
            "terminal",
            "explorer",
            "general",
            "stats",
            "version-control",
            "notes",
        ] {
            assert!(
                toml.contains(&format!("[[pane]]\nname = \"{}\"", kind)),
                "manifest missing pane {}:\n{}",
                kind,
                toml
            );
        }
    }
}
