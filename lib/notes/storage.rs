use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zem_addon_sdk::AddonContext;

const DATA_KEY: &str = "notes";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub name: String,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// `workspace` (visible across the workspace) or `project` (visible only
    /// in the project it was created in). Only database notes carry a scope.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// Notes stored before scopes existed default to workspace scope so they stay
/// visible everywhere — the safe, non-destructive choice for existing data.
fn default_scope() -> String {
    "workspace".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DbNote {
    id: String,
    name: String,
    content: String,
    updated_at: i64,
    #[serde(default = "default_scope")]
    scope: String,
    #[serde(default)]
    project_id: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DbStore {
    workspaces: HashMap<String, Vec<DbNote>>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn workspace_key(payload: &Value) -> String {
    payload
        .get("workspace_id")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .to_string()
}

/// The numeric workspace id from a request payload (the host injects it into
/// pane operations). 0 when absent.
pub fn workspace_id(payload: &Value) -> i32 {
    payload
        .get("workspace_id")
        .and_then(Value::as_i64)
        .unwrap_or(0) as i32
}

pub fn project_id(payload: &Value) -> i64 {
    payload
        .get("project_id")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// A note is visible to the current view when it is workspace-scoped or when
/// it is project-scoped and belongs to the current project.
fn note_visible(note: &DbNote, current_project: i64) -> bool {
    note.scope == "workspace" || (note.scope == "project" && note.project_id == current_project)
}

fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut last_sep = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            if last_sep && !out.is_empty() {
                out.push('-');
            }
            out.push(ch);
            last_sep = false;
        } else {
            last_sep = true;
        }
    }
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

/// First free id for a brand-new note: the slugified name, then `-2`, `-3`, …
/// so a new note never overwrites an existing one that shares its name.
fn unique_id(notes: &[DbNote], base: &str) -> String {
    if !notes.iter().any(|note| note.id == base) {
        return base.to_string();
    }
    let mut counter = 2;
    loop {
        let candidate = format!("{base}-{counter}");
        if !notes.iter().any(|note| note.id == candidate) {
            return candidate;
        }
        counter += 1;
    }
}

async fn load_db(ctx: &AddonContext) -> Result<DbStore, String> {
    let data = ctx
        .get_global_data(DATA_KEY)
        .await
        .map_err(|e| e.to_string())?;
    if data.is_empty() {
        return Ok(DbStore::default());
    }
    serde_json::from_slice(&data).map_err(|e| format!("invalid notes database: {e}"))
}

async fn persist_db(ctx: &AddonContext, store: &DbStore) -> Result<(), String> {
    let data = serde_json::to_vec(store).map_err(|e| e.to_string())?;
    ctx.set_global_data(DATA_KEY, &data)
        .await
        .map_err(|e| e.to_string())
}

fn normalized_link_target(value: &str) -> String {
    value
        .trim()
        .trim_matches(['<', '>', '"', '\''])
        .split('#')
        .next()
        .unwrap_or("")
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_end_matches(".md")
        .to_lowercase()
}

fn links_to(content: &str, note_name: &str, note_path: &str) -> bool {
    let targets = [
        normalized_link_target(note_name),
        normalized_link_target(note_path),
        Path::new(note_path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(normalized_link_target)
            .unwrap_or_default(),
    ];
    let matches_target = |raw: &str| {
        let target = normalized_link_target(raw.split('|').next().unwrap_or(raw));
        !target.is_empty() && targets.iter().any(|candidate| candidate == &target)
    };

    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let after_start = &rest[start + 2..];
        if let Some(end) = after_start.find("]]") {
            if matches_target(&after_start[..end]) {
                return true;
            }
            rest = &after_start[end + 2..];
        } else {
            break;
        }
    }

    let mut rest = content;
    while let Some(start) = rest.find("](") {
        let after_start = &rest[start + 2..];
        if let Some(end) = after_start.find(')') {
            if matches_target(after_start[..end].trim()) {
                return true;
            }
            rest = &after_start[end + 1..];
        } else {
            break;
        }
    }
    false
}

fn db_backlinks(
    store: &DbStore,
    workspace: &str,
    id: &str,
    name: &str,
    current_project: i64,
) -> usize {
    store
        .workspaces
        .get(workspace)
        .into_iter()
        .flatten()
        .filter(|note| {
            note.id != id
                && note_visible(note, current_project)
                && links_to(&note.content, name, id)
        })
        .count()
}
fn disk_backlinks(directory: &str, current_path: &Path, name: &str) -> Result<usize, String> {
    fn scan(
        directory: &Path,
        current_path: &Path,
        name: &str,
        count: &mut usize,
    ) -> Result<(), String> {
        for entry in std::fs::read_dir(directory)
            .map_err(|e| format!("cannot read directory {}: {e}", directory.display()))?
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_dir() {
                scan(&path, current_path, name, count)?;
                continue;
            }
            if !file_type.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("md")
                || path == current_path
            {
                continue;
            }
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            let target = current_path
                .strip_prefix(directory)
                .unwrap_or(current_path)
                .to_string_lossy();
            if links_to(&content, name, &target) {
                *count += 1;
            }
        }
        Ok(())
    }

    let mut count = 0;
    scan(Path::new(directory), current_path, name, &mut count)?;
    Ok(count)
}

pub async fn delete_db(ctx: &AddonContext, payload: &Value) -> Result<Value, String> {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if id.is_empty() {
        return Err("note id is required".to_string());
    }
    let mut store = load_db(ctx).await?;
    let workspace = workspace_key(payload);
    if let Some(notes) = store.workspaces.get_mut(&workspace) {
        notes.retain(|note| note.id != id);
    }
    persist_db(ctx, &store).await?;
    Ok(serde_json::json!({ "deleted": true }))
}

pub async fn rename_db(ctx: &AddonContext, payload: &Value) -> Result<Value, String> {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() || name.is_empty() {
        return Err("id and name are required".to_string());
    }
    let mut store = load_db(ctx).await?;
    let workspace = workspace_key(payload);
    let note = store
        .workspaces
        .get_mut(&workspace)
        .and_then(|notes| notes.iter_mut().find(|note| note.id == id))
        .ok_or_else(|| format!("note not found: {id}"))?;
    note.name = name.clone();
    // Scope can change during an edit (e.g. promote a project note to the whole
    // workspace). It is optional and validated; the project stays untouched.
    if let Some(scope) = payload.get("scope").and_then(Value::as_str) {
        if scope == "workspace" || scope == "project" {
            note.scope = scope.to_string();
        }
    }
    note.updated_at = now();
    let scope = note.scope.clone();
    persist_db(ctx, &store).await?;
    let backlinks = db_backlinks(&store, &workspace, &id, &name, project_id(payload));
    Ok(serde_json::json!({
        "id": id,
        "name": name,
        "updated_at": now(),
        "backlinks": backlinks,
        "scope": scope,
    }))
}

pub async fn list_db(ctx: &AddonContext, payload: &Value) -> Result<Vec<NoteSummary>, String> {
    let store = load_db(ctx).await?;
    // Show workspace-scoped notes plus project-scoped notes that belong to the
    // current project, so every project sees the shared workspace notes.
    let current_project = project_id(payload);
    Ok(store
        .workspaces
        .get(&workspace_key(payload))
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|note| note_visible(note, current_project))
        .map(|note| NoteSummary {
            id: note.id,
            name: note.name,
            updated_at: note.updated_at,
            path: None,
            scope: Some(note.scope.clone()),
        })
        .collect())
}

/// Every database note in a workspace, filtered to the notes visible to the
/// current project (workspace-scoped + project-scoped belonging to this project).
/// Used to build the `open_note` action's option list so the command palette
/// only surfaces notes the user can actually open.
pub async fn list_all_workspace(ctx: &AddonContext, workspace_id: i32, project_id: i64) -> Result<Vec<NoteSummary>, String> {
    let store = load_db(ctx).await?;
    Ok(store
        .workspaces
        .get(&workspace_id.to_string())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|note| note_visible(note, project_id))
        .map(|note| NoteSummary {
            id: note.id,
            name: note.name,
            updated_at: note.updated_at,
            path: None,
            scope: Some(note.scope.clone()),
        })
        .collect())
}

pub async fn read_db(ctx: &AddonContext, payload: &Value) -> Result<Value, String> {
    let store = load_db(ctx).await?;
    let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
    let workspace = workspace_key(payload);
    let current_project = project_id(payload);
    let note = store
        .workspaces
        .get(&workspace)
        .and_then(|notes| notes.iter().find(|note| note.id == id))
        .filter(|note| note_visible(note, current_project))
        .ok_or_else(|| format!("note not found: {id}"))?;
    let backlinks = db_backlinks(&store, &workspace, &note.id, &note.name, current_project);
    Ok(serde_json::json!({
        "id": note.id,
        "name": note.name,
        "content": note.content,
        "updated_at": note.updated_at,
        "backlinks": backlinks,
        "scope": note.scope,
    }))
}

pub async fn save_db(ctx: &AddonContext, payload: &Value) -> Result<Value, String> {
    let requested_id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let content = payload.get("content").and_then(Value::as_str).unwrap_or("");
    if name.is_empty() {
        return Err("name is required".to_string());
    }

    let mut store = load_db(ctx).await?;
    let workspace = workspace_key(payload);
    let notes = store.workspaces.entry(workspace.clone()).or_default();
    // A brand-new note (no client id yet) gets a unique id derived from its
    // name, so creating a new note never overwrites an existing one that
    // shares the same name. Existing notes keep their id and update in place.
    let id = if requested_id.is_empty() {
        unique_id(notes, &slugify(&name))
    } else {
        requested_id
    };
    // New notes are scoped to the current project by default (the pane picks
    // the scope; the project id is injected by the host). Existing notes keep
    // their scope and project when their content is updated.
    let scope = payload
        .get("scope")
        .and_then(Value::as_str)
        .filter(|s| *s == "workspace" || *s == "project")
        .unwrap_or("project")
        .to_string();
    let new_project_id = project_id(payload);
    let updated_at = now();
    if let Some(note) = notes.iter_mut().find(|note| note.id == id) {
        note.name = name.clone();
        note.content = content.to_string();
        note.updated_at = updated_at;
    } else {
        notes.push(DbNote {
            id: id.clone(),
            name: name.clone(),
            content: content.to_string(),
            updated_at,
            scope,
            project_id: new_project_id,
        });
    }
    persist_db(ctx, &store).await?;
    let backlinks = db_backlinks(&store, &workspace, &id, &name, project_id(payload));
    Ok(
        serde_json::json!({ "id": id, "name": name, "updated_at": updated_at, "backlinks": backlinks }),
    )
}

fn user_path(payload: &Value, directory: &str, path: Option<&str>) -> PathBuf {
    let candidate = path.filter(|path| !path.trim().is_empty()).unwrap_or("");
    if candidate.is_empty() {
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled");
        let filename = if name.ends_with(".md") {
            name.to_string()
        } else {
            format!("{name}.md")
        };
        Path::new(directory).join(filename)
    } else {
        let candidate_path = PathBuf::from(candidate);
        if candidate_path.is_absolute() {
            candidate_path
        } else {
            Path::new(directory).join(candidate_path)
        }
    }
}

fn ensure_inside_directory(directory: &str, path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("note path cannot contain parent-directory traversal".to_string());
    }
    let root = std::fs::canonicalize(directory)
        .map_err(|e| format!("invalid notes directory {}: {e}", directory))?;
    let parent = path.parent().unwrap_or(path);
    let resolved_parent = std::fs::canonicalize(parent)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default().join(parent));
    if !resolved_parent.starts_with(&root) {
        return Err("note path must remain inside the selected directory".to_string());
    }
    Ok(())
}

fn ensure_markdown(path: &Path) -> Result<(), String> {
    if path.extension().and_then(|v| v.to_str()) != Some("md") {
        return Err("notes must be Markdown files ending in .md".to_string());
    }
    Ok(())
}

async fn validate(ctx: &AddonContext, payload: &Value, path: &Path) -> Result<(), String> {
    let user_uuid = payload
        .get("user_uuid")
        .and_then(Value::as_str)
        .unwrap_or("");
    ctx.validate_path_access(&path.to_string_lossy(), user_uuid)
        .await
        .map_err(|e| e.to_string())
}

pub async fn list_disk(
    ctx: &AddonContext,
    payload: &Value,
    directory: &str,
) -> Result<Vec<NoteSummary>, String> {
    if directory.trim().is_empty() {
        return Err("a disk notes directory is required".to_string());
    }
    let dir = Path::new(directory);
    validate(ctx, payload, dir).await?;
    let mut notes = Vec::new();
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read directory {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("md") {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        notes.push(NoteSummary {
            id: path.to_string_lossy().to_string(),
            name: path
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("Untitled")
                .to_string(),
            updated_at: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            path: Some(path.to_string_lossy().to_string()),
            scope: None,
        });
    }
    notes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(notes)
}

pub async fn delete_disk(
    ctx: &AddonContext,
    payload: &Value,
    directory: &str,
) -> Result<Value, String> {
    if directory.trim().is_empty() {
        return Err("a disk notes directory is required".to_string());
    }
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if id.is_empty() {
        return Err("note id is required".to_string());
    }
    let path = user_path(payload, directory, Some(id));
    ensure_markdown(&path)?;
    ensure_inside_directory(directory, &path)?;
    validate(ctx, payload, &path).await?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("cannot delete {}: {e}", path.display()))?;
    }
    Ok(serde_json::json!({ "deleted": true }))
}

pub async fn rename_disk(
    ctx: &AddonContext,
    payload: &Value,
    directory: &str,
) -> Result<Value, String> {
    if directory.trim().is_empty() {
        return Err("a disk notes directory is required".to_string());
    }
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if id.is_empty() || name.is_empty() {
        return Err("id and name are required".to_string());
    }
    let old_path = user_path(payload, directory, Some(id));
    ensure_markdown(&old_path)?;
    ensure_inside_directory(directory, &old_path)?;
    validate(ctx, payload, &old_path).await?;
    // The new filename comes from the requested name (single filename only).
    let components: Vec<_> = Path::new(name).components().collect();
    if components.len() != 1 || !matches!(components.first(), Some(std::path::Component::Normal(_)))
    {
        return Err("a note name must be a single filename".to_string());
    }
    let filename = if name.ends_with(".md") {
        name.to_string()
    } else {
        format!("{name}.md")
    };
    let new_path = Path::new(directory).join(filename);
    if new_path != old_path {
        if new_path.exists() {
            return Err(format!("a note named {name} already exists"));
        }
        std::fs::rename(&old_path, &new_path)
            .map_err(|e| format!("cannot rename {}: {e}", old_path.display()))?;
    }
    let id = new_path.to_string_lossy().to_string();
    let stem = new_path
        .file_stem()
        .and_then(|v| v.to_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| name.to_string());
    let backlinks = disk_backlinks(directory, &new_path, &stem)?;
    Ok(serde_json::json!({
        "id": id,
        "name": stem,
        "updated_at": now(),
        "backlinks": backlinks,
        "path": id,
    }))
}

pub async fn read_disk(
    ctx: &AddonContext,
    payload: &Value,
    directory: &str,
) -> Result<Value, String> {
    if directory.trim().is_empty() {
        return Err("a disk notes directory is required".to_string());
    }
    let path = user_path(
        payload,
        directory,
        payload.get("path").and_then(Value::as_str),
    );
    ensure_markdown(&path)?;
    ensure_inside_directory(directory, &path)?;
    validate(ctx, payload, &path).await?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(serde_json::json!({
        "id": path.to_string_lossy(),
        "name": path.file_stem().and_then(|v| v.to_str()).unwrap_or("Untitled"),
        "content": content,
        "updated_at": now(),
        "backlinks": disk_backlinks(directory, &path, path.file_stem().and_then(|value| value.to_str()).unwrap_or("Untitled"))?,
        "path": path.to_string_lossy(),
    }))
}

pub async fn save_disk(
    ctx: &AddonContext,
    payload: &Value,
    directory: &str,
) -> Result<Value, String> {
    if directory.trim().is_empty() {
        return Err("a disk notes directory is required".to_string());
    }
    let requested_path = payload.get("path").and_then(Value::as_str);
    let is_new = requested_path
        .map(|value| value.trim().is_empty())
        .unwrap_or(true);
    if is_new {
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
        let components: Vec<_> = Path::new(name).components().collect();
        if components.len() != 1
            || !matches!(components.first(), Some(std::path::Component::Normal(_)))
        {
            return Err("a new disk note name must be a single filename".to_string());
        }
    }
    // A brand-new note (no path yet) gets the first free `<name>.md` filename,
    // so a new "Untitled" never overwrites an existing Untitled.md.
    let path = if is_new {
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled");
        let stem = name.trim_end_matches(".md");
        let mut filename = format!("{stem}.md");
        let mut counter = 2;
        while Path::new(directory).join(&filename).exists() {
            filename = format!("{stem}-{counter}.md");
            counter += 1;
        }
        Path::new(directory).join(filename)
    } else {
        user_path(payload, directory, requested_path)
    };
    ensure_markdown(&path)?;
    ensure_inside_directory(directory, &path)?;
    validate(ctx, payload, &path).await?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let content = payload.get("content").and_then(Value::as_str).unwrap_or("");
    std::fs::write(&path, content).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled");
    let backlinks = disk_backlinks(directory, &path, name)?;
    Ok(
        serde_json::json!({ "id": path.to_string_lossy(), "name": name, "updated_at": now(), "backlinks": backlinks, "path": path.to_string_lossy() }),
    )
}

pub fn directory(payload: &Value, cwd: &str) -> String {
    payload
        .get("directory")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(cwd)
        .to_string()
}
