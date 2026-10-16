use crate::version_control::git::{GitBranchInfo, IntoStringError};
use anyhow::{Context, Result};
use git2::{BranchType, Repository};

pub fn git_branches(repo_path: String) -> Result<Vec<GitBranchInfo>, String> {
    _git_branches(repo_path).into_string_error()
}

fn _git_branches(repo_path: String) -> Result<Vec<GitBranchInfo>> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;
    let current = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(str::to_string))
        .unwrap_or_default();

    let branches = repo
        .branches(Some(BranchType::Local))
        .context("Failed to list branches")?;

    let mut branch_infos = Vec::new();
    for branch in branches {
        let (branch, _) = branch.context("Failed to get branch")?;
        let name = branch
            .name()
            .context("Failed to get branch name")?
            .ok_or_else(|| anyhow::anyhow!("branch has no name"))?
            .to_string();
        let tracking = branch
            .upstream()
            .ok()
            .and_then(|u| u.name().ok().flatten().map(str::to_string));
        branch_infos.push(GitBranchInfo {
            current: name == current,
            name,
            tracking,
        });
    }
    Ok(branch_infos)
}

pub fn git_checkout(repo_path: String, branch_name: String) -> Result<String, String> {
    _git_checkout(repo_path, branch_name).into_string_error()
}

fn _git_checkout(repo_path: String, branch_name: String) -> Result<String> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;

    let obj = repo
        .revparse_single(&format!("refs/heads/{}", branch_name))
        .context("Failed to find branch")?;

    repo.checkout_tree(&obj, None)
        .context("Failed to checkout branch")?;

    repo.set_head(&format!("refs/heads/{}", branch_name))
        .context("Failed to update HEAD")?;

    Ok(format!("Switched to branch '{}'", branch_name))
}

pub fn git_create_branch(
    repo_path: String,
    branch_name: String,
    from_branch: Option<String>,
) -> Result<(), String> {
    _git_create_branch(repo_path, branch_name, from_branch).into_string_error()
}

fn _git_create_branch(
    repo_path: String,
    branch_name: String,
    from_branch: Option<String>,
) -> Result<()> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;

    let target = if let Some(from) = from_branch {
        repo.revparse_single(&from)
            .context("Failed to find source branch")?
            .peel_to_commit()
            .context("Failed to peel to commit")?
    } else {
        repo.head()
            .context("Failed to get HEAD")?
            .peel_to_commit()
            .context("Failed to peel HEAD to commit")?
    };

    let branch = repo
        .branch(&branch_name, &target, false)
        .context("Failed to create branch")?;

    let refname = branch
        .get()
        .name()
        .context("Failed to get branch reference name")?;

    repo.set_head(refname)
        .context("Failed to set HEAD to new branch")?;

    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
        .context("Failed to checkout new branch")?;

    Ok(())
}

pub fn git_delete_branch(repo_path: String, branch_name: String) -> Result<(), String> {
    _git_delete_branch(repo_path, branch_name).into_string_error()
}

fn _git_delete_branch(repo_path: String, branch_name: String) -> Result<()> {
    let repo = Repository::open(&repo_path).context("Failed to open repository")?;

    let mut branch = repo
        .find_branch(&branch_name, BranchType::Local)
        .context("Failed to find branch")?;

    branch.delete().context("Failed to delete branch")?;

    Ok(())
}
