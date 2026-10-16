use serde_json::{json, Value};

pub async fn stats() -> Value {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            macos_stats()
        }
        #[cfg(target_os = "linux")]
        {
            linux_stats()
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            json!(null)
        }
    })
    .await
    .unwrap_or(json!(null))
}

#[cfg(target_os = "macos")]
fn macos_stats() -> Value {
    let output = std::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let parsed: Value = serde_json::from_str(&output).unwrap_or(json!({}));

    let gpu = parsed["SPDisplaysDataType"]
        .as_array()
        .and_then(|a| a.first());

    let model = gpu
        .and_then(|g| g["sppci_model"].as_str().or_else(|| g["_name"].as_str()))
        .unwrap_or("Unknown GPU")
        .to_string();

    let vram = gpu
        .and_then(|g| g["spdisplays_vram"].as_str())
        .unwrap_or("Unknown")
        .to_string();

    let temp = gpu.and_then(|g| g["spdisplays_temperature"].as_f64());

    json!({
        "model": model,
        "vram": vram,
        "utilization": macos_utilization(),
        "temperature": temp
    })
}

#[cfg(target_os = "macos")]
fn macos_utilization() -> Option<f64> {
    let output = std::process::Command::new("ioreg")
        .args(["-l", "-w", "0"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    output.lines().find_map(|line| {
        if !line.contains("PerformanceStatistics") || !line.contains("Device Utilization %") {
            return None;
        }
        let pos = line.find("\"Device Utilization %\"=")?;
        let rest = &line[pos + "\"Device Utilization %\"=".len()..];
        let val: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        val.parse::<f64>().ok()
    })
}

#[cfg(target_os = "linux")]
fn linux_stats() -> Value {
    let mut model = "Unknown GPU".to_string();
    let mut vram = "Unknown".to_string();

    if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.starts_with("card") || name_str.contains("-") {
                continue;
            }

            let device_path = entry.path().join("device");
            if let Ok(vendor_bytes) = std::fs::read(device_path.join("vendor")) {
                let vendor = String::from_utf8_lossy(&vendor_bytes).trim().to_string();
                if let Ok(class_bytes) = std::fs::read(device_path.join("class")) {
                    let class = String::from_utf8_lossy(&class_bytes).trim().to_string();
                    if class.starts_with("0x030000") || class.starts_with("0x030200") {
                        if let Ok(uevent) = std::fs::read_to_string(device_path.join("uevent")) {
                            for line in uevent.lines() {
                                if let Some(val) = line.strip_prefix("PCI_ID=") {
                                    model = format!("GPU ({})", val);
                                }
                            }
                        }

                        let bar0 = device_path.join("resource0");
                        if bar0.exists() {
                            vram = "See driver".to_string();
                        }
                        break;
                    }
                }
            }
        }
    }

    let nvidia = nvidia_stats();

    json!({
        "model": model,
        "vram": vram,
        "utilization": nvidia.as_ref().and_then(|v| v["utilization"].as_f64()),
        "temperature": nvidia.as_ref().and_then(|v| v["temperature"].as_f64())
    })
}

#[cfg(target_os = "linux")]
fn nvidia_stats() -> Option<Value> {
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=utilization.gpu,temperature.gpu,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = stdout.trim().split(", ").collect();
    if parts.len() >= 3 {
        let utilization = parts[0].parse::<f64>().ok();
        let temperature = parts[1].parse::<f64>().ok();
        let mem_total = parts[2].trim();
        return Some(json!({
            "utilization": utilization,
            "temperature": temperature,
            "vram": format!("{} MiB", mem_total)
        }));
    }
    None
}
