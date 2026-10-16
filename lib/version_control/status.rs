use serde_json::json;

use crate::version_control::git;

async fn set_action_simple(
    ctx: &zem_addon_sdk::AddonContext,
    id: &str,
    workspace_id: i32,
    view: &[serde_json::Value],
) {
    let _ = ctx
        .set_action(id, workspace_id, &json!({"view": view}))
        .await;
}

async fn set_action_clickable(
    ctx: &zem_addon_sdk::AddonContext,
    id: &str,
    workspace_id: i32,
    view: &[serde_json::Value],
) {
    let _ = ctx
        .set_action(
            id,
            workspace_id,
            &json!({
                "view": view,
                "action": {"type": "click", "command": "git_changes"}
            }),
        )
        .await;
}

pub async fn set_idle_status(ctx: &zem_addon_sdk::AddonContext, workspace_id: i32) {
    set_status_placeholder(ctx, workspace_id, "idle", "").await;
}

async fn set_status_placeholder(
    ctx: &zem_addon_sdk::AddonContext,
    workspace_id: i32,
    branch_text: &str,
    remote_text: &str,
) {
    set_action_clickable(
        ctx,
        "git_branch",
        workspace_id,
        &[
            json!({"type": "icon", "value": "nerd:code-branch", "color": "#6B7280"}),
            json!({"type": "text", "value": branch_text, "color": "#6B7280"}),
        ],
    )
    .await;
    set_action_clickable(
        ctx,
        "git_changes",
        workspace_id,
        &[json!({"type": "text", "value": "", "color": "#6B7280"})],
    )
    .await;
    if remote_text.is_empty() {
        set_action_simple(
            ctx,
            "git_remote_status",
            workspace_id,
            &[json!({"type": "text", "value": "", "color": "#6B7280"})],
        )
        .await;
    } else {
        set_action_simple(
            ctx,
            "git_remote_status",
            workspace_id,
            &[
                json!({"type": "icon", "value": "nerd:cloud", "color": "#6B7280"}),
                json!({"type": "text", "value": remote_text, "color": "#6B7280"}),
            ],
        )
        .await;
    }
}

pub async fn update_status_bar(ctx: &zem_addon_sdk::AddonContext, cwd: &str, workspace_id: i32) {
    if cwd.is_empty() {
        return;
    }

    let branches = git::git_branches(cwd.to_string()).unwrap_or_default();

    match git::git_status(cwd.to_string()) {
        Ok(status) => {
            let staged = status.files.iter().filter(|f| f.staged).count();
            let modified = status
                .files
                .iter()
                .filter(|f| !f.staged && matches!(f.status, git::FileStatus::Modified))
                .count();
            let untracked = status
                .files
                .iter()
                .filter(|f| !f.staged && matches!(f.status, git::FileStatus::Untracked))
                .count();

            let branch_options: Vec<serde_json::Value> = branches
                .iter()
                .map(|b| {
                    json!({
                        "value": b.name,
                        "label": b.name
                    })
                })
                .collect();

            let _ = ctx
                .set_action(
                    "git_branch",
                    workspace_id,
                    &json!({
                        "view": [
                            {"type": "icon", "value": "nerd:code-branch"},
                            {"type": "text", "value": &status.branch}
                        ],
                        "action": {
                            "type": "select",
                            "command": "git_branch",
                            "current_value": &status.branch,
                            "options": branch_options
                        }
                    }),
                )
                .await;

            let mut changes_view: Vec<serde_json::Value> = Vec::new();
            if staged > 0 {
                changes_view
                    .push(json!({"type": "icon", "value": "nerd:plus", "color": "#10B981"}));
                changes_view
                    .push(json!({"type": "text", "value": staged.to_string(), "color": "#10B981"}));
            }
            if modified > 0 {
                if !changes_view.is_empty() {
                    changes_view.push(json!({"type": "text", "value": " ", "color": "#F59E0B"}));
                }
                changes_view
                    .push(json!({"type": "icon", "value": "nerd:pencil", "color": "#F59E0B"}));
                changes_view.push(
                    json!({"type": "text", "value": modified.to_string(), "color": "#F59E0B"}),
                );
            }
            if untracked > 0 {
                if !changes_view.is_empty() {
                    changes_view.push(json!({"type": "text", "value": " ", "color": "#6B7280"}));
                }
                changes_view
                    .push(json!({"type": "icon", "value": "nerd:question", "color": "#6B7280"}));
                changes_view.push(
                    json!({"type": "text", "value": untracked.to_string(), "color": "#6B7280"}),
                );
            }
            if staged == 0 && modified == 0 && untracked == 0 {
                changes_view
                    .push(json!({"type": "icon", "value": "nerd:check", "color": "#10B981"}));
                changes_view.push(json!({"type": "text", "value": "clean", "color": "#10B981"}));
            }

            set_action_clickable(ctx, "git_changes", workspace_id, &changes_view).await;

            // Remote status: ahead/behind
            let mut remote_view: Vec<serde_json::Value> = Vec::new();
            if status.ahead > 0 {
                remote_view.push(
                    json!({"type": "icon", "value": "nerd:cloud-upload-alt", "color": "#F59E0B"}),
                );
                remote_view.push(json!({"type": "text", "value": format!("↑{}", status.ahead), "color": "#F59E0B"}));
            }
            if status.behind > 0 {
                if !remote_view.is_empty() {
                    remote_view.push(json!({"type": "text", "value": " ", "color": "#6B7280"}));
                }
                remote_view.push(
                    json!({"type": "icon", "value": "nerd:cloud-download-alt", "color": "#3B82F6"}),
                );
                remote_view.push(json!({"type": "text", "value": format!("↓{}", status.behind), "color": "#3B82F6"}));
            }
            if !status.has_upstream {
                remote_view
                    .push(json!({"type": "icon", "value": "nerd:cloud", "color": "#6B7280"}));
                remote_view
                    .push(json!({"type": "text", "value": "no upstream", "color": "#6B7280"}));
            }
            if remote_view.is_empty() {
                remote_view
                    .push(json!({"type": "icon", "value": "nerd:cloud", "color": "#6B7280"}));
                remote_view.push(json!({"type": "text", "value": "synced", "color": "#6B7280"}));
            }

            set_action_clickable(ctx, "git_remote_status", workspace_id, &remote_view).await;
        }
        Err(_) => {
            set_status_placeholder(ctx, workspace_id, "no repo", "no repo").await;
        }
    }
}
