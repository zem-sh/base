//! Shared constants and option lists for the general addon.

/// Icon used by the time status item.
pub const CLOCK_ICON: &str = "nerd:clock";

/// Icon used by the date status item.
pub const CALENDAR_ICON: &str = "nerd:calendar";

/// Icon used by the current directory status item.
pub const FOLDER_ICON: &str = "nerd:folder";

/// Color used by the current directory status item.
pub const CWD_COLOR: &str = "#888";

/// Color used by the date status item.
pub const DATE_COLOR: &str = "#888";

/// Seconds between automatic clock refreshes.
pub const REFRESH_INTERVAL_SECS: u64 = 60;

/// Default time format when none is configured.
pub const DEFAULT_TIME_FORMAT: &str = "24h";

/// Default date format when none is configured.
pub const DEFAULT_DATE_FORMAT: &str = "long";

/// Colors cycled by clicking the time status item.
pub const TIME_COLORS: &[&str] = &[
    "#10B981", // green
    "#F59E0B", // yellow
    "#6B7280", // gray
    "#EF4444", // red
    "#8B5CF6", // purple
    "#EC4899", // pink
    "#06B6D4", // cyan
];

/// Time format options as `(value, label)` pairs.
pub const TIME_FORMAT_OPTIONS: &[(&str, &str)] = &[("24h", "24 Hour"), ("12h", "12 Hour (AM/PM)")];

/// Date format options as `(value, label)` pairs.
pub const DATE_FORMAT_OPTIONS: &[(&str, &str)] = &[
    ("long", "Long (2024-01-20 Saturday)"),
    ("short", "Short (01/20)"),
    ("iso", "ISO (2024-01-20)"),
];
