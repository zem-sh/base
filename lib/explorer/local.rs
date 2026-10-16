use std::path::Path;
use std::time::SystemTime;

use crate::explorer::types::{unix_mode_string, DirEntry};

pub fn list_dir_contents(path: &Path, show_hidden: bool) -> Result<Vec<DirEntry>, String> {
    if !path.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;

        let name = entry.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let permissions = metadata.permissions();
        let perm_str = if cfg!(unix) {
            use std::os::unix::fs::PermissionsExt;
            let mode = permissions.mode();
            Some(unix_mode_string(mode))
        } else {
            None
        };

        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            is_symlink: file_type.is_symlink(),
            size: metadata.len(),
            modified,
            permissions: perm_str,
        });
    }

    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));

    Ok(entries)
}

#[derive(serde::Serialize)]
pub struct SearchDirHit {
    pub path: String,
    pub name: String,
}

pub fn search_dirs_impl(
    root: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchDirHit>, String> {
    if query.is_empty() {
        return list_children(root, limit);
    }

    let query_lower = query.to_lowercase();
    let mut scored_hits: Vec<(SearchDirHit, i32)> = Vec::new();
    let skip_dirs: &[&str] = &[
        "node_modules",
        ".git",
        ".cache",
        "__pycache__",
        ".npm",
        ".yarn",
        "target",
        "dist",
        "build",
        ".local",
        ".config",
    ];

    collect_matching_dirs(root, &query_lower, skip_dirs, &mut scored_hits, 3);

    scored_hits.sort_by(|a, b| b.1.cmp(&a.1));
    scored_hits.dedup_by(|a, b| a.0.path == b.0.path);

    let hits: Vec<SearchDirHit> = scored_hits
        .into_iter()
        .take(limit)
        .map(|(hit, _)| hit)
        .collect();

    Ok(hits)
}

fn list_children(dir: &Path, limit: usize) -> Result<Vec<SearchDirHit>, String> {
    let mut hits = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with('.') {
                    hits.push(SearchDirHit {
                        path: entry.path().to_string_lossy().to_string(),
                        name,
                    });
                    if hits.len() >= limit {
                        break;
                    }
                }
            }
        }
    }
    Ok(hits)
}

fn collect_matching_dirs(
    start: &Path,
    query_lower: &str,
    skip_dirs: &[&str],
    hits: &mut Vec<(SearchDirHit, i32)>,
    max_depth: usize,
) {
    if max_depth == 0 {
        return;
    }

    let entries = match std::fs::read_dir(start) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') || skip_dirs.contains(&name.as_str()) {
            continue;
        }

        let name_lower = name.to_lowercase();
        let mut score = 0;

        if name_lower == *query_lower {
            score += 10000;
        } else if name_lower.starts_with(query_lower) {
            score += 5000;
        } else if name_lower.contains(query_lower) {
            let idx = name_lower.find(query_lower).unwrap_or(0);
            let before_ok = idx == 0 || !name_lower.as_bytes()[idx - 1].is_ascii_alphanumeric();
            let after_idx = idx + query_lower.len();
            let after_ok = after_idx >= name_lower.len()
                || !name_lower.as_bytes()[after_idx].is_ascii_alphanumeric();
            score += if before_ok && after_ok { 3000 } else { 500 };
        } else {
            if max_depth > 1 {
                collect_matching_dirs(&path, query_lower, skip_dirs, hits, max_depth - 1);
            }
            continue;
        }

        let path_str = path.to_string_lossy();
        for part in path_str.split('/') {
            if part.to_lowercase() == *query_lower {
                score += 2000;
                break;
            }
        }

        let depth = path_str.split('/').count().saturating_sub(1);
        if depth > 3 {
            score -= (depth as i32 - 3) * 100;
        }

        hits.push((
            SearchDirHit {
                path: path.to_string_lossy().to_string(),
                name,
            },
            score,
        ));
    }
}
