use zem_addon_sdk::Pane;

use crate::version_control::handlers::*;
use crate::wrap;

/// Add all query handlers to the pane.
pub fn register(pane: Pane) -> Pane {
    pane.query("get_status", wrap!(handle_get_status))
        .query("get_log", wrap!(handle_get_log))
        .query("get_diff", wrap!(handle_get_diff))
        .query("get_diff_stats", wrap!(handle_get_diff_stats))
        .query("get_file_contents", wrap!(handle_get_file_contents))
        .query("get_conflict_file", wrap!(handle_get_conflict_file))
        .query("list_branches", wrap!(handle_list_branches))
        .query("get_stashes", wrap!(handle_get_stashes))
        .query("github_status", wrap!(handle_github_status))
        .query("github_pulls", wrap!(handle_github_pulls))
        .query("github_issues", wrap!(handle_github_issues))
        .query("github_pull_details", wrap!(handle_github_pull_details))
}
