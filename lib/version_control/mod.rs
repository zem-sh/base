pub mod actions;
mod git;
mod github;
mod handlers;
pub mod pane;
mod status;
mod types;
mod wrap;

use zem_addon_sdk::AddonContext;

use status::{set_idle_status, update_status_bar};

fn cwd_and_workspace(payload: &serde_json::Value) -> (&str, i32) {
    let cwd = payload.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let workspace_id = payload
        .get("workspace_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    (cwd, workspace_id)
}

/// `cwd_changed` handler contribution of the version-control addon.
pub async fn on_cwd_changed(payload: &serde_json::Value, ctx: &AddonContext) {
    let (cwd, workspace_id) = cwd_and_workspace(payload);
    if !cwd.is_empty() {
        update_status_bar(ctx, cwd, workspace_id).await;
    } else {
        set_idle_status(ctx, workspace_id).await;
    }
}

/// `file_changed` handler contribution of the version-control addon.
pub async fn on_file_changed(payload: &serde_json::Value, ctx: &AddonContext) {
    let (cwd, workspace_id) = cwd_and_workspace(payload);
    if !cwd.is_empty() {
        update_status_bar(ctx, cwd, workspace_id).await;
    }
}

/// `project_cwd_changed` handler contribution of the version-control addon.
pub async fn on_project_cwd_changed(payload: &serde_json::Value, ctx: &AddonContext) {
    let (cwd, workspace_id) = cwd_and_workspace(payload);
    if !cwd.is_empty() {
        update_status_bar(ctx, cwd, workspace_id).await;
    } else {
        set_idle_status(ctx, workspace_id).await;
    }
}

/// Startup contribution of the version-control addon.
pub async fn on_startup(ctx: &AddonContext) {
    set_idle_status(ctx, 0).await;
}
