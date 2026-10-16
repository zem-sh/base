mod mutations;
mod queries;

use zem_addon_sdk::Pane;

/// Build the explorer pane with all queries and mutations.
pub fn explorer_pane() -> Pane {
    let pane = Pane::new("explorer").icon("nerd:folder-open");
    let pane = queries::register(pane);
    mutations::register(pane)
}
