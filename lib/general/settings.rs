//! Typed access to the addon's persisted settings.

use serde_json::json;
use zem_addon_sdk::AddonContext;

use crate::general::constants::{DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, TIME_COLORS};

/// The settings the addon persists and reads on every update.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Time format: `"24h"` or `"12h"`.
    pub time_format: String,
    /// Date format: `"long"`, `"short"`, or `"iso"`.
    pub date_format: String,
    /// Index into [`TIME_COLORS`](crate::general::constants::TIME_COLORS) for the clock.
    pub time_color_index: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            time_format: DEFAULT_TIME_FORMAT.to_string(),
            date_format: DEFAULT_DATE_FORMAT.to_string(),
            time_color_index: 0,
        }
    }
}

impl Settings {
    /// Load persisted settings, falling back to defaults for missing values.
    pub async fn load(ctx: &AddonContext) -> Self {
        let value = ctx.get_settings().await.unwrap_or_else(|_| json!({}));
        Self {
            time_format: value
                .get("time_format")
                .and_then(|v| v.as_str())
                .unwrap_or(DEFAULT_TIME_FORMAT)
                .to_string(),
            date_format: value
                .get("date_format")
                .and_then(|v| v.as_str())
                .unwrap_or(DEFAULT_DATE_FORMAT)
                .to_string(),
            time_color_index: value
                .get("time_color_index")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize,
        }
    }

    /// Persist the current settings back to addon data.
    pub async fn save(&self, ctx: &AddonContext) {
        let value = json!({
            "time_format": self.time_format,
            "date_format": self.date_format,
            "time_color_index": self.time_color_index,
        });
        let _ = ctx.set_settings(&value).await;
    }

    /// Whether the clock should render in 12-hour (AM/PM) format.
    pub fn uses_12h_clock(&self) -> bool {
        self.time_format == "12h"
    }

    /// The color for the clock, always normalized to a valid index.
    pub fn time_color(&self) -> &'static str {
        TIME_COLORS[self.time_color_index % TIME_COLORS.len()]
    }

    /// Advance the clock color to the next one in the palette.
    pub fn cycle_time_color(&mut self) -> &'static str {
        self.time_color_index = (self.time_color_index + 1) % TIME_COLORS.len();
        self.time_color()
    }
}
