mod battery;
mod cpu;
mod disk;
mod gpu;
mod memory;
mod network;

pub use network::Tracker;

pub struct State {
    pub system: std::sync::Arc<tokio::sync::Mutex<sysinfo::System>>,
    pub net: std::sync::Arc<tokio::sync::Mutex<Tracker>>,
}

impl State {
    pub fn new() -> Self {
        Self {
            system: std::sync::Arc::new(tokio::sync::Mutex::new(sysinfo::System::new_all())),
            net: std::sync::Arc::new(tokio::sync::Mutex::new(Tracker::new())),
        }
    }

    pub async fn get_stats(&self) -> serde_json::Value {
        use serde_json::json;

        let sys = self.system.lock().await;
        let cpu = cpu::stats(&sys).await;
        let mem = memory::stats(&sys);
        drop(sys);

        let net = self.net.clone();
        let (gpu, disk, net_stats, battery, load) = tokio::join!(
            gpu::stats(),
            tokio::task::spawn_blocking(disk::stats),
            tokio::task::spawn_blocking(move || {
                let mut tracker = net.blocking_lock();
                tracker.stats()
            }),
            tokio::task::spawn_blocking(battery::stats),
            tokio::task::spawn_blocking(cpu::load),
        );

        json!({
            "success": true,
            "data": {
                "cpu": cpu,
                "memory": mem,
                "disk": disk.unwrap_or(json!(null)),
                "network": net_stats.unwrap_or(json!(null)),
                "gpu": gpu,
                "battery": battery.unwrap_or(json!({ "has_battery": false })),
                "load": load.unwrap_or(json!({ "one": 0, "five": 0, "fifteen": 0 })),
                "uptime": sysinfo::System::uptime()
            }
        })
    }
}
