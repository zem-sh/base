use serde_json::{json, Value};
use sysinfo::System;

pub fn stats(sys: &System) -> Value {
    let total = sys.total_memory();
    let used = sys.used_memory();
    let usage = if total > 0 {
        used as f64 / total as f64 * 100.0
    } else {
        0.0
    };

    json!({
        "total": total,
        "used": used,
        "free": sys.available_memory(),
        "usage": usage
    })
}
