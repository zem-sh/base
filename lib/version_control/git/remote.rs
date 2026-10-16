use crate::version_control::git::{GitRemote, IntoStringError};
use anyhow::{bail, Context, Result};
use git2::Repository;
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

/// Run a git remote command. When `passphrase` is provided, a temporary
/// SSH_ASKPASS script supplies it to ssh. Otherwise BatchMode=yes is used.
pub(crate) fn execute_remote_git_command(
    repo_dir: &Path,
    args: &[&str],
    operation: &str,
    passphrase: Option<&str>,
) -> Result<()> {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .args(args);

    let _temp_dir: Option<tempfile::TempDir>;

    if let Some(pass) = passphrase {
        let dir = tempfile::tempdir()?;
        let script_path = dir.path().join("ssh-askpass");
        let mut f = std::fs::File::create(&script_path)?;
        let escaped = pass.replace('\'', "'\\''");
        write!(f, "#!/bin/sh\nprintf '%s' '{}'", escaped)?;
        drop(f);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700));
        }

        cmd.env("DISPLAY", "dummy")
            .env("SSH_ASKPASS", script_path.to_str().unwrap_or(""))
            .env("SSH_ASKPASS_REQUIRE", "force");
        // No BatchMode — let ssh try the key and use our ASKPASS

        _temp_dir = Some(dir);
    } else {
        cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
        _temp_dir = None;
    }

    let output = cmd
        .output()
        .with_context(|| format!("Failed to execute git {operation}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let details = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "no output".into()
    };
    bail!("Git {operation} failed: {details}");
}

fn run_remote(repo_path: &str, args: &[&str], op: &str, pass: Option<&str>) -> Result<()> {
    execute_remote_git_command(Path::new(repo_path), args, op, pass)
}

pub fn git_push(
    repo_path: String,
    branch: Option<String>,
    remote: String,
    passphrase: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["push", &remote];
    let bs;
    if let Some(ref b) = branch {
        bs = b.clone();
        args.push(&bs);
    }
    run_remote(&repo_path, &args, "push", passphrase.as_deref()).into_string_error()
}

pub fn git_pull(
    repo_path: String,
    branch: Option<String>,
    remote: String,
    passphrase: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["pull", &remote];
    let bs;
    if let Some(ref b) = branch {
        bs = b.clone();
        args.push(&bs);
    }
    run_remote(&repo_path, &args, "pull", passphrase.as_deref()).into_string_error()
}

pub fn git_fetch(
    repo_path: String,
    remote: Option<String>,
    passphrase: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["fetch"];
    let rs;
    if let Some(ref r) = remote {
        rs = r.clone();
        args.push(&rs);
    }
    run_remote(&repo_path, &args, "fetch", passphrase.as_deref()).into_string_error()
}

pub fn git_get_remotes(repo_path: String) -> Result<Vec<GitRemote>, String> {
    let repo = Repository::open(&repo_path)
        .context("Failed to open repository")
        .into_string_error()?;
    let remote_names = repo
        .remotes()
        .context("Failed to get remote names")
        .into_string_error()?;
    let mut remotes = Vec::new();
    for name in remote_names.iter().flatten() {
        if let Ok(remote) = repo.find_remote(name) {
            if let Some(url) = remote.url() {
                remotes.push(GitRemote {
                    name: name.to_string(),
                    url: url.to_string(),
                });
            }
        }
    }
    Ok(remotes)
}
