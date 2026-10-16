use crate::version_control::git::{GitStash, IntoStringError};
use anyhow::{bail, Context, Result};
use std::{path::Path, process::Command};

pub fn git_get_stashes(repo_path: String) -> Result<Vec<GitStash>, String> {
    _git_get_stashes(repo_path).into_string_error()
}

fn clean_stash_subject(subject: &str) -> String {
    let trimmed = subject.trim();
    let without_context = if let Some((_, message)) = trimmed.split_once(": ") {
        if trimmed.starts_with("On ")
            || trimmed.starts_with("WIP on ")
            || trimmed.starts_with("index on ")
        {
            message
        } else {
            trimmed
        }
    } else {
        trimmed
    };

    let mut message_parts = without_context.splitn(2, ' ');
    if let Some(first_part) = message_parts.next() {
        if first_part.len() >= 7
            && first_part.len() <= 40
            && first_part.chars().all(|c| c.is_ascii_hexdigit())
        {
            return message_parts
                .next()
                .unwrap_or(without_context)
                .trim()
                .to_string();
        }
    }

    without_context.trim().to_string()
}

fn _git_get_stashes(repo_path: String) -> Result<Vec<GitStash>> {
    let repo_dir = Path::new(&repo_path);

    if !repo_dir.join(".git").exists() {
        bail!("Not a git repository");
    }

    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(["stash", "list", "--format=%gd|%s|%aI"])
        .output()
        .context("Failed to execute git stash list")?;

    let mut stashes = Vec::new();
    if output.status.success() {
        let stash_text = String::from_utf8_lossy(&output.stdout);
        for (index, line) in stash_text.lines().enumerate() {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 3 {
                stashes.push(GitStash {
                    index,
                    message: clean_stash_subject(parts[1]),
                    date: parts[2].to_string(),
                });
            }
        }
    }

    Ok(stashes)
}

pub fn git_create_stash(
    repo_path: String,
    message: Option<String>,
    include_untracked: bool,
    files: Option<Vec<String>>,
) -> Result<(), String> {
    _git_create_stash(repo_path, message, include_untracked, files).into_string_error()
}

fn _git_create_stash(
    repo_path: String,
    message: Option<String>,
    include_untracked: bool,
    files: Option<Vec<String>>,
) -> Result<()> {
    let repo_dir = Path::new(&repo_path);
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    if let Some(ref msg) = message {
        args.push("-m");
        args.push(msg);
    }

    if let Some(ref file_list) = files {
        if !file_list.is_empty() {
            args.push("--");
            for file in file_list {
                args.push(file);
            }
        }
    }

    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(&args)
        .output()
        .context("Failed to execute git stash push")?;

    if !output.status.success() {
        bail!(
            "Git stash create failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    Ok(())
}

pub fn git_pop_stash(repo_path: String, stash_index: Option<usize>) -> Result<(), String> {
    _git_pop_stash(repo_path, stash_index).into_string_error()
}

fn _git_pop_stash(repo_path: String, stash_index: Option<usize>) -> Result<()> {
    let repo_dir = Path::new(&repo_path);
    let mut args = vec!["stash", "pop"];
    let index_str;
    if let Some(idx) = stash_index {
        index_str = format!("stash@{{{idx}}}");
        args.push(&index_str);
    }

    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(&args)
        .output()
        .context("Failed to execute git stash pop")?;

    if !output.status.success() {
        bail!(
            "Git stash pop failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    Ok(())
}

pub fn git_drop_stash(repo_path: String, stash_index: usize) -> Result<(), String> {
    _git_drop_stash(repo_path, stash_index).into_string_error()
}

fn _git_drop_stash(repo_path: String, stash_index: usize) -> Result<()> {
    let repo_dir = Path::new(&repo_path);
    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(["stash", "drop", &format!("stash@{{{stash_index}}}")])
        .output()
        .context("Failed to execute git stash drop")?;

    if !output.status.success() {
        bail!(
            "Git stash drop failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    Ok(())
}
