use serde_json::{json, Value};
use sysinfo::Networks;

pub struct Tracker {
    bytes_sent: u64,
    bytes_recv: u64,
    timestamp: std::time::Instant,
}

impl Tracker {
    pub fn new() -> Self {
        Self {
            bytes_sent: 0,
            bytes_recv: 0,
            timestamp: std::time::Instant::now(),
        }
    }

    pub fn stats(&mut self) -> Value {
        let networks = Networks::new_with_refreshed_list();
        let (total_sent, total_recv): (u64, u64) = networks
            .values()
            .map(|n| (n.total_transmitted(), n.total_received()))
            .fold((0, 0), |(acc_s, acc_r), (s, r)| (acc_s + s, acc_r + r));

        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.timestamp).as_secs_f64();
        let (upload, download) = if elapsed > 0.0 {
            (
                ((total_sent.saturating_sub(self.bytes_sent)) as f64 / elapsed) as u64,
                ((total_recv.saturating_sub(self.bytes_recv)) as f64 / elapsed) as u64,
            )
        } else {
            (0, 0)
        };
        *self = Tracker {
            bytes_sent: total_sent,
            bytes_recv: total_recv,
            timestamp: now,
        };

        json!({ "bytes_sent": upload, "bytes_recv": download })
    }
}
