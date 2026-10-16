mod mutations;
mod queries;

use zem_addon_sdk::Pane;

pub fn notes_pane() -> Pane {
    let pane = Pane::new("notes").icon("nerd:note-sticky");
    let pane = queries::register(pane);
    mutations::register(pane)
}
