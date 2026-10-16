use std::path::Path;

use crate::explorer::local::list_dir_contents;
use crate::explorer::s3::{
    s3_create_directory, s3_delete_entry, s3_list_directory, s3_read_file, s3_read_file_bytes,
    s3_rename_entry, s3_write_file,
};
use crate::explorer::sftp::{
    sftp_create_directory, sftp_delete_entry, sftp_list_directory, sftp_read_file,
    sftp_read_file_bytes, sftp_rename_entry, sftp_write_file,
};
use crate::explorer::types::{DirEntry, S3Config, SftpConfig};

/// Extract the optional remote connection from params.
fn route_connection(params: &serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    Ok(params.get("connection").map(|c| c.clone()))
}

pub async fn list_directory(params: &serde_json::Value) -> Result<Vec<DirEntry>, String> {
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return Err("path is required".to_string());
    }

    let show_hidden = params
        .get("show_hidden")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    match route_connection(params)? {
        Some(conn) => match conn.get("type").and_then(|v| v.as_str()) {
            Some("s3") => {
                let config: S3Config =
                    serde_json::from_value(conn).map_err(|e| format!("s3 config error: {}", e))?;
                s3_list_directory(&config, path).await
            }
            Some("sftp") => {
                let config: SftpConfig = serde_json::from_value(conn)
                    .map_err(|e| format!("sftp config error: {}", e))?;
                sftp_list_directory(&config, path).await
            }
            _ => list_dir_contents(Path::new(path), show_hidden),
        },
        None => list_dir_contents(Path::new(path), show_hidden),
    }
}

pub async fn read_file(params: &serde_json::Value) -> Result<String, String> {
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return Err("path is required".to_string());
    }

    match route_connection(params)? {
        Some(conn) => match conn.get("type").and_then(|v| v.as_str()) {
            Some("s3") => {
                let config: S3Config =
                    serde_json::from_value(conn).map_err(|e| format!("s3 config error: {}", e))?;
                s3_read_file(&config, path).await
            }
            Some("sftp") => {
                let config: SftpConfig = serde_json::from_value(conn)
                    .map_err(|e| format!("sftp config error: {}", e))?;
                sftp_read_file(&config, path).await
            }
            _ => {
                let p = Path::new(path);
                if !p.is_file() {
                    return Err(format!("not a file: {}", path));
                }
                std::fs::read_to_string(p).map_err(|e| e.to_string())
            }
        },
        None => {
            let p = Path::new(path);
            if !p.is_file() {
                return Err(format!("not a file: {}", path));
            }
            std::fs::read_to_string(p).map_err(|e| e.to_string())
        }
    }
}

pub async fn read_file_bytes(params: &serde_json::Value) -> Result<Vec<u8>, String> {
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return Err("path is required".to_string());
    }
    match route_connection(params)? {
        Some(conn) => match conn.get("type").and_then(|v| v.as_str()) {
            Some("s3") => {
                let config: S3Config =
                    serde_json::from_value(conn).map_err(|e| format!("s3 config error: {}", e))?;
                s3_read_file_bytes(&config, path).await
            }
            Some("sftp") => {
                let config: SftpConfig = serde_json::from_value(conn)
                    .map_err(|e| format!("sftp config error: {}", e))?;
                sftp_read_file_bytes(&config, path).await
            }
            _ => std::fs::read(Path::new(path)).map_err(|e| e.to_string()),
        },
        None => std::fs::read(Path::new(path)).map_err(|e| e.to_string()),
    }
}

pub async fn write_file(params: &serde_json::Value) -> Result<(), String> {
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return Err("path is required".to_string());
    }

    match route_connection(params)? {
        Some(conn) => match conn.get("type").and_then(|v| v.as_str()) {
            Some("s3") => {
                let config: S3Config =
                    serde_json::from_value(conn).map_err(|e| format!("s3 config error: {}", e))?;
                s3_write_file(&config, path, content).await
            }
            Some("sftp") => {
                let config: SftpConfig = serde_json::from_value(conn)
                    .map_err(|e| format!("sftp config error: {}", e))?;
                sftp_write_file(&config, path, content).await
            }
            _ => {
                let p = Path::new(path);
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(p, content).map_err(|e| e.to_string())
            }
        },
        None => {
            let p = Path::new(path);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(p, content).map_err(|e| e.to_string())
        }
    }
}

pub async fn delete_entry(params: &serde_json::Value) -> Result<(), String> {
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return Err("path is required".to_string());
    }

    match route_connection(params)? {
        Some(conn) => match conn.get("type").and_then(|v| v.as_str()) {
            Some("s3") => {
                let config: S3Config =
                    serde_json::from_value(conn).map_err(|e| format!("s3 config error: {}", e))?;
                s3_delete_entry(&config, path).await
            }
            Some("sftp") => {
                let config: SftpConfig = serde_json::from_value(conn)
                    .map_err(|e| format!("sftp config error: {}", e))?;
                sftp_delete_entry(&config, path).await
            }
            _ => {
                let p = Path::new(path);
                if !p.exists() {
                    return Err(format!("path not found: {}", path));
                }
                if p.is_dir() {
                    std::fs::remove_dir_all(p).map_err(|e| e.to_string())?;
                } else {
                    std::fs::remove_file(p).map_err(|e| e.to_string())?;
                }
                Ok(())
            }
        },
        None => {
            let p = Path::new(path);
            if !p.exists() {
                return Err(format!("path not found: {}", path));
            }
            if p.is_dir() {
                std::fs::remove_dir_all(p).map_err(|e| e.to_string())?;
            } else {
                std::fs::remove_file(p).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

pub async fn rename_entry(params: &serde_json::Value) -> Result<(), String> {
    let from = params.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let to = params.get("to").and_then(|v| v.as_str()).unwrap_or("");
    if from.is_empty() || to.is_empty() {
        return Err("from and to are required".to_string());
    }

    match route_connection(params)? {
        Some(conn) => match conn.get("type").and_then(|v| v.as_str()) {
            Some("s3") => {
                let config: S3Config =
                    serde_json::from_value(conn).map_err(|e| format!("s3 config error: {}", e))?;
                s3_rename_entry(&config, from, to).await
            }
            Some("sftp") => {
                let config: SftpConfig = serde_json::from_value(conn)
                    .map_err(|e| format!("sftp config error: {}", e))?;
                sftp_rename_entry(&config, from, to).await
            }
            _ => {
                let from_path = Path::new(from);
                if !from_path.exists() {
                    return Err(format!("source path not found: {}", from));
                }
                let to_path = Path::new(to);
                if let Some(parent) = to_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::rename(from_path, to_path).map_err(|e| e.to_string())
            }
        },
        None => {
            let from_path = Path::new(from);
            if !from_path.exists() {
                return Err(format!("source path not found: {}", from));
            }
            let to_path = Path::new(to);
            if let Some(parent) = to_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(from_path, to_path).map_err(|e| e.to_string())
        }
    }
}

pub async fn create_directory(params: &serde_json::Value) -> Result<(), String> {
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return Err("path is required".to_string());
    }

    match route_connection(params)? {
        Some(conn) => match conn.get("type").and_then(|v| v.as_str()) {
            Some("s3") => {
                let config: S3Config =
                    serde_json::from_value(conn).map_err(|e| format!("s3 config error: {}", e))?;
                s3_create_directory(&config, path).await
            }
            Some("sftp") => {
                let config: SftpConfig = serde_json::from_value(conn)
                    .map_err(|e| format!("sftp config error: {}", e))?;
                sftp_create_directory(&config, path).await
            }
            _ => std::fs::create_dir_all(Path::new(path)).map_err(|e| e.to_string()),
        },
        None => std::fs::create_dir_all(Path::new(path)).map_err(|e| e.to_string()),
    }
}
