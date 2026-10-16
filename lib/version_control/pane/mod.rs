mod mutations;
mod queries;

use serde_json::json;
use zem_addon_sdk::Pane;

use crate::version_control::status::update_status_bar;

/// Build the version-control pane with all queries, mutations, and lifecycle hooks.
pub fn version_control_pane() -> Pane {
    let pane = Pane::new("version-control").icon("nerd:code-branch");
    let pane = queries::register(pane);
    let pane = mutations::register(pane);

    pane.on_create(|pane_id, cwd, _extra, ctx| {
        let ctx = ctx.clone();
        let cwd = cwd.to_string();
        async move {
            let _ = ctx.set_extra(pane_id, &json!({"cwd": cwd})).await;
            if !cwd.is_empty() {
                update_status_bar(&ctx, &cwd, 0).await;
            }
            Ok(())
        }
    })
}
