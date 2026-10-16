use serde_json::{json, Value};
use starship_battery::units::{
    ratio::percent, thermodynamic_temperature::degree_celsius, time::second,
};
use std::sync::OnceLock;

static MANAGER: OnceLock<Option<starship_battery::Manager>> = OnceLock::new();

fn get_manager() -> Option<&'static starship_battery::Manager> {
    MANAGER
        .get_or_init(|| starship_battery::Manager::new().ok())
        .as_ref()
}

pub fn stats() -> Value {
    let Some(manager) = get_manager() else {
        return json!({ "has_battery": false });
    };
    let Ok(batteries) = manager.batteries() else {
        return json!({ "has_battery": false });
    };

    for maybe_battery in batteries {
        let Ok(batt) = maybe_battery else { continue };

        let state = match batt.state() {
            starship_battery::State::Charging => "Charging",
            starship_battery::State::Discharging => "Discharging",
            starship_battery::State::Empty => "Empty",
            starship_battery::State::Full => "Full",
            _ => "Unknown",
        };

        return json!({
            "has_battery": true,
            "percent": batt.state_of_charge().get::<percent>(),
            "state": state,
            "vendor": batt.vendor().unwrap_or("Unknown"),
            "model": batt.model().unwrap_or("Unknown"),
            "time_to_full": batt.time_to_full().map(|t| t.get::<second>() as u64).unwrap_or(0),
            "time_to_empty": batt.time_to_empty().map(|t| t.get::<second>() as u64).unwrap_or(0),
            "cycle_count": batt.cycle_count(),
            "temperature": batt.temperature().map(|t| t.get::<degree_celsius>() as f64),
        });
    }

    json!({ "has_battery": false })
}
