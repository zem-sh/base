pub mod actions;
pub mod config;
mod constants;
pub mod pane;
mod settings;
mod status;

use zem_addon_sdk::AddonContext;

/// Extract `cwd` + `workspace_id` from either `cwd_changed` or
/// `project_cwd_changed` payloads and re-render the current directory item.
async fn update_cwd_from_event(payload: &serde_json::Value, ctx: &AddonContext) {
    let cwd = payload.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let workspace_id = payload
        .get("workspace_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    status::update_cwd(ctx, cwd, workspace_id).await;
}

/// `cwd_changed` handler contribution of the general (time/date/cwd) addon.
pub async fn on_cwd_changed(payload: &serde_json::Value, ctx: &AddonContext) {
    update_cwd_from_event(payload, ctx).await;
}

/// `project_cwd_changed` handler contribution of the general addon.
pub async fn on_project_cwd_changed(payload: &serde_json::Value, ctx: &AddonContext) {
    update_cwd_from_event(payload, ctx).await;
}

/// Startup contribution of the general addon: seed the cwd item and start the
/// clock refresh task.
pub async fn on_startup(ctx: &AddonContext) {
    status::update_cwd(ctx, "", 0).await;
    status::refresh_all(ctx).await;
    status::spawn_refresh_task(ctx.clone());
}
