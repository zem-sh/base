use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: i32,
    pub behind: i32,
    pub has_upstream: bool,
    pub files: Vec<GitFile>,
    pub tree: Vec<GitFileNode>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflict,
}

#[derive(Serialize)]
pub struct GitFile {
    pub path: String,
    pub status: FileStatus,
    pub staged: bool,
}

/// A node in the nested file-system view of the working tree changes.
/// Directories are non-leaf nodes (with `is_dir: true`, no `status`); files
/// are leaves carrying their change status.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub status: Option<FileStatus>,
    pub staged: bool,
    pub children: Vec<GitFileNode>,
}

#[derive(Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub message: String,
    pub description: Option<String>,
    pub author: String,
    pub email: String,
    pub date: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineType {
    Added,
    Removed,
    Context,
    Header,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GitDiffLine {
    pub line_type: DiffLineType,
    pub content: String,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub file_path: String,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub is_new: bool,
    pub is_deleted: bool,
    pub is_renamed: bool,
    pub is_binary: bool,
    pub is_image: bool,
    pub old_blob_base64: Option<String>,
    pub new_blob_base64: Option<String>,
    pub lines: Vec<GitDiffLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_patch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_truncated: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffStat {
    pub file_path: String,
    pub staged: bool,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileContents {
    /// Content of the "old" side of the diff (HEAD for staged, index for
    /// unstaged). `None` when the file has no old side (e.g. brand new files).
    pub old: Option<String>,
    /// Content of the "new" side (index for staged, workdir for unstaged).
    /// `None` when the file has been deleted.
    pub new: Option<String>,
}

#[derive(Serialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct GitBranchInfo {
    pub name: String,
    pub current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking: Option<String>,
}

#[derive(Serialize)]
pub struct GitStash {
    pub index: usize,
    pub message: String,
    pub date: String,
}
