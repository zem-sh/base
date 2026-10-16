use zem_addon_sdk::Action;

use crate::general::constants::FOLDER_ICON;

/// Current working directory of the focused project — read-only display item.
///
/// Defaults to the left side of the status bar; the user can move or hide it
/// from the admin action panel.
pub fn current_dir() -> Action {
    Action::new("current_dir")
        .read_only()
        .location("statusbar-left")
        .title("Current Directory")
        .icon(FOLDER_ICON)
        .description("Current working directory of the focused project")
}
