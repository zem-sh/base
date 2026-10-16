use anyhow::Result;
use base64::{engine::general_purpose, Engine as _};
use git2::{Oid, Repository};

pub trait IntoStringError<T> {
    fn into_string_error(self) -> Result<T, String>;
}

impl<T> IntoStringError<T> for Result<T> {
    fn into_string_error(self) -> Result<T, String> {
        self.map_err(|e| format!("{:#}", e))
    }
}

pub fn is_image_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".bmp")
        || lower.ends_with(".svg")
        || lower.ends_with(".webp")
        || lower.ends_with(".ico")
        || lower.ends_with(".tiff")
        || lower.ends_with(".tif")
        || lower.ends_with(".avif")
        || lower.ends_with(".heic")
        || lower.ends_with(".heif")
        || lower.ends_with(".jfif")
        || lower.ends_with(".pjpeg")
        || lower.ends_with(".pjp")
        || lower.ends_with(".apng")
}

pub fn get_blob_base64(repo: &Repository, oid: Option<Oid>, _file_path: &str) -> Option<String> {
    if let Some(oid) = oid {
        if !oid.is_zero() {
            if let Ok(blob) = repo.find_blob(oid) {
                let data = blob.content();
                return Some(general_purpose::STANDARD.encode(data));
            }
        }
    }
    None
}

pub fn get_ahead_behind_counts(repo: &Repository, branch: &str) -> ((i32, i32), bool) {
    let local_branch = match repo.find_branch(branch, git2::BranchType::Local) {
        Ok(branch) => branch,
        Err(_) => return ((0, 0), false),
    };

    let upstream = match local_branch.upstream() {
        Ok(upstream) => upstream,
        Err(_) => return ((0, 0), false),
    };

    let local_oid = match local_branch.get().target() {
        Some(oid) => oid,
        None => return ((0, 0), true),
    };

    let upstream_oid = match upstream.get().target() {
        Some(oid) => oid,
        None => return ((0, 0), true),
    };

    match repo.graph_ahead_behind(local_oid, upstream_oid) {
        Ok((ahead, behind)) => ((ahead as i32, behind as i32), true),
        Err(_) => ((0, 0), true),
    }
}
