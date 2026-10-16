use serde_json::json;
use zem_addon_sdk::Pane;

use crate::notes::storage;

pub fn register(pane: Pane) -> Pane {
    pane.query("context", |req, _ctx| {
        let cwd = req.cwd.to_string();
        let pane_id = req.pane_id;
        // The host injects workspace_id/project_id into every pane operation
        // payload; echo them back so the pane knows its scope context.
        let workspace_id = req
            .payload
            .get("workspace_id")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let project_id = req
            .payload
            .get("project_id")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        async move {
            Ok(json!({ "cwd": cwd, "pane_id": pane_id, "workspace_id": workspace_id, "project_id": project_id }))
        }
    })
    .query("list_notes", |req, ctx| {
        let payload = req.payload.clone();
        let cwd = req.cwd.to_string();
        let ctx = ctx.clone();
        async move {
            let storage_kind = payload
                .get("storage")
                .and_then(|v| v.as_str())
                .unwrap_or("database");
            if storage_kind == "disk" {
                let directory = storage::directory(&payload, &cwd);
                Ok(json!({ "notes": storage::list_disk(&ctx, &payload, &directory).await.map_err(zem_addon_sdk::AddonError::internal)? }))
            } else {
                Ok(json!({ "notes": storage::list_db(&ctx, &payload).await.map_err(zem_addon_sdk::AddonError::internal)? }))
            }
        }
    })
    .query("read_note", |req, ctx| {
        let payload = req.payload.clone();
        let cwd = req.cwd.to_string();
        let ctx = ctx.clone();
        async move {
            let storage_kind = payload
                .get("storage")
                .and_then(|v| v.as_str())
                .unwrap_or("database");
            if storage_kind == "disk" {
                storage::read_disk(&ctx, &payload, &storage::directory(&payload, &cwd)).await.map_err(zem_addon_sdk::AddonError::internal)
            } else {
                storage::read_db(&ctx, &payload).await.map_err(zem_addon_sdk::AddonError::internal)
            }
        }
    })
}
