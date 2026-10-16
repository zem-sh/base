use zem_addon_sdk::Action;

use crate::general::constants::CLOCK_ICON;
use crate::general::settings::Settings;
use crate::general::status;

/// Clicking cycles the clock colour and refreshes the time display.
pub fn server_time() -> Action {
    Action::new("server_time")
        .title("Server Time")
        .icon(CLOCK_ICON)
        .description("Current server time")
        .on_execute(|_req, ctx| {
            let ctx = ctx.clone();
            async move {
                let mut settings = Settings::load(&ctx).await;
                settings.cycle_time_color();
                settings.save(&ctx).await;
                status::update_time(&ctx).await;
                Ok(zem_addon_sdk::ActionExecuteResponse::default())
            }
        })
}
