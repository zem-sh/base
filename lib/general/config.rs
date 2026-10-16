//! Declarative configuration schema surfaced in the settings UI.

use zem_addon_sdk::ConfigField;

use crate::general::constants::{DATE_FORMAT_OPTIONS, TIME_FORMAT_OPTIONS};

/// The `time_format` setting (24h or 12h).
pub fn time_format_field() -> ConfigField {
    field_with_choices(
        ConfigField::new("time_format")
            .label("Time Format")
            .field_type("string")
            .default("24h")
            .description("Choose between 12h and 24h time format"),
        TIME_FORMAT_OPTIONS,
    )
}

/// The `date_format` setting (long, short, or iso).
pub fn date_format_field() -> ConfigField {
    field_with_choices(
        ConfigField::new("date_format")
            .label("Date Format")
            .field_type("string")
            .default("long")
            .description("Choose date format"),
        DATE_FORMAT_OPTIONS,
    )
}

/// Attach `(value, label)` choices to a config field.
fn field_with_choices(field: ConfigField, options: &[(&str, &str)]) -> ConfigField {
    options
        .iter()
        .fold(field, |field, (value, label)| field.choice(value, label))
}
