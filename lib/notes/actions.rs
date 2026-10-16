use serde_json::json;

use zem_addon_sdk::{Action, ActionExecuteResponse, AddonContext, AddonError};

/// Sentinel option in the `open_note` list-select that starts a brand-new
/// note instead of opening an existing one.
const NEW_NOTE_VALUE: &str = "__new__";

/// "Open Note" — a list-select action whose options are every saved database
/// note in the workspace, plus a "Create New" entry. It surfaces in the
/// command palette (one palette item per note) and, once placed, as a dropdown
/// in the status bar. Executing opens a notes pane focused on the selected
/// note, or a fresh compose form when the create-new entry is picked.
pub fn open_note() -> Action {
    Action::new("open_note")
        .read_only()
        .title("Open Note")
        .icon("nerd:note-sticky")
        .description("Open a saved note")
        .location("statusbar-right")
        .on_execute(|req, _ctx| {
            let payload = req.payload.clone();
            async move {
                let id = payload
                    .get("format")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if id.is_empty() {
                    return Err(AddonError::invalid_payload("note id is required"));
                }
                if id == NEW_NOTE_VALUE {
                    // Open a notes pane straight into the "New Note" compose
                    // form (no note id → the pane starts composing).
                    return Ok(ActionExecuteResponse::open_pane_with_params(
                        "notes",
                        json!({
                            "notes": {
                                "storage": "database",
                                "noteId": "",
                                "noteName": "Untitled",
                                "compose": true,
                            }
                        }),
                    ));
                }
                let name = payload
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Ok(ActionExecuteResponse::open_pane_with_params(
                    "notes",
                    json!({
                        "notes": {
                            "storage": "database",
                            "noteId": id,
                            "noteName": name,
                        }
                    }),
                ))
            }
        })
}

/// Push the workspace's saved-note list into the `open_note` select action.
/// Called on focus/cwd changes and after every mutation that alters the list.
pub async fn refresh_list(ctx: &AddonContext, workspace_id: i32, project_id: i64) {
    let notes = match crate::notes::storage::list_all_workspace(ctx, workspace_id, project_id).await {
        Ok(notes) => notes,
        Err(_) => return,
    };
    let mut options: Vec<serde_json::Value> = vec![json!({
        "value": NEW_NOTE_VALUE,
        "label": "Create New Note"
    })];
    options.extend(notes.iter().map(|note| json!({ "value": note.id, "label": note.name })));
    let _ = ctx
        .set_action(
            "open_note",
            workspace_id,
            &json!({
                "view": [
                    { "type": "icon", "value": "nerd:note-sticky" },
                    { "type": "text", "value": "Open note" }
                ],
                "action": {
                    "type": "select",
                    "command": "open_note",
                    "current_value": "",
                    "options": options
                }
            }),
        )
        .await;
}
