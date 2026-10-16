use std::sync::Arc;

use russh::client;
use russh_keys::key;
use russh_sftp::client::SftpSession;

use crate::explorer::types::{DirEntry, SftpConfig};

struct SshHandler;

#[async_trait::async_trait]
impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn connect(config: &SftpConfig) -> Result<SftpSession, String> {
    let sh = SshHandler;
    let mut session = client::connect(
        Arc::new(client::Config::default()),
        (config.host.as_str(), config.port),
        sh,
    )
    .await
    .map_err(|e| format!("sftp connect error: {}", e))?;

    let authenticated = if config.key_path.as_ref().is_some_and(|k| !k.is_empty()) {
        let key_path = config.key_path.as_ref().unwrap();
        let key_pair = russh_keys::load_secret_key(key_path, None)
            .map_err(|e| format!("sftp key load error: {}", e))?;
        session
            .authenticate_publickey(&config.user, Arc::new(key_pair))
            .await
            .map_err(|e| format!("sftp pubkey auth error: {}", e))?
    } else if let Some(ref password) = config.password {
        session
            .authenticate_password(&config.user, password)
            .await
            .map_err(|e| format!("sftp password auth error: {}", e))?
    } else {
        return Err("no authentication method provided".to_string());
    };

    if !authenticated {
        return Err("sftp authentication failed".to_string());
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("sftp channel open error: {}", e))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("sftp subsystem request error: {}", e))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("sftp session init error: {}", e))?;

    Ok(sftp)
}

pub async fn sftp_list_directory(config: &SftpConfig, path: &str) -> Result<Vec<DirEntry>, String> {
    let sftp = connect(config).await?;
    let dir_path = if path.is_empty() { "/" } else { path };

    let entries = sftp
        .read_dir(dir_path)
        .await
        .map_err(|e| format!("sftp read_dir error: {}", e))?;

    let mut result = Vec::new();

    for entry in entries {
        let name = entry.file_name();
        let metadata = entry.metadata();
        let path = entry.path();

        result.push(DirEntry {
            name,
            path,
            is_dir: metadata.is_dir(),
            is_symlink: metadata.is_symlink(),
            size: metadata.size.unwrap_or(0),
            modified: metadata.mtime.map(|t| t as i64).unwrap_or(0),
            permissions: None,
        });
    }

    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));

    Ok(result)
}

pub async fn sftp_read_file_bytes(config: &SftpConfig, path: &str) -> Result<Vec<u8>, String> {
    let sftp = connect(config).await?;
    sftp.read(path)
        .await
        .map_err(|e| format!("sftp read error: {}", e))
}

pub async fn sftp_read_file(config: &SftpConfig, path: &str) -> Result<String, String> {
    let sftp = connect(config).await?;

    let content = sftp
        .read(path)
        .await
        .map_err(|e| format!("sftp read error: {}", e))?;

    String::from_utf8(content).map_err(|e| format!("sftp read utf8 error: {}", e))
}

pub async fn sftp_write_file(config: &SftpConfig, path: &str, content: &str) -> Result<(), String> {
    let sftp = connect(config).await?;

    sftp.write(path, content.as_bytes())
        .await
        .map_err(|e| format!("sftp write error: {}", e))
}

pub async fn sftp_delete_entry(config: &SftpConfig, path: &str) -> Result<(), String> {
    let sftp = connect(config).await?;

    match sftp.remove_file(path).await {
        Ok(_) => Ok(()),
        Err(_) => {
            sftp.remove_dir(path)
                .await
                .map_err(|e| format!("sftp remove error: {}", e))?;
            Ok(())
        }
    }
}

pub async fn sftp_rename_entry(config: &SftpConfig, from: &str, to: &str) -> Result<(), String> {
    let sftp = connect(config).await?;

    sftp.rename(from, to)
        .await
        .map_err(|e| format!("sftp rename error: {}", e))
}

pub async fn sftp_create_directory(config: &SftpConfig, path: &str) -> Result<(), String> {
    let sftp = connect(config).await?;

    sftp.create_dir(path)
        .await
        .map_err(|e| format!("sftp create_dir error: {}", e))
}
