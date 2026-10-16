use serde_json::{json, Value};
use sysinfo::Disks;

pub fn stats() -> Value {
    Disks::new_with_refreshed_list()
        .iter()
        .next()
        .map(|d| {
            let total = d.total_space();
            let available = d.available_space();
            let used = total - available;
            let usage = if total > 0 { used as f64 / total as f64 * 100.0 } else { 0.0 };
            json!({ "total": total, "used": used, "free": available, "usage": usage, "mount": d.name().to_string_lossy() })
        })
        .unwrap_or(json!(null))
}
