/// Generate the boilerplate closure that extracts `cwd`, `payload`, and
/// `pane_id` from a `OperationRequest` and forwards them to a typed handler,
/// mapping the handler's `String` error into a coded `AddonError`.
///
/// Usage: `.query("name", wrap!(handle_get_status))`
#[macro_export]
macro_rules! wrap {
    ($handler:path) => {
        |req, ctx| {
            let cwd = req.cwd.to_string();
            let payload = req.payload.clone();
            let pid = req.pane_id;
            let ctx = ctx.clone();
            async move {
                $handler(cwd, payload, pid, &ctx)
                    .await
                    .map_err(|e: String| zem_addon_sdk::AddonError::internal(e))
            }
        }
    };
}
