use serde_json::json;

use crate::version_control::git;
use crate::version_control::github;
use crate::version_control::status;
use crate::version_control::types::*;

pub async fn handle_get_status(
    cwd: String,
    _payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let status = git::git_status(cwd)?;
    serde_json::to_value(status).map_err(|e| e.to_string())
}

pub async fn handle_stage_file(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: FilePayload = parse_payload(&payload)?;
    git::git_add(cwd, p.file)?;
    Ok(json!({"success": true}))
}

pub async fn handle_unstage_file(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: FilePayload = parse_payload(&payload)?;
    git::git_reset(cwd, p.file)?;
    Ok(json!({"success": true}))
}

pub async fn handle_stage_all(
    cwd: String,
    _payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    git::git_add_all(cwd)?;
    Ok(json!({"success": true}))
}

pub async fn handle_unstage_all(
    cwd: String,
    _payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    git::git_reset_all(cwd)?;
    Ok(json!({"success": true}))
}

pub async fn handle_discard_file(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: FilePayload = parse_payload(&payload)?;
    git::git_discard_file_changes(cwd, p.file)?;
    Ok(json!({"success": true}))
}

pub async fn handle_commit(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: CommitPayload = parse_payload(&payload)?;
    git::git_commit(cwd, p.message)?;
    Ok(json!({"success": true}))
}

pub async fn handle_get_log(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: LogPayload = parse_payload(&payload)?;
    let log = git::git_log(cwd, p.limit, p.skip)?;
    serde_json::to_value(log).map_err(|e| e.to_string())
}

pub async fn handle_get_diff(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: DiffPayload = parse_payload(&payload)?;
    let diff = git::git_diff_file(cwd, p.file, p.staged)?;
    serde_json::to_value(diff).map_err(|e| e.to_string())
}

pub async fn handle_get_diff_stats(
    cwd: String,
    _payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let stats = git::git_status_diff_stats(cwd)?;
    serde_json::to_value(stats).map_err(|e| e.to_string())
}

pub async fn handle_get_file_contents(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: DiffPayload = parse_payload(&payload)?;
    let contents = git::git_file_contents(cwd, p.file, p.staged)?;
    serde_json::to_value(contents).map_err(|e| e.to_string())
}

pub async fn handle_get_conflict_file(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: FilePayload = parse_payload(&payload)?;
    let file_path = p.file.clone();
    let content = git::git_conflict_file_content(cwd, p.file)?;
    Ok(serde_json::json!({
        "filePath": file_path,
        "isConflict": true,
        "content": content,
    }))
}

pub async fn handle_resolve_conflict(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: ResolveConflictPayload = parse_payload(&payload)?;
    git::git_resolve_conflict(cwd, p.file, p.content)?;
    Ok(serde_json::json!({"success": true}))
}

pub async fn handle_create_branch(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: CreateBranchPayload = parse_payload(&payload)?;
    git::git_create_branch(cwd, p.name, p.from)?;
    Ok(json!({"success": true}))
}

pub async fn handle_checkout_branch(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: BranchPayload = parse_payload(&payload)?;
    let result = git::git_checkout(cwd, p.branch)?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn handle_checkout_branch_from_status(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    let branch = payload.get("format").and_then(|v| v.as_str()).unwrap_or("");
    if branch.is_empty() {
        return Err("branch name is required".to_string());
    }

    let result = git::git_checkout(cwd.clone(), branch.to_string())?;
    status::update_status_bar(ctx, &cwd, 0).await;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn handle_delete_branch(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: BranchPayload = parse_payload(&payload)?;
    git::git_delete_branch(cwd, p.branch)?;
    Ok(json!({"success": true}))
}

pub async fn handle_list_branches(
    cwd: String,
    _payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let branches = git::git_branches(cwd)?;
    serde_json::to_value(branches).map_err(|e| e.to_string())
}

pub async fn handle_push(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: RemotePayload = parse_payload(&payload)?;
    let remote = p.remote.unwrap_or_else(|| "origin".to_string());
    git::git_push(cwd, p.branch, remote, p.ssh_passphrase)?;
    Ok(json!({"success": true}))
}

pub async fn handle_pull(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: RemotePayload = parse_payload(&payload)?;
    let remote = p.remote.unwrap_or_else(|| "origin".to_string());
    git::git_pull(cwd, p.branch, remote, p.ssh_passphrase)?;
    Ok(json!({"success": true}))
}

pub async fn handle_fetch(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: RemotePayload = parse_payload(&payload)?;
    git::git_fetch(cwd, p.remote, p.ssh_passphrase)?;
    Ok(json!({"success": true}))
}

pub async fn handle_get_stashes(
    cwd: String,
    _payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let stashes = git::git_get_stashes(cwd)?;
    serde_json::to_value(stashes).map_err(|e| e.to_string())
}

pub async fn handle_create_stash(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: StashPayload = parse_payload(&payload)?;
    git::git_create_stash(cwd, p.message, p.include_untracked, p.files)?;
    Ok(json!({"success": true}))
}

pub async fn handle_pop_stash(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: StashIndexPayload = parse_payload(&payload)?;
    git::git_pop_stash(cwd, Some(p.index))?;
    Ok(json!({"success": true}))
}

pub async fn handle_drop_stash(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    _ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: StashIndexPayload = parse_payload(&payload)?;
    git::git_drop_stash(cwd, p.index)?;
    Ok(json!({"success": true}))
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

pub async fn handle_github_status(
    cwd: String,
    _payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let (owner, repo) = github::repo_from_remote(&cwd)?;
    let mut result = json!({
        "owner": owner,
        "repo": repo,
        "configured": false,
    });
    if let Ok(token) = github::get_github_token(ctx).await {
        match github::github_repo(&owner, &repo, &token) {
            Ok(repo_info) => {
                result["configured"] = json!(true);
                result["repo"] = serde_json::to_value(repo_info).map_err(|e| e.to_string())?;
                if let Ok(user) = github::github_user(&token) {
                    result["user"] = serde_json::to_value(user).map_err(|e| e.to_string())?;
                }
                if let Ok(rate) = github::github_rate_limit(&token) {
                    result["rate"] = serde_json::to_value(rate).map_err(|e| e.to_string())?;
                }
            }
            Err(e) => {
                result["error"] = json!(e);
            }
        }
    }
    Ok(result)
}

pub async fn handle_github_pulls(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: GithubListPayload = parse_payload(&payload)?;
    let state = p.state.unwrap_or_else(|| "open".to_string());
    let token = github::get_github_token(ctx).await?;
    let (owner, repo) = github::repo_from_remote(&cwd)?;
    let pulls = github::github_pulls(&owner, &repo, &token, &state)?;
    serde_json::to_value(pulls).map_err(|e| e.to_string())
}

pub async fn handle_github_issues(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: GithubListPayload = parse_payload(&payload)?;
    let state = p.state.unwrap_or_else(|| "open".to_string());
    let token = github::get_github_token(ctx).await?;
    let (owner, repo) = github::repo_from_remote(&cwd)?;
    let issues = github::github_issues(&owner, &repo, &token, &state)?;
    serde_json::to_value(issues).map_err(|e| e.to_string())
}

pub async fn handle_github_pull_details(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: GithubPrNumberPayload = parse_payload(&payload)?;
    let token = github::get_github_token(ctx).await?;
    let (owner, repo) = github::repo_from_remote(&cwd)?;
    let pr = github::github_pull_details(&owner, &repo, &token, p.number)?;
    let reviews = github::github_pull_reviews(&owner, &repo, &token, p.number).unwrap_or_default();
    serde_json::to_value(json!({
        "pr": pr,
        "reviews": reviews,
    }))
    .map_err(|e| e.to_string())
}

pub async fn handle_github_create_pr(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: GithubCreatePrPayload = parse_payload(&payload)?;
    let token = github::get_github_token(ctx).await?;
    let (owner, repo) = github::repo_from_remote(&cwd)?;

    let head = p.head.unwrap_or_else(|| {
        git::git_status(cwd.clone())
            .map(|s| s.branch)
            .unwrap_or_default()
    });
    if head.is_empty() {
        return Err("could not determine the current branch".to_string());
    }
    let base = p.base.unwrap_or_else(|| {
        github::github_repo(&owner, &repo, &token)
            .map(|r| r.default_branch)
            .unwrap_or_else(|_| "main".to_string())
    });

    let pr = github::github_create_pr(
        &owner,
        &repo,
        &token,
        &p.title,
        &head,
        &base,
        p.body.as_deref(),
        p.draft,
    )?;
    serde_json::to_value(pr).map_err(|e| e.to_string())
}

pub async fn handle_github_update_pr(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: GithubPrStatePayload = parse_payload(&payload)?;
    let token = github::get_github_token(ctx).await?;
    let (owner, repo) = github::repo_from_remote(&cwd)?;
    github::github_update_pr(&owner, &repo, &token, p.number, &p.state)?;
    Ok(json!({"success": true}))
}

pub async fn handle_github_merge_pr(
    cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: GithubMergePayload = parse_payload(&payload)?;
    let token = github::get_github_token(ctx).await?;
    let (owner, repo) = github::repo_from_remote(&cwd)?;
    github::github_merge_pr(&owner, &repo, &token, p.number, p.method.as_deref())?;
    Ok(json!({"success": true}))
}

pub async fn handle_github_checkout_pr(
    cwd: String,
    payload: serde_json::Value,
    pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("no working directory for this project".to_string());
    }
    let p: GithubPrNumberPayload = parse_payload(&payload)?;
    let message = github::github_checkout_pr(&cwd, p.number, None)?;
    let _ = ctx
        .notify(
            pane_id,
            "Checked out PR",
            &format!("PR #{} {}", p.number, message),
            "info",
            true,
            None,
        )
        .await;
    status::update_status_bar(ctx, &cwd, 0).await;
    Ok(json!({"success": true, "message": message}))
}

pub async fn handle_github_set_token(
    _cwd: String,
    payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    let p: GithubTokenPayload = parse_payload(&payload)?;
    if p.token.trim().is_empty() {
        return Err("token cannot be empty".to_string());
    }
    github::save_github_token(ctx, p.token.trim()).await?;
    Ok(json!({"success": true, "configured": true}))
}

pub async fn handle_github_clear_token(
    _cwd: String,
    _payload: serde_json::Value,
    _pane_id: i32,
    ctx: &zem_addon_sdk::AddonContext,
) -> Result<serde_json::Value, String> {
    github::clear_github_token(ctx).await?;
    Ok(json!({"success": true, "configured": false}))
}
