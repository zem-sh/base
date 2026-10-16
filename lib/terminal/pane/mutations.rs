use zem_addon_sdk::Pane;

use crate::terminal::session::SessionManager;

/// Add all mutation handlers to the pane.
pub fn register(pane: Pane, mgr: SessionManager) -> Pane {
    let mgr1 = mgr.clone();
    let mgr2 = mgr;

    pane.on_input({
        let mgr = mgr2.clone();
        move |req, _ctx| {
            let mgr = mgr.clone();
            let pane_id = req.pane_id;
            let payload = req.raw.to_vec();
            async move {
                mgr.write_input(pane_id, &payload)
                    .await
                    .map_err(zem_addon_sdk::AddonError::internal)
            }
        }
    })
    .mutation("kill", {
        let mgr = mgr1;
        move |req, _ctx| {
            let mgr = mgr.clone();
            let id = req
                .payload
                .get("id")
                .and_then(|v| v.as_i64())
                .unwrap_or(req.pane_id as i64) as i32;
            async move {
                mgr.destroy(id, "disconnected").await;
                Ok(serde_json::json!({ "ok": true }))
            }
        }
    })
}
