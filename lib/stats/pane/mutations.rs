use std::sync::Arc;

use serde_json::json;
use zem_addon_sdk::Pane;

use crate::stats::stats;

/// Add all mutation handlers to the pane.
pub fn register(pane: Pane, state: Arc<stats::State>) -> Pane {
    let _ = state;

    pane.mutation("kill_process", move |req, _ctx| {
        let pid = req.payload["pid"].as_u64().unwrap_or(0) as u32;
        let force = req.payload["force"].as_bool().unwrap_or(false);
        async move {
            if pid == 0 {
                return Ok(json!({ "success": false, "error": "pid is required" }));
            }
            Ok(crate::stats::process::kill_process(pid, force).await)
        }
    })
}
