//! The `general` pane: a minimal health-check query used by the empty pane
//! (and anything else that needs a cheap server reachability probe).

use serde_json::json;
use zem_addon_sdk::Pane;

/// Build the general pane with all queries.
pub fn general_pane() -> Pane {
    Pane::new("general").icon("nerd:server").query("is_ok", |_req, _ctx| async {
        Ok(json!({ "success": true, "data": { "status": "ok" } }))
    })
}
