use zem_addon_sdk::Action;

/// Branch selector — clicking opens a branch picker.
pub fn git_branch() -> Action {
    Action::new("git_branch")
        .location("statusbar-right")
        .title("Git Branch")
        .icon("nerd:code-branch")
        .description("Current git branch name")
        .on_execute(|req, ctx| {
            let cwd = req.cwd.to_string();
            let payload = req.payload.clone();
            let ctx = ctx.clone();
            async move {
                crate::version_control::handlers::handle_checkout_branch_from_status(cwd, payload, 0, &ctx)
                    .await
                    .map_err(|e| zem_addon_sdk::AddonError::internal(e))?;
                Ok(zem_addon_sdk::ActionExecuteResponse::default())
            }
        })
}

/// Change counter — clicking opens the version-control pane.
pub fn git_changes() -> Action {
    Action::new("git_changes")
        .location("statusbar-right")
        .read_only()
        .title("Git Changes")
        .icon("nerd:pencil")
        .description("Number of uncommitted changes")
        .on_execute(|_, _| async {
            Ok(zem_addon_sdk::ActionExecuteResponse::open_pane(
                "version-control",
            ).focus_existing())
        })
}

/// Ahead/behind indicator — read-only, no handler needed.
pub fn git_remote_status() -> Action {
    Action::new("git_remote_status")
        .location("statusbar-right")
        .title("Remote Status")
        .icon("nerd:cloud-upload-alt")
        .description("Ahead/behind vs upstream branch")
}
