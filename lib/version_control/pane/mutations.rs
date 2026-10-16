use zem_addon_sdk::Pane;

use crate::version_control::handlers::*;
use crate::wrap;

/// Add all mutation handlers to the pane.
pub fn register(pane: Pane) -> Pane {
    pane.mutation("stage_file", wrap!(handle_stage_file))
        .mutation("unstage_file", wrap!(handle_unstage_file))
        .mutation("stage_all", wrap!(handle_stage_all))
        .mutation("unstage_all", wrap!(handle_unstage_all))
        .mutation("discard_file", wrap!(handle_discard_file))
        .mutation("commit", wrap!(handle_commit))
        .mutation("resolve_conflict", wrap!(handle_resolve_conflict))
        .mutation("create_branch", wrap!(handle_create_branch))
        .mutation("checkout_branch", wrap!(handle_checkout_branch))
        .mutation("delete_branch", wrap!(handle_delete_branch))
        .mutation("push", wrap!(handle_push))
        .mutation("pull", wrap!(handle_pull))
        .mutation("fetch", wrap!(handle_fetch))
        .mutation("create_stash", wrap!(handle_create_stash))
        .mutation("pop_stash", wrap!(handle_pop_stash))
        .mutation("drop_stash", wrap!(handle_drop_stash))
        .mutation("github_create_pr", wrap!(handle_github_create_pr))
        .mutation("github_update_pr", wrap!(handle_github_update_pr))
        .mutation("github_merge_pr", wrap!(handle_github_merge_pr))
        .mutation("github_checkout_pr", wrap!(handle_github_checkout_pr))
        .mutation("github_set_token", wrap!(handle_github_set_token))
        .mutation("github_clear_token", wrap!(handle_github_clear_token))
}
