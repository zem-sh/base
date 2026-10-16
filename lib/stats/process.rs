use serde_json::{json, Value};
use std::sync::Arc;
use sysinfo::System;

pub async fn stats(system: Arc<tokio::sync::Mutex<System>>) -> Value {
    tokio::task::spawn_blocking(move || {
        let mut sys = system.blocking_lock();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let mut processes: Vec<Value> = sys
            .processes()
            .iter()
            .map(|(pid, p)| {
                json!({
                    "pid": pid.as_u32(),
                    "name": p.name().to_string_lossy(),
                    "cpu_usage": p.cpu_usage(),
                    "memory_kb": p.memory() / 1024,
                    "status": format!("{:?}", p.status()),
                    "exe": p.exe().map(|e| e.to_string_lossy().to_string()).unwrap_or_default(),
                    "parent": p.parent().map(|ppid| ppid.as_u32()).unwrap_or(0),
                })
            })
            .collect();

        processes.sort_by(|a, b| {
            let cpu_a = a["cpu_usage"].as_f64().unwrap_or(0.0);
            let cpu_b = b["cpu_usage"].as_f64().unwrap_or(0.0);
            cpu_b
                .partial_cmp(&cpu_a)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        json!({ "success": true, "data": processes })
    })
    .await
    .unwrap_or(json!({ "success": true, "data": [] }))
}

pub async fn kill_process(pid: u32, force: bool) -> Value {
    let signal = if force { 9 } else { 15 }; // SIGKILL=9, SIGTERM=15
    tokio::task::spawn_blocking(move || {
        use std::process::Command;
        let output = Command::new("kill")
            .arg(format!("-{}", signal))
            .arg(pid.to_string())
            .output();
        match output {
            Ok(o) => json!({
                "success": o.status.success(),
                "data": {
                    "pid": pid,
                    "signal": signal,
                    "killed": o.status.success(),
                    "stderr": String::from_utf8_lossy(&o.stderr).to_string(),
                }
            }),
            Err(e) => json!({
                "success": false,
                "data": {
                    "pid": pid,
                    "signal": signal,
                    "killed": false,
                    "error": e.to_string(),
                }
            }),
        }
    })
    .await
    .unwrap_or(json!({ "success": false, "data": { "pid": pid, "killed": false, "error": "task panicked" } }))
}

pub async fn process_details(pid: u32, system: Arc<tokio::sync::Mutex<System>>) -> Value {
    tokio::task::spawn_blocking(move || {
        let mut sys = system.blocking_lock();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let pid_sys = sysinfo::Pid::from(pid as usize);
        match sys.process(pid_sys) {
            Some(p) => {
                let disk_usage = p.disk_usage();
                json!({
                    "success": true,
                    "data": {
                        "pid": pid,
                        "name": p.name().to_string_lossy(),
                        "exe": p.exe().map(|e| e.to_string_lossy().to_string()).unwrap_or_default(),
                        "cmd": p.cmd().iter().map(|s| s.to_string_lossy().to_string()).collect::<Vec<_>>(),
                        "cwd": p.cwd().map(|c| c.to_string_lossy().to_string()).unwrap_or_default(),
                        "cpu_usage": p.cpu_usage(),
                        "memory_kb": p.memory() / 1024,
                        "virtual_memory_kb": p.virtual_memory() / 1024,
                        "status": format!("{:?}", p.status()),
                        "start_time": p.start_time(),
                        "run_time_secs": p.run_time(),
                        "uid": p.user_id().map(|u| u.to_string()).unwrap_or_default(),
                        "disk_read_kb": disk_usage.read_bytes / 1024,
                        "disk_written_kb": disk_usage.written_bytes / 1024,
                        "environ": p.environ().iter().filter_map(|s| {
                            let s = s.to_string_lossy();
                            let parts: Vec<&str> = s.splitn(2, '=').collect();
                            if parts.len() == 2 { Some((parts[0].to_string(), parts[1].to_string())) } else { None }
                        }).collect::<Vec<_>>(),
                    }
                })
            }
            None => json!({
                "success": false,
                "data": { "pid": pid, "error": "process not found" }
            }),
        }
    })
    .await
    .unwrap_or(json!({ "success": false, "data": { "pid": pid, "error": "task panicked" } }))
}
