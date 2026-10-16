mod mutations;

use zem_addon_sdk::Pane;

use crate::terminal::session::SessionManager;

/// Build the terminal pane with all lifecycle hooks and mutations.
pub fn terminal_pane(mgr: SessionManager) -> Pane {
    // No default collection: plain terminal panes are not Agents members.
    // The pane joins the Agents collection dynamically while the agent
    // detector finds a coding agent running in the PTY (host rule on
    // `extra.agent`).
    let pane = Pane::new("terminal").icon("nerd:terminal");

    let pane = pane
        .on_create({
            let mgr = mgr.clone();
            move |pane_id, cwd, extra, _ctx| {
                let mgr = mgr.clone();
                let cwd = cwd.to_string();
                let extra = extra.clone();
                async move {
                    mgr.create_or_attach(pane_id, &cwd, &extra)
                        .await
                        .map_err(zem_addon_sdk::AddonError::internal)
                }
            }
        })
        .on_destroy({
            let mgr = mgr.clone();
            move |pane_id, reason, _ctx| {
                let mgr = mgr.clone();
                let reason = reason.to_string();
                async move {
                    mgr.destroy(pane_id, &reason).await;
                    Ok(())
                }
            }
        })
        .on_resize({
            let mgr = mgr.clone();
            move |pane_id, cols, rows, width_px, height_px, _ctx| {
                let mgr = mgr.clone();
                async move {
                    mgr.resize(pane_id, cols, rows, width_px, height_px).await;
                    Ok(())
                }
            }
        })
        .subscribe_output({
            let mgr = mgr.clone();
            move |pane_id, _ctx| {
                let mgr = mgr.clone();
                async move {
                    mgr.subscribe(pane_id)
                        .await
                        .map_err(zem_addon_sdk::AddonError::internal)
                }
            }
        });

    mutations::register(pane, mgr)
}
