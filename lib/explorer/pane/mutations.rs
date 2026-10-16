use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::json;
use zem_addon_sdk::Pane;

use crate::explorer::routes;

/// The effective connection identity used for the pane's dynamic name/icon.
/// Include the saved label so renaming a connection updates an existing
/// explorer pane even when its connection ID stays the same.
fn conn_key(state: &serde_json::Value, label: &str) -> String {
    let t = state.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let id = state
        .get("connectionId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    format!("{}|{}|{}", t, id, label)
}

/// Add all mutation handlers to the pane.
pub fn register(pane: Pane) -> Pane {
    // Per-process memory of the last connection key written to each pane's
    // dynamic name/icon (see `save_state`): updates only happen when the
    // connection actually changed, and a fresh addon process backfills the
    // temp name/icon on the first `save_state` for a pane already on a
    // connection (e.g. right after the addon is updated/redeployed).
    let last_conn: Arc<Mutex<HashMap<i32, String>>> = Arc::new(Mutex::new(HashMap::new()));
    // Serialize each complete save_state mutation. This keeps the persisted
    // explorer state and its dynamic pane identity in the same order, so an
    // older request cannot finish after a newer one and restore stale data.
    let save_state_lock = Arc::new(tokio::sync::Mutex::new(()));
    pane.mutation("write_file", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let user_uuid = p.get("user_uuid").and_then(|v| v.as_str()).unwrap_or("");
            let path = p.get("path").and_then(|v| v.as_str()).unwrap_or("");
            ctx.validate_path_access(path, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            routes::write_file(&p).await?;
            Ok(json!({ "success": true }))
        }
    })
    .mutation("create_directory", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let user_uuid = p.get("user_uuid").and_then(|v| v.as_str()).unwrap_or("");
            let path = p.get("path").and_then(|v| v.as_str()).unwrap_or("");
            ctx.validate_path_access(path, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            routes::create_directory(&p).await?;
            Ok(json!({ "success": true }))
        }
    })
    .mutation("delete_entry", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let user_uuid = p.get("user_uuid").and_then(|v| v.as_str()).unwrap_or("");
            let path = p.get("path").and_then(|v| v.as_str()).unwrap_or("");
            ctx.validate_path_access(path, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            routes::delete_entry(&p).await?;
            Ok(json!({ "success": true }))
        }
    })
    .mutation("rename_entry", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let user_uuid = p.get("user_uuid").and_then(|v| v.as_str()).unwrap_or("");
            let from = p.get("from").and_then(|v| v.as_str()).unwrap_or("");
            ctx.validate_path_access(from, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            let to = p.get("to").and_then(|v| v.as_str()).unwrap_or("");
            ctx.validate_path_access(to, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            routes::rename_entry(&p).await?;
            Ok(json!({ "success": true }))
        }
    })
    .mutation("save_connections", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let connections = p.get("connections").ok_or("connections is required")?;
            let data = serde_json::to_vec(connections).map_err(|e| e.to_string())?;
            ctx.set_global_data("connections", &data)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "success": true }))
        }
    })
    .mutation("save_state", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        let pane_id = req.pane_id;
        let last_conn = last_conn.clone();
        let save_state_lock = save_state_lock.clone();
        async move {
            if pane_id <= 0 {
                return Err("pane_id is required".to_string().into());
            }
            let state = p.get("state").cloned().ok_or("state is required")?;
            // Keep persistence and temp identity updates atomic relative to
            // other save_state requests handled by this addon process.
            let _save_state_guard = save_state_lock.lock().await;

            // Track the pane's current directory in the `panes.cwd` column (like
            // the terminal addon), but only for local browsing — a remote SFTP/S3
            // path is meaningless on this machine and would confuse `cwd_changed`
            // listeners (e.g. the version-control addon).
            let is_local = state
                .get("type")
                .and_then(|v| v.as_str())
                .map(|t| t == "local")
                .unwrap_or(true);
            let path = state.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if is_local && !path.is_empty() {
                ctx.set_cwd(pane_id, path)
                    .await
                    .map_err(|e| e.to_string())?;
            }

            // Persist the last connection + current directory into the pane's
            // `extra` (merging so existing keys like `launch` survive). The host
            // returns `extra` to the frontend as `params`, so on a page refresh
            // the pane can reconnect to the same connection at the same folder.
            let mut extra = ctx
                .get_extra_json(pane_id)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(obj) = extra.as_object_mut() {
                obj.insert("explorer".to_string(), state.clone());
            } else {
                extra = json!({ "explorer": state.clone() });
            }
            ctx.set_extra(pane_id, &extra)
                .await
                .map_err(|e| e.to_string())?;
            // The addon's own collection follows the connection field. A
            // local/disconnected state removes only Explorer membership.
            let connected = state
                .get("connectionId")
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty());
            ctx.set_pane_collection(pane_id, "Explorer", connected)
                .await
                .map_err(|e| e.to_string())?;

            // Drive the pane's dynamic display name/icon from the active
            // connection (the user-set manual name/icon always wins on the
            // host). Resolve the label before comparing the key so connection
            // renames are reflected even when the ID stays the same. Plain
            // directory navigation keeps the same key and does not broadcast.
            let remote_type = state
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("local");
            let connection_id = state
                .get("connectionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // Resolve the connection's display label. Any connection (local or
            // remote) with a saved ID looks up the user-assigned label from the
            // connections list. Without a saved connection (fresh pane) local
            // defaults to "Local", remote falls back to the type name.
            let label = if !connection_id.is_empty() {
                ctx.get_global_data("connections")
                    .await
                    .ok()
                    .and_then(|d| serde_json::from_slice::<serde_json::Value>(&d).ok())
                    .and_then(|v| v.as_array().cloned())
                    .and_then(|arr| {
                        arr.into_iter()
                            .find(|c| c.get("id").and_then(|i| i.as_str()) == Some(connection_id))
                    })
                    .and_then(|c| c.get("label").and_then(|l| l.as_str()).map(String::from))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| remote_type.to_string())
            } else if remote_type == "local" {
                "Local".to_string()
            } else {
                remote_type.to_string()
            };
            let key = conn_key(&state, &label);

            let changed = {
                let map = last_conn.lock().unwrap_or_else(|e| e.into_inner());
                map.get(&pane_id) != Some(&key)
            };
            if changed {
                // Every active connection (local or remote) gets a dynamic name
                // so the pane header shows the connection identity instead of
                // the generic "Explorer".
                ctx.set_temp_name(pane_id, &label)
                    .await
                    .map_err(|e| e.to_string())?;
                ctx.set_temp_icon(pane_id, "nerd:server")
                    .await
                    .map_err(|e| e.to_string())?;
                // Only suppress future retries after both dynamic identity
                // updates completed successfully.
                last_conn
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(pane_id, key);
            }

            Ok(json!({ "success": true }))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conn_key_identifies_the_connection() {
        let local = json!({ "type": "local", "connectionId": null });
        let sftp_a = json!({ "type": "sftp", "connectionId": "conn-1" });
        let sftp_b = json!({ "type": "sftp", "connectionId": "conn-2" });
        let s3 = json!({ "type": "s3", "connectionId": "conn-1" });

        assert_eq!(conn_key(&local, "Local"), "local||Local");
        assert_eq!(conn_key(&sftp_a, "Server A"), "sftp|conn-1|Server A");
        assert_ne!(conn_key(&sftp_a, "Server A"), conn_key(&sftp_a, "Server B"));
        assert_ne!(conn_key(&sftp_a, "Server A"), conn_key(&sftp_b, "Server A"));
        assert_ne!(conn_key(&sftp_a, "Server A"), conn_key(&s3, "Server A"));
        assert_ne!(conn_key(&s3, "Server A"), conn_key(&local, "Local"));
    }
}
