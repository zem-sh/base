use serde_json::json;
use zem_addon_sdk::Pane;

use crate::explorer::local::{search_dirs_impl, SearchDirHit};
use crate::explorer::routes;

/// Add all query handlers to the pane.
pub fn register(pane: Pane) -> Pane {
    pane.query("list_directory", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let user_uuid = p.get("user_uuid").and_then(|v| v.as_str()).unwrap_or("");
            let path = p.get("path").and_then(|v| v.as_str()).unwrap_or("");
            ctx.validate_path_access(path, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            let entries = routes::list_directory(&p).await?;
            Ok(json!({ "items": entries }))
        }
    })
    .query("read_file", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let user_uuid = p.get("user_uuid").and_then(|v| v.as_str()).unwrap_or("");
            let path = p.get("path").and_then(|v| v.as_str()).unwrap_or("");
            ctx.validate_path_access(path, user_uuid)
                .await
                .map_err(|e| e.to_string())?;
            let content = routes::read_file(&p).await?;
            let size = content.len() as u64;
            Ok(json!({ "content": content, "size": size }))
        }
    })
    .query("read_file_bytes", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let user_uuid = p.get("user_uuid").and_then(|v| v.as_str()).unwrap_or("");
            let path = p.get("path").and_then(|v| v.as_str()).unwrap_or("");
            ctx.validate_path_access(path, user_uuid).await.map_err(|e| e.to_string())?;
            let bytes = routes::read_file_bytes(&p).await?;
            use base64::Engine;
            Ok(json!({ "data": base64::engine::general_purpose::STANDARD.encode(bytes), "encoding": "base64" }))
        }
    })
    .query("search_dirs", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let query = p.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let limit = p.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
            let user_uuid = p.get("user_uuid").and_then(|v| v.as_str()).unwrap_or("");

            let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
            ctx.validate_path_access(home.to_str().unwrap_or("/"), user_uuid)
                .await
                .map_err(|e| e.to_string())?;

            let hits: Vec<SearchDirHit> = search_dirs_impl(&home, query, limit)?;
            Ok(json!({ "items": hits }))
        }
    })
    .query("get_home_dir", move |req, ctx| {
        let ctx = ctx.clone();
        let p = req.payload.clone();
        async move {
            let user_uuid = p.get("user_uuid").and_then(|v| v.as_str()).unwrap_or("");

            let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
            let home_str = home.to_string_lossy().to_string();
            ctx.validate_path_access(&home_str, user_uuid)
                .await
                .map_err(|e| e.to_string())?;

            Ok(json!({ "path": home_str }))
        }
    })
    .query("get_saved_connections", move |_req, ctx| {
        let ctx = ctx.clone();
        async move {
            let data = ctx
                .get_global_data("connections")
                .await
                .map_err(|e| e.to_string())?;
            if data.is_empty() {
                return Ok(json!({ "connections": [] }));
            }
            let connections: serde_json::Value =
                serde_json::from_slice(&data).map_err(|e| e.to_string())?;
            Ok(json!({ "connections": connections }))
        }
    })
}
