pub mod actions;
pub mod pane;
mod storage;

use zem_addon_sdk::AddonContext;

async fn refresh_list_from_event(payload: &serde_json::Value, ctx: &AddonContext) {
    let workspace_id = payload
        .get("workspace_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    let project_id = payload.get("project_id").and_then(|v| v.as_i64()).unwrap_or(0);
    actions::refresh_list(ctx, workspace_id, project_id).await;
}

/// `cwd_changed` handler contribution of the notes addon.
pub async fn on_cwd_changed(payload: &serde_json::Value, ctx: &AddonContext) {
    refresh_list_from_event(payload, ctx).await;
}

/// `project_cwd_changed` handler contribution of the notes addon.
pub async fn on_project_cwd_changed(payload: &serde_json::Value, ctx: &AddonContext) {
    refresh_list_from_event(payload, ctx).await;
}
