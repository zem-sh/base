use serde_json::{json, Value};
use sysinfo::System;

pub async fn stats(sys: &System) -> Value {
    let temp = tokio::task::spawn_blocking(|| {
        sysinfo::Components::new_with_refreshed_list()
            .iter()
            .find_map(|c| {
                let label = c.label().to_lowercase();
                if label.contains("cpu") || label.contains("core") || label.contains("temp") {
                    c.temperature().map(|t| t as f64)
                } else {
                    None
                }
            })
    })
    .await
    .unwrap_or(None);

    json!({
        "usage": sys.global_cpu_usage(),
        "cores": sys.cpus().len(),
        "per_core": sys.cpus().iter().map(|c| c.cpu_usage()).collect::<Vec<f32>>(),
        "temp": temp
    })
}

pub fn load() -> Value {
    let avg = System::load_average();
    json!({ "one": avg.one, "five": avg.five, "fifteen": avg.fifteen })
}
