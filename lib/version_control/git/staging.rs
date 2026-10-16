use crate::version_control::git::IntoStringError;
use anyhow::{Context, Result};
use git2::{ErrorCode, Repository};
use std::path::Path;

pub fn git_add(repo_path: String, file_path: String) -> Result<(), String> {
    _git_add(repo_path, file_path).into_string_error()
}

fn _git_add(repo_path: String, file_path: String) -> Result<()> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;
    let mut index = repo.index().context("Failed to get index")?;

    let file_path = file_path.trim_end_matches('/').to_string();
    let relative_path = Path::new(&file_path);
    let absolute_path = Path::new(&repo_path).join(relative_path);

    if absolute_path.is_dir() {
        index
            .add_all(
                [file_path.as_str()].iter(),
                git2::IndexAddOption::DEFAULT,
                None,
            )
            .with_context(|| format!("Failed to add directory {}", file_path))?;
    } else {
        match index.add_path(relative_path) {
            Ok(_) => {}
            Err(err) => {
                if err.code() == ErrorCode::NotFound {
                    index
                        .add_all(
                            [file_path.as_str()].iter(),
                            git2::IndexAddOption::DEFAULT,
                            None,
                        )
                        .with_context(|| format!("Failed to add path {}", file_path))?;
                } else {
                    return Err(err).with_context(|| format!("Failed to add file {}", file_path));
                }
            }
        }
    }

    index.write().context("Failed to write index")?;

    Ok(())
}

pub fn git_reset(repo_path: String, file_path: String) -> Result<(), String> {
    _git_reset(repo_path, file_path).into_string_error()
}

fn _git_reset(repo_path: String, file_path: String) -> Result<()> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;

    let head = repo.head().context("Failed to get HEAD")?;
    let head_commit = head.peel_to_commit().context("Failed to get HEAD commit")?;
    let head_tree = head_commit.tree().context("Failed to get HEAD tree")?;
    let mut index = repo.index().context("Failed to get index")?;

    let file_path = file_path.trim_end_matches('/').to_string();
    let absolute_path = Path::new(&repo_path).join(&file_path);

    if absolute_path.is_dir() {
        let prefix = format!("{}/", file_path);
        let paths: Vec<String> = index
            .iter()
            .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
            .filter(|path| path == &file_path || path.starts_with(&prefix))
            .collect();
        for path in paths {
            reset_index_entry(&mut index, &head_tree, &repo, &path)?;
        }
    } else {
        reset_index_entry(&mut index, &head_tree, &repo, &file_path)?;
    }

    index.write().context("Failed to write index")?;
    Ok(())
}

fn reset_index_entry(
    index: &mut git2::Index,
    head_tree: &git2::Tree<'_>,
    repo: &Repository,
    path: &str,
) -> Result<()> {
    let path_obj = Path::new(path);
    match head_tree.get_path(path_obj) {
        Ok(entry) => {
            let object = entry.to_object(repo).context("Failed to get object")?;
            let blob = object.as_blob().context("Object is not a blob")?;

            let index_entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: entry.filemode() as u32,
                uid: 0,
                gid: 0,
                file_size: blob.size() as u32,
                id: entry.id(),
                flags: 0,
                flags_extended: 0,
                path: path.as_bytes().to_vec(),
            };

            index.add(&index_entry).context("Failed to update index")?;
        }
        Err(_) => {
            index
                .remove_path(path_obj)
                .context("Failed to remove from index")?;
        }
    }
    Ok(())
}

pub fn git_add_all(repo_path: String) -> Result<(), String> {
    _git_add_all(repo_path).into_string_error()
}

fn _git_add_all(repo_path: String) -> Result<()> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;
    let mut index = repo.index().context("Failed to get index")?;

    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .context("Failed to add all files")?;
    index.write().context("Failed to write index")?;

    Ok(())
}

pub fn git_reset_all(repo_path: String) -> Result<(), String> {
    _git_reset_all(repo_path).into_string_error()
}

fn _git_reset_all(repo_path: String) -> Result<()> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;

    let head = repo.head().context("Failed to get HEAD")?;
    let head_commit = head.peel_to_commit().context("Failed to get HEAD commit")?;
    let head_tree = head_commit.tree().context("Failed to get HEAD tree")?;
    let mut index = repo.index().context("Failed to get index")?;

    index
        .read_tree(&head_tree)
        .context("Failed to reset index to HEAD")?;
    index.write().context("Failed to write index")?;

    Ok(())
}

pub fn git_discard_file_changes(repo_path: String, file_path: String) -> Result<(), String> {
    _git_discard_file_changes(repo_path, file_path).into_string_error()
}

fn _git_discard_file_changes(repo_path: String, file_path: String) -> Result<()> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;

    let head = repo
        .head()
        .context("Failed to get HEAD")?
        .peel_to_tree()
        .context("Failed to get HEAD tree")?;

    let file_path = file_path.trim_end_matches('/').to_string();
    let mut checkout_opts = git2::build::CheckoutBuilder::new();
    // libgit2 pathspecs recurse into directories, so passing a folder path
    // reverts every tracked file under it. Untracked files are intentionally
    // left untouched, matching `git checkout -- <dir>` semantics.
    checkout_opts.force().update_index(true).path(&file_path);

    repo.checkout_tree(head.as_object(), Some(&mut checkout_opts))
        .context("Failed to checkout file")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;

    /// Create a repo with two commits and a working-tree modification.
    fn setup_repo(dir: &std::path::Path) -> Repository {
        let repo = Repository::init(dir).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();

        fs::create_dir_all(dir.join("src/components")).unwrap();
        fs::write(dir.join("src/components/button.tsx"), "v1\n").unwrap();
        fs::write(dir.join("src/index.tsx"), "v1\n").unwrap();

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
    fn discard_directory_reverts_nested_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path().to_string_lossy().to_string();
        setup_repo(dir.path());

        // Modify both a nested file and a sibling outside the target folder.
        fs::write(dir.path().join("src/components/button.tsx"), "v2\n").unwrap();
        fs::write(dir.path().join("src/index.tsx"), "v2\n").unwrap();

        _git_discard_file_changes(repo_path, "src/components".to_string()).unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("src/components/button.tsx")).unwrap(),
            "v1\n"
        );
        // The sibling outside the discarded folder must stay untouched.
        assert_eq!(
            fs::read_to_string(dir.path().join("src/index.tsx")).unwrap(),
            "v2\n"
        );
    }

    #[test]
    fn discard_directory_with_trailing_slash() {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path().to_string_lossy().to_string();
        setup_repo(dir.path());

        fs::write(dir.path().join("src/components/button.tsx"), "v2\n").unwrap();

        _git_discard_file_changes(repo_path, "src/components/".to_string()).unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("src/components/button.tsx")).unwrap(),
            "v1\n"
        );
    }
}
