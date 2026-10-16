use std::sync::Arc;

use serde_json::json;
use zem_addon_sdk::Pane;

use crate::stats::stats;

/// Add all query handlers to the pane.
pub fn register(pane: Pane, state: Arc<stats::State>) -> Pane {
    let s1 = state.clone();
    let s2 = state.clone();
    let s3 = state.clone();

    pane.query("get_stats", move |_req, _ctx| {
        let state = s1.clone();
        async move { Ok(state.get_stats().await) }
    })
    .query("get_processes", move |_req, _ctx| {
        let state = s2.clone();
        async move { Ok(crate::stats::process::stats(state.system.clone()).await) }
    })
    .query("process_details", move |req, _ctx| {
        let pid = req.payload["pid"].as_u64().unwrap_or(0) as u32;
        let state = s3.clone();
        async move {
            if pid == 0 {
                return Ok(json!({ "success": false, "error": "pid is required" }));
            }
            Ok(crate::stats::process::process_details(pid, state.system.clone()).await)
        }
    })
    .query("status", |_req, _ctx| async {
        Ok(json!({ "success": true, "data": { "status": "ok" } }))
    })
}
