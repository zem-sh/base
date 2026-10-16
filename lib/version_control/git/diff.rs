use crate::version_control::git::{
    get_blob_base64, is_image_file, DiffLineType, GitDiff, GitDiffLine, GitDiffStat,
    GitFileContents,
};
use anyhow::Result;
use base64::{engine::general_purpose, Engine as _};
use git2::{Diff, DiffFormat, Repository};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

const LARGE_DIFF_LINE_THRESHOLD: usize = 20_000;

#[derive(Default)]
pub struct ParsedDiffLines {
    pub lines: Vec<GitDiffLine>,
    pub is_truncated: bool,
}

pub fn parse_diff_to_lines(diff: &mut Diff) -> Result<ParsedDiffLines, String> {
    let mut lines: Vec<GitDiffLine> = Vec::new();
    let mut is_truncated = false;

    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        if lines.len() >= LARGE_DIFF_LINE_THRESHOLD {
            if !is_truncated {
                lines.push(GitDiffLine {
                    line_type: DiffLineType::Header,
                    content: format!(
                        "Truncated this diff after {LARGE_DIFF_LINE_THRESHOLD} lines."
                    ),
                    old_line_number: None,
                    new_line_number: None,
                });
                is_truncated = true;
            }
            return true;
        }

        let origin = line.origin();
        match origin {
            'F' | 'H' => {
                let content = String::from_utf8_lossy(line.content()).to_string();
                lines.push(GitDiffLine {
                    line_type: DiffLineType::Header,
                    content,
                    old_line_number: None,
                    new_line_number: None,
                });
            }
            '+' => {
                lines.push(GitDiffLine {
                    line_type: DiffLineType::Added,
                    content: String::from_utf8_lossy(line.content())
                        .trim_end_matches('\n')
                        .to_string(),
                    old_line_number: None,
                    new_line_number: line.new_lineno(),
                });
            }
            '-' => {
                lines.push(GitDiffLine {
                    line_type: DiffLineType::Removed,
                    content: String::from_utf8_lossy(line.content())
                        .trim_end_matches('\n')
                        .to_string(),
                    old_line_number: line.old_lineno(),
                    new_line_number: None,
                });
            }
            ' ' => {
                lines.push(GitDiffLine {
                    line_type: DiffLineType::Context,
                    content: String::from_utf8_lossy(line.content())
                        .trim_end_matches('\n')
                        .to_string(),
                    old_line_number: line.old_lineno(),
                    new_line_number: line.new_lineno(),
                });
            }
            _ => {}
        }
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(ParsedDiffLines {
        lines,
        is_truncated,
    })
}

fn diff_delta_file_path(delta: &git2::DiffDelta<'_>) -> String {
    if delta.status() == git2::Delta::Deleted {
        delta
            .old_file()
            .path()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

fn collect_diff_stats(
    diff: &mut Diff,
    staged: bool,
) -> Result<HashMap<String, GitDiffStat>, String> {
    let mut stats_by_path: HashMap<String, GitDiffStat> = HashMap::new();

    diff.print(DiffFormat::Patch, |delta, _hunk, line| {
        let origin = line.origin();
        if origin != '+' && origin != '-' {
            return true;
        }

        let file_path = diff_delta_file_path(&delta);
        if file_path.is_empty() {
            return true;
        }

        let entry = stats_by_path
            .entry(file_path.clone())
            .or_insert_with(|| GitDiffStat {
                file_path,
                staged,
                additions: 0,
                deletions: 0,
            });

        if origin == '+' {
            entry.additions += 1;
        } else {
            entry.deletions += 1;
        }

        true
    })
    .map_err(|error| error.to_string())?;

    Ok(stats_by_path)
}

pub fn git_status_diff_stats(repo_path: String) -> Result<Vec<GitDiffStat>, String> {
    let repo =
        Repository::open(&repo_path).map_err(|e| format!("Failed to open repository: {e}"))?;
    let head_tree = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .and_then(|commit| commit.tree().ok());
    let index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {e}"))?;

    let mut staged_diff = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
        .map_err(|e| format!("Failed to create staged diff: {e}"))?;

    let mut unstaged_options = git2::DiffOptions::new();
    unstaged_options.include_untracked(true);
    unstaged_options.recurse_untracked_dirs(false);
    let mut unstaged_diff = repo
        .diff_index_to_workdir(Some(&index), Some(&mut unstaged_options))
        .map_err(|e| format!("Failed to create unstaged diff: {e}"))?;

    let mut stats = collect_diff_stats(&mut staged_diff, true)?;
    stats.extend(collect_diff_stats(&mut unstaged_diff, false)?);

    Ok(stats.into_values().collect())
}

fn git_diff_raw_patch(repo_path: &str, file_path: &str, staged: bool) -> Result<String, String> {
    let repo_dir = Path::new(repo_path);
    if !repo_dir.join(".git").exists() {
        return Err("Not a git repository".to_string());
    }

    let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(file_path);

    let output = Command::new("git")
        .current_dir(repo_dir)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run git diff: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn git_diff_file(
    repo_path: String,
    file_path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    let repo =
        Repository::open(&repo_path).map_err(|e| format!("Failed to open repository: {e}"))?;
    let is_image = is_image_file(&file_path);

    let head = repo
        .head()
        .map_err(|e| format!("Failed to get HEAD: {e}"))?;
    let head_commit = head
        .peel_to_commit()
        .map_err(|e| format!("Failed to peel to commit: {e}"))?;
    let head_tree = head_commit
        .tree()
        .map_err(|e| format!("Failed to get HEAD tree: {e}"))?;

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(&file_path);

    let diff_result = if staged {
        let index = repo
            .index()
            .map_err(|e| format!("Failed to get index: {e}"))?;
        repo.diff_tree_to_index(Some(&head_tree), Some(&index), Some(&mut diff_opts))
    } else {
        let index = repo
            .index()
            .map_err(|e| format!("Failed to get index: {e}"))?;
        repo.diff_index_to_workdir(Some(&index), Some(&mut diff_opts))
    };

    let mut diff = diff_result.map_err(|e| format!("Failed to create diff: {e}"))?;

    let mut old_blob_base64 = None;
    let mut new_blob_base64 = None;
    let mut is_truncated = false;

    let deltas: Vec<_> = diff.deltas().collect();

    if deltas.is_empty() {
        return Err(format!("No changes found for file: {file_path}"));
    }

    let delta = &deltas[0];

    let is_new = delta.status() == git2::Delta::Added;
    let is_deleted = delta.status() == git2::Delta::Deleted;
    let is_renamed = delta.status() == git2::Delta::Renamed;

    let old_path = delta
        .old_file()
        .path()
        .map(|p| p.to_string_lossy().into_owned());
    let new_path = delta
        .new_file()
        .path()
        .map(|p| p.to_string_lossy().into_owned());

    let lines = if is_image {
        let old_oid = delta.old_file().id();
        let new_oid = delta.new_file().id();

        if is_new {
            if staged {
                new_blob_base64 = get_blob_base64(&repo, Some(new_oid), &file_path);
            } else {
                let abs_path = Path::new(&repo_path).join(&file_path);
                if let Ok(data) = std::fs::read(abs_path) {
                    new_blob_base64 = Some(general_purpose::STANDARD.encode(data));
                }
            }
        } else if is_deleted {
            old_blob_base64 = get_blob_base64(
                &repo,
                Some(old_oid),
                old_path.as_deref().unwrap_or(&file_path),
            );
        } else if is_renamed {
            old_blob_base64 = get_blob_base64(
                &repo,
                Some(old_oid),
                old_path.as_deref().unwrap_or(&file_path),
            );
            if staged {
                new_blob_base64 = get_blob_base64(
                    &repo,
                    Some(new_oid),
                    new_path.as_deref().unwrap_or(&file_path),
                );
            } else {
                let abs_path =
                    Path::new(&repo_path).join(new_path.as_deref().unwrap_or(&file_path));
                if let Ok(data) = std::fs::read(abs_path) {
                    new_blob_base64 = Some(general_purpose::STANDARD.encode(data));
                }
            }
        } else {
            if !is_new {
                old_blob_base64 = get_blob_base64(&repo, Some(old_oid), &file_path);
            }
            if staged {
                new_blob_base64 = get_blob_base64(&repo, Some(new_oid), &file_path);
            } else {
                let abs_path = Path::new(&repo_path).join(&file_path);
                if let Ok(data) = std::fs::read(abs_path) {
                    new_blob_base64 = Some(general_purpose::STANDARD.encode(data));
                }
            }
        }

        Vec::new()
    } else {
        let parsed = parse_diff_to_lines(&mut diff)?;
        is_truncated = parsed.is_truncated;
        parsed.lines
    };

    let (additions, deletions) = count_line_stats(&lines);

    Ok(GitDiff {
        file_path: file_path.clone(),
        old_path,
        new_path,
        is_new,
        is_deleted,
        is_renamed,
        is_binary: is_image,
        is_image,
        old_blob_base64,
        new_blob_base64,
        lines,
        raw_patch: Some(git_diff_raw_patch(&repo_path, &file_path, staged)?),
        additions: Some(additions),
        deletions: Some(deletions),
        is_truncated: is_truncated.then_some(true),
    })
}

fn count_line_stats(lines: &[GitDiffLine]) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;

    for line in lines {
        match line.line_type {
            DiffLineType::Added => additions += 1,
            DiffLineType::Removed => deletions += 1,
            _ => {}
        }
    }

    (additions, deletions)
}

/// Read a blob from the repository and return it as text.
fn blob_to_string(repo: &Repository, oid: git2::Oid) -> Option<String> {
    repo.find_blob(oid)
        .ok()
        .map(|blob| String::from_utf8_lossy(blob.content()).into_owned())
}

/// Fetch the full old/new file contents for a path, mirroring `git_diff_file`.
/// Used to hydrate collapsed unchanged context in diff viewers.
pub fn git_file_contents(
    repo_path: String,
    file_path: String,
    staged: bool,
) -> Result<GitFileContents, String> {
    let repo =
        Repository::open(&repo_path).map_err(|e| format!("Failed to open repository: {e}"))?;
    let index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {e}"))?;
    let path = Path::new(&file_path);

    let old = if staged {
        repo.head()
            .ok()
            .and_then(|head| head.peel_to_tree().ok())
            .and_then(|tree| tree.get_path(path).ok())
            .and_then(|entry| entry.to_object(&repo).ok())
            .and_then(|object| object.as_blob().map(|b| b.to_owned()))
            .map(|blob| String::from_utf8_lossy(blob.content()).into_owned())
    } else {
        index
            .get_path(path, 0)
            .and_then(|entry| blob_to_string(&repo, entry.id))
    };

    let new = if staged {
        index
            .get_path(path, 0)
            .and_then(|entry| blob_to_string(&repo, entry.id))
    } else {
        std::fs::read_to_string(Path::new(&repo_path).join(&file_path)).ok()
    };

    Ok(GitFileContents { old, new })
}

/// Read the raw working-tree contents of a file with unresolved merge
/// conflict markers. Returns an error when the file cannot be read as text.
pub fn git_conflict_file_content(repo_path: String, file_path: String) -> Result<String, String> {
    std::fs::read_to_string(Path::new(&repo_path).join(&file_path))
        .map_err(|e| format!("Failed to read conflict file {file_path}: {e}"))
}

/// Write resolved content back to the working tree and stage the file,
/// which clears the conflict state in the index (like `git add`).
pub fn git_resolve_conflict(
    repo_path: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    std::fs::write(Path::new(&repo_path).join(&file_path), content)
        .map_err(|e| format!("Failed to write resolved file {file_path}: {e}"))?;
    crate::version_control::git::git_add(repo_path, file_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::version_control::git::{git_add, git_status, FileStatus};
    use git2::{IndexAddOption, Signature};
    use std::fs;

    fn setup_repo(dir: &std::path::Path) -> Repository {
        let repo = Repository::init(dir).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();

        fs::write(dir.join("a.txt"), "v1\n").unwrap();

        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        drop(tree);

        repo
    }

    #[test]
    fn file_contents_unstaged_reads_index_and_workdir() {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path().to_string_lossy().to_string();
        setup_repo(dir.path());

        fs::write(dir.path().join("a.txt"), "v2\n").unwrap();

        let contents = git_file_contents(repo_path, "a.txt".into(), false).unwrap();
        assert_eq!(contents.old.as_deref(), Some("v1\n"));
        assert_eq!(contents.new.as_deref(), Some("v2\n"));
    }

    #[test]
    fn file_contents_staged_reads_head_and_index() {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path().to_string_lossy().to_string();
        setup_repo(dir.path());

        fs::write(dir.path().join("a.txt"), "v2\n").unwrap();
        git_add(repo_path.clone(), "a.txt".into()).unwrap();

        let contents = git_file_contents(repo_path, "a.txt".into(), true).unwrap();
        assert_eq!(contents.old.as_deref(), Some("v1\n"));
        assert_eq!(contents.new.as_deref(), Some("v2\n"));
    }

    #[test]
    fn resolve_conflict_writes_and_stages_file() {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path().to_string_lossy().to_string();
        setup_repo(dir.path());

        // Simulate a conflicted working tree with marker content.
        let conflicted = "<<<<<<< HEAD\nv1\n=======\nv2\n>>>>>>> feature\n";
        fs::write(dir.path().join("a.txt"), conflicted).unwrap();

        let status = git_status(repo_path.clone()).unwrap();
        assert!(status.files.iter().any(|f| f.path == "a.txt"));

        git_resolve_conflict(repo_path.clone(), "a.txt".into(), "resolved\n".into()).unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "resolved\n"
        );

        // The file should now be staged (staged flag true, no conflict status).
        let status = git_status(repo_path).unwrap();
        let entry = status
            .files
            .iter()
            .find(|f| f.path == "a.txt")
            .expect("file should still be listed");
        assert!(entry.staged);
        assert_ne!(entry.status, FileStatus::Conflict);
    }
}
