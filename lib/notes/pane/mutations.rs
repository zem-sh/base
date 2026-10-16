use serde_json::json;
use zem_addon_sdk::Pane;

use crate::notes::storage;

pub fn register(pane: Pane) -> Pane {
    pane.mutation("save_note", |req, ctx| {
        let payload = req.payload.clone();
        let cwd = req.cwd.to_string();
        let ctx = ctx.clone();
        async move {
            let storage_kind = payload
                .get("storage")
                .and_then(|v| v.as_str())
                .unwrap_or("database");
            if storage_kind == "disk" {
                storage::save_disk(&ctx, &payload, &storage::directory(&payload, &cwd))
                    .await
                    .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))
            } else {
                let result = storage::save_db(&ctx, &payload)
                    .await
                    .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))?;
                crate::notes::actions::refresh_list(&ctx, storage::workspace_id(&payload), storage::project_id(&payload)).await;
                Ok(result)
            }
        }
    })
    .mutation("delete_note", |req, ctx| {
        let payload = req.payload.clone();
        let cwd = req.cwd.to_string();
        let ctx = ctx.clone();
        async move {
            let storage_kind = payload
                .get("storage")
                .and_then(|v| v.as_str())
                .unwrap_or("database");
            if storage_kind == "disk" {
                storage::delete_disk(&ctx, &payload, &storage::directory(&payload, &cwd))
                    .await
                    .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))
            } else {
                let result = storage::delete_db(&ctx, &payload)
                    .await
                    .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))?;
                crate::notes::actions::refresh_list(&ctx, storage::workspace_id(&payload), storage::project_id(&payload)).await;
                Ok(result)
            }
        }
    })
    .mutation("rename_note", |req, ctx| {
        let payload = req.payload.clone();
        let cwd = req.cwd.to_string();
        let ctx = ctx.clone();
        async move {
            let storage_kind = payload
                .get("storage")
                .and_then(|v| v.as_str())
                .unwrap_or("database");
            if storage_kind == "disk" {
                storage::rename_disk(&ctx, &payload, &storage::directory(&payload, &cwd))
                    .await
                    .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))
            } else {
                let result = storage::rename_db(&ctx, &payload)
                    .await
                    .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))?;
                crate::notes::actions::refresh_list(&ctx, storage::workspace_id(&payload), storage::project_id(&payload)).await;
                Ok(result)
            }
        }
    })
    .mutation("save_state", |req, ctx| {
        let payload = req.payload.clone();
        let pane_id = req.pane_id;
        let ctx = ctx.clone();
        async move {
            if pane_id <= 0 {
                return Err(zem_addon_sdk::AddonError::invalid_payload(
                    "pane_id is required",
                ));
            }
            let state = payload.get("state").cloned().unwrap_or_else(|| json!({}));
            let incoming_note_id = state
                .get("noteId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let incoming_note_name = state
                .get("noteName")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let mut extra = ctx
                .get_extra_json(pane_id)
                .await
                .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))?;

            // When the note is closed (noteId empty), preserve the last
            // meaningful note name in extra so the command palette can
            // discover the pane by its recently-opened notes.  The temp_name
            // (pane header) is still cleared so the pane reads "Markdown
            // Notes" when nothing is open.
            let effective_name = if incoming_note_id.is_empty() {
                let existing_name = extra
                    .get("notes")
                    .and_then(|n| n.get("noteName"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !existing_name.is_empty() && existing_name != "Untitled" {
                    existing_name.to_string()
                } else {
                    incoming_note_name.to_string()
                }
            } else {
                incoming_note_name.to_string()
            };

            let stored_state = if incoming_note_id.is_empty() && !effective_name.is_empty() {
                let mut s = state.clone();
                if let Some(obj) = s.as_object_mut() {
                    obj.insert("noteName".to_string(), json!(effective_name));
                }
                s
            } else {
                state.clone()
            };

            if let Some(object) = extra.as_object_mut() {
                object.insert("notes".to_string(), stored_state);
            } else {
                extra = json!({ "notes": stored_state });
            }
            ctx.set_extra(pane_id, &extra)
                .await
                .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))?;

            // Notes owns this collection and membership is exactly whether a
            // note id is open in this pane.
            let has_open_note = !incoming_note_id.is_empty();
            ctx.set_pane_collection(pane_id, "Notes", has_open_note)
                .await
                .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))?;

            // Drive the pane's dynamic display name from the open note (the
            // user-set manual name always wins on the host). Cleared when no
            // note is open (welcome/compose state), so the pane falls back to
            // its kind name.
            let note_name: &str = if incoming_note_id.is_empty() {
                ""
            } else {
                incoming_note_name
            };
            ctx.set_temp_name(pane_id, note_name)
                .await
                .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))?;

            if let Some(directory) = state
                .get("directory")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                if state.get("storage").and_then(|v| v.as_str()) == Some("disk") {
                    ctx.validate_path_access(
                        directory,
                        payload
                            .get("user_uuid")
                            .and_then(|v| v.as_str())
                            .unwrap_or(""),
                    )
                    .await
                    .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))?;
                    ctx.set_cwd(pane_id, directory)
                        .await
                        .map_err(|e| zem_addon_sdk::AddonError::internal(e.to_string()))?;
                }
            }
            Ok(json!({ "success": true }))
        }
    })
}
