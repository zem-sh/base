use crate::version_control::git::{
    get_ahead_behind_counts, FileStatus, GitFile, GitFileNode, GitStatus, IntoStringError,
};
use anyhow::{Context, Result};
use git2::{ErrorCode, Repository};
use std::fs;
use std::path::Path;

pub fn git_status(repo_path: String) -> Result<GitStatus, String> {
    _git_status(repo_path).into_string_error()
}

fn _git_status(repo_path: String) -> Result<GitStatus> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;

    let branch = current_branch_name(&repo);

    let ((ahead, behind), has_upstream) = get_ahead_behind_counts(&repo, &branch);

    let mut status_opts = git2::StatusOptions::new();
    status_opts
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false)
        .renames_head_to_index(false)
        .renames_index_to_workdir(false);

    let statuses = repo
        .statuses(Some(&mut status_opts))
        .context("Failed to get status")?;

    let mut files = Vec::new();
    for entry in statuses.iter() {
        let status_flags = entry.status();

        if status_flags == git2::Status::CURRENT {
            continue;
        }

        let path = entry.path().context("Invalid path")?.to_string();

        // Files with unresolved merge conflict markers show up with the
        // CONFLICTED flag. Report them as needing resolution instead of trying
        // to classify them as staged/unstaged changes.
        if status_flags.contains(git2::Status::CONFLICTED) {
            files.push(GitFile {
                path,
                status: FileStatus::Conflict,
                staged: false,
            });
            continue;
        }

        let has_staged = status_flags.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        );

        let has_unstaged = status_flags.intersects(
            git2::Status::WT_NEW
                | git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        );

        if has_staged {
            let status = if status_flags.contains(git2::Status::INDEX_NEW) {
                FileStatus::Added
            } else if status_flags.contains(git2::Status::INDEX_DELETED) {
                FileStatus::Deleted
            } else if status_flags.contains(git2::Status::INDEX_RENAMED) {
                FileStatus::Renamed
            } else {
                FileStatus::Modified
            };

            files.push(GitFile {
                path: path.clone(),
                status,
                staged: true,
            });
        }

        if has_unstaged {
            let status = if status_flags.contains(git2::Status::WT_NEW) && !has_staged {
                FileStatus::Untracked
            } else if status_flags.contains(git2::Status::WT_DELETED) {
                FileStatus::Deleted
            } else if status_flags.contains(git2::Status::WT_RENAMED) {
                FileStatus::Renamed
            } else if status_flags.contains(git2::Status::WT_NEW) {
                FileStatus::Added
            } else {
                FileStatus::Modified
            };

            files.push(GitFile {
                path,
                status,
                staged: false,
            });
        }
    }

    Ok(GitStatus {
        branch,
        ahead,
        behind,
        has_upstream,
        tree: build_file_tree(&repo_path, &files),
        files,
    })
}

/// Build a nested (tree-based) representation of the changed files, mirroring
/// the repository's folder structure. Directory chains that contain no direct
/// file changes are grouped into a single node — e.g. when only
/// `src/components/button.tsx` changed, the tree shows a single
/// `src/components` folder instead of nesting `src` -> `components`.
pub fn build_file_tree(repo_path: &str, files: &[GitFile]) -> Vec<GitFileNode> {
    let mut root: Vec<GitFileNode> = Vec::new();
    for file in files {
        let parts: Vec<&str> = file.path.split('/').collect();
        insert_node(repo_path, &mut root, "", &parts, file);
    }
    sort_nodes(&mut root);
    for node in root.iter_mut() {
        compress_node(node);
    }
    root
}

/// Collapse a directory into its child when it holds no file changes itself
/// and has exactly one (directory) child.
fn compress_node(node: &mut GitFileNode) {
    for child in node.children.iter_mut() {
        compress_node(child);
    }
    while node.children.len() == 1 && node.children[0].is_dir {
        let child = node.children.remove(0);
        node.path = child.path;
        node.name = format!("{}/{}", node.name, child.name);
        node.children = child.children;
    }
}

fn insert_node(
    repo_path: &str,
    nodes: &mut Vec<GitFileNode>,
    parent_path: &str,
    parts: &[&str],
    file: &GitFile,
) {
    let (head, rest) = parts.split_first().expect("file path has components");

    let path = if parent_path.is_empty() {
        head.to_string()
    } else {
        format!("{}/{}", parent_path, head)
    };

    if rest.is_empty() {
        let is_dir = Path::new(repo_path).join(&file.path).is_dir();
        if is_dir {
            if nodes.iter().any(|node| node.is_dir && node.path == path) {
                return;
            }
            nodes.push(GitFileNode {
                name: head.to_string(),
                path,
                is_dir: true,
                status: None,
                staged: false,
                children: Vec::new(),
            });
            return;
        }
        nodes.push(GitFileNode {
            name: head.to_string(),
            path,
            is_dir: false,
            status: Some(file.status),
            staged: file.staged,
            children: Vec::new(),
        });
        return;
    }

    match nodes
        .iter_mut()
        .find(|node| node.is_dir && node.path == path)
    {
        Some(dir) => insert_node(repo_path, &mut dir.children, &path, rest, file),
        None => {
            let mut dir = GitFileNode {
                name: head.to_string(),
                path: path.clone(),
                is_dir: true,
                status: None,
                staged: false,
                children: Vec::new(),
            };
            insert_node(repo_path, &mut dir.children, &path, rest, file);
            nodes.push(dir);
        }
    }
}

fn sort_nodes(nodes: &mut [GitFileNode]) {
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    for node in nodes {
        sort_nodes(&mut node.children);
    }
}

fn current_branch_name(repo: &Repository) -> String {
    match repo.head() {
        Ok(head) => {
            if head.is_branch() {
                head.shorthand()
                    .map(|name| name.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            } else {
                "HEAD".to_string()
            }
        }
        Err(error) if error.code() == ErrorCode::UnbornBranch => unborn_head_branch_name(repo),
        Err(_) => "unknown".to_string(),
    }
}

fn unborn_head_branch_name(repo: &Repository) -> String {
    fs::read_to_string(repo.path().join("HEAD"))
        .ok()
        .and_then(|head| {
            head.trim()
                .strip_prefix("ref: refs/heads/")
                .map(|name| name.to_string())
        })
        .or_else(|| {
            repo.config()
                .ok()
                .and_then(|config| config.get_string("init.defaultBranch").ok())
        })
        .unwrap_or_else(|| "main".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_file_tree_nests_directories() {
        let files = vec![
            GitFile {
                path: "src/components/button.tsx".into(),
                status: FileStatus::Modified,
                staged: false,
            },
            GitFile {
                path: "src/index.tsx".into(),
                status: FileStatus::Added,
                staged: true,
            },
            GitFile {
                path: "src/components/index.ts".into(),
                status: FileStatus::Untracked,
                staged: false,
            },
            GitFile {
                path: "README.md".into(),
                status: FileStatus::Modified,
                staged: false,
            },
        ];

        let tree = build_file_tree("/nonexistent/repo", &files);

        assert_eq!(tree.len(), 2);
        let src = &tree[0];
        let readme = &tree[1];
        assert!(!readme.is_dir);
        assert_eq!(readme.path, "README.md");
        assert!(src.is_dir);
        assert_eq!(src.path, "src");
        assert_eq!(src.children.len(), 2);
        assert_eq!(src.children[0].path, "src/components");
        assert!(src.children[0].is_dir);
        assert_eq!(src.children[0].children.len(), 2);
        assert_eq!(src.children[1].path, "src/index.tsx");
        assert!(!src.children[1].is_dir);
    }
}
