//! Renders and pushes the time and date status bar items.

use std::time::Duration;

use chrono::Local;
use serde_json::json;
use zem_addon_sdk::AddonContext;

use crate::general::constants::{
    CALENDAR_ICON, CLOCK_ICON, CWD_COLOR, DATE_COLOR, DATE_FORMAT_OPTIONS, FOLDER_ICON,
    REFRESH_INTERVAL_SECS,
};
use crate::general::settings::Settings;

/// Re-render the time and date status bar items from the current settings.
/// The `current_dir` item is updated separately via `update_cwd`.
pub async fn refresh_all(ctx: &AddonContext) {
    update_time(ctx).await;
    update_date(ctx).await;
}

/// Push the current working directory to the `current_dir` status item.
/// `workspace_id` scopes the action so each workspace shows its own project CWD.
pub async fn update_cwd(ctx: &AddonContext, cwd: &str, workspace_id: i32) {
    let (display, color) = if cwd.is_empty() {
        ("no project".to_string(), CWD_COLOR)
    } else {
        (shorten_path(cwd), CWD_COLOR)
    };

    let view = json!({
        "view": [
            {"type": "icon", "value": FOLDER_ICON, "color": color},
            {"type": "text", "value": display, "color": color}
        ]
    });
    let _ = ctx.set_action("current_dir", workspace_id, &view).await;
}

/// Shorten a path for the status bar: keep the head and tail, collapse the
/// middle with an ellipsis when the path is too long to fit.
fn shorten_path(path: &str) -> String {
    const MAX_LEN: usize = 32;
    if path.chars().count() <= MAX_LEN {
        return path.to_string();
    }
    // Keep enough of the tail for the project/folder name, and a hint of the root.
    let tail_len = 14;
    let head_len = MAX_LEN - tail_len - 1; // room for the ellipsis
    let head: String = path.chars().take(head_len).collect();
    let tail: String = path.chars().skip(path.chars().count() - tail_len).collect();
    format!("{}…{}", head, tail)
}

/// Push the current time to the `server_time` status item.
pub async fn update_time(ctx: &AddonContext) {
    let settings = Settings::load(ctx).await;

    let now = Local::now();
    let time_str = if settings.uses_12h_clock() {
        now.format("%I:%M %p").to_string()
    } else {
        now.format("%H:%M").to_string()
    };
    let color = settings.time_color();

    let view = json!({
        "view": [
            {"type": "icon", "value": CLOCK_ICON, "color": color},
            {"type": "text", "value": time_str, "color": color}
        ],
        "action": {"type": "click", "command": "server_time"}
    });
    let _ = ctx.set_action("server_time", 0, &view).await;
}

/// Push the current date to the `server_date` status item.
pub async fn update_date(ctx: &AddonContext) {
    let settings = Settings::load(ctx).await;

    let now = Local::now();
    let date_str = match settings.date_format.as_str() {
        "short" => now.format("%m/%d").to_string(),
        "iso" => now.format("%Y-%m-%d").to_string(),
        _ => now.format("%Y-%m-%d (%A)").to_string(),
    };

    let options: Vec<_> = DATE_FORMAT_OPTIONS
        .iter()
        .map(|(value, label)| json!({"value": value, "label": label}))
        .collect();

    let view = json!({
        "view": [
            {"type": "icon", "value": CALENDAR_ICON, "color": DATE_COLOR},
            {"type": "text", "value": date_str, "color": DATE_COLOR}
        ],
        "action": {
            "type": "select",
            "command": "server_date",
            "current_value": settings.date_format,
            "options": options
        }
    });
    let _ = ctx.set_action("server_date", 0, &view).await;
}

/// Keep the clock fresh by re-rendering it every [`REFRESH_INTERVAL_SECS`].
pub fn spawn_refresh_task(ctx: AddonContext) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(REFRESH_INTERVAL_SECS));
        interval.tick().await;
        loop {
            interval.tick().await;
            update_time(&ctx).await;
        }
    });
}
