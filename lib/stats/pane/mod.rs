mod mutations;
mod queries;

use std::sync::Arc;

use zem_addon_sdk::Pane;

use crate::stats::stats;

/// Build the stats pane with all queries and mutations.
pub fn stats_pane(state: Arc<stats::State>) -> Pane {
    let pane = Pane::new("stats").icon("nerd:chart-line");
    let pane = queries::register(pane, state.clone());
    mutations::register(pane, state)
}
