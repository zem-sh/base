use zem_addon_sdk::Action;

use crate::general::constants::{CALENDAR_ICON, DEFAULT_DATE_FORMAT};
use crate::general::settings::Settings;
use crate::general::status;

/// Allows picking a date format and refreshes the date display.
pub fn server_date() -> Action {
    Action::new("server_date")
        .title("Server Date")
        .icon(CALENDAR_ICON)
        .description("Current server date")
        .on_execute(|req, ctx| {
            let ctx = ctx.clone();
            let format = req
                .payload
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or(DEFAULT_DATE_FORMAT)
                .to_string();
            async move {
                let mut settings = Settings::load(&ctx).await;
                settings.date_format = format.clone();
                settings.save(&ctx).await;
                status::update_date(&ctx).await;
                Ok(zem_addon_sdk::ActionExecuteResponse::default())
            }
        })
}
