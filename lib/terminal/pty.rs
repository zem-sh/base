use std::io::{Read, Write};
use std::sync::Arc;

use tokio::sync::broadcast;
use tokio::sync::{Mutex, RwLock};

use crate::terminal::agent::{now_ms, AgentDetector};
use crate::terminal::osc::{Osc1337Event, Osc1337Parser};
use crate::terminal::scrollback::ScrollbackBuffer;

pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub output_tx: broadcast::Sender<zem_addon_sdk::OutputEvent>,
    pub reader_running: Arc<std::sync::atomic::AtomicBool>,
    pub scrollback: Arc<Mutex<ScrollbackBuffer>>,
    pub cwd: Arc<Mutex<Option<String>>>,
    /// Agent detection state fed by the reader thread (output tail + OSC 133
    /// command markers) and polled by the session-level watch loop.
    pub agent: Arc<Mutex<AgentDetector>>,
}

pub struct PtyParts {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub reader: Box<dyn Read + Send>,
}

pub fn open_pty(
    _pane_id: i32,
    initial_cwd: &str,
    command: Option<&str>,
    args: &[String],
    initial_cols: u16,
    initial_rows: u16,
) -> Result<PtyParts, String> {
    let default_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let program = command.unwrap_or(&default_shell);

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: initial_rows,
            cols: initial_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty: {}", e))?;

    let mut cmd = portable_pty::CommandBuilder::new(program);
    for arg in args {
        cmd.arg(arg);
    }
    if !initial_cwd.is_empty() {
        cmd.cwd(initial_cwd);
    }
    if command.is_none() {
        if let Some(home) = std::env::var("HOME").ok() {
            cmd.env(
                "ZEM_SHELL_INTEGRATION",
                format!("{}/.zem/shell-integration", home),
            );
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn child: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to get writer: {}", e))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to clone reader: {}", e))?;
    let master = pair.master;

    Ok(PtyParts {
        writer: Box::new(writer),
        master,
        child: child,
        reader: Box::new(reader),
    })
}

/// Parses OSC 0/2 terminal-title sequences (`ESC ] 0;... BEL|ST`) out of the
/// raw PTY stream, accumulating payloads that span read-chunk boundaries.
/// Claude/Codex write their working spinner / idle marker into the title, so
/// this is a primary agent-status signal (see `AgentDetector::on_title`).
pub struct OscTitleParser {
    /// Bytes of the in-flight OSC payload (after `ESC ]`), if any.
    partial: Option<Vec<u8>>,
}

impl OscTitleParser {
    pub fn new() -> Self {
        Self { partial: None }
    }

    /// Feed one chunk of raw PTY bytes. Returns the title when a complete
    /// title sequence (OSC 0 or 2) terminated in this chunk.
    pub fn feed(&mut self, data: &[u8]) -> Option<String> {
        let mut result = None;
        let mut i = 0;
        while i < data.len() {
            if self.partial.is_none() {
                // Look for the next OSC start (`ESC ]`).
                if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b']' {
                    self.partial = Some(Vec::new());
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            let byte = data[i];
            if byte == 0x07 {
                // BEL terminates the sequence.
                let payload = self.partial.take().unwrap_or_default();
                if let Some(title) = finish_osc_title(&payload) {
                    result = Some(title);
                }
                i += 1;
            } else if byte == 0x1b {
                if i + 1 < data.len() && data[i + 1] == b'[' {
                    // Embedded CSI (e.g. color codes) inside the payload —
                    // skip it so it doesn't corrupt the title.
                    i += 2;
                    while i < data.len() {
                        let b = data[i];
                        i += 1;
                        if (b'@'..=b'~').contains(&b) {
                            break;
                        }
                    }
                } else if i + 1 < data.len() && data[i + 1] == b'\\' {
                    // ST (`ESC \`) terminates the sequence.
                    let payload = self.partial.take().unwrap_or_default();
                    if let Some(title) = finish_osc_title(&payload) {
                        result = Some(title);
                    }
                    i += 2;
                } else {
                    // A lone ESC inside a sequence: treat it as broken, drop it.
                    self.partial = None;
                    i += 1;
                }
            } else if let Some(buf) = self.partial.as_mut() {
                if buf.len() < 4096 {
                    buf.push(byte);
                }
                i += 1;
            }
        }
        result
    }
}

/// Convert a completed OSC payload into a sanitized title, but only for title
/// sequences (command `0` or `2`). Non-title OSCs (7, 9, 1337, ...) yield None.
fn finish_osc_title(payload: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(payload).ok()?;
    let rest = text
        .strip_prefix("0;")
        .or_else(|| text.strip_prefix("2;"))?;
    let mut out = String::new();
    for ch in rest.chars() {
        if ch.is_control() {
            continue;
        }
        out.push(ch);
        if out.chars().count() >= 256 {
            break;
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn spawn_reader(
    pane_id: i32,
    mut reader: Box<dyn Read + Send>,
    output_tx: broadcast::Sender<zem_addon_sdk::OutputEvent>,
    reader_running: Arc<std::sync::atomic::AtomicBool>,
    scrollback: Arc<Mutex<ScrollbackBuffer>>,
    cwd: Arc<Mutex<Option<String>>>,
    cwd_tx: tokio::sync::mpsc::Sender<String>,
    status_tx: tokio::sync::mpsc::UnboundedSender<crate::terminal::osc::Osc1337Event>,
    agent: Arc<Mutex<AgentDetector>>,
    agents: Arc<RwLock<crate::terminal::agent::AgentRegistry>>,
    // Whether the pane runs an interactive shell (no launch command) — only
    // such panes close themselves when the process exits. Launch-mode panes
    // keep the pane so the user can still read the command's output.
    close_on_exit: bool,
    // Receives the pane id once the PTY process ends — the session manager
    // closes the pane through the host (e.g. the user typed `exit`).
    exit_tx: tokio::sync::mpsc::UnboundedSender<i32>,
) {
    std::thread::Builder::new()
        .name(format!("pty-reader-{}", pane_id))
        .spawn(move || {
            let mut buf = [0u8; 32768];
            let mut title_parser = OscTitleParser::new();
            // OSC markers are message-framed, but PTY reads are not. Keep a
            // parser across reads so CmdText/CmdStart cannot disappear when a
            // marker is split at an arbitrary byte boundary.
            let mut command_parser = Osc1337Parser::new();
            let mut last_cmd_text = String::new();
            loop {
                if !reader_running.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        if let Some(title) = title_parser.feed(&data) {
                            agent.blocking_lock().on_title(title);
                        }
                        if let Some(new_cwd) = crate::terminal::osc::detect_osc7_cwd(&data) {
                            let mut cwd = cwd.blocking_lock();
                            *cwd = Some(new_cwd.clone());
                            drop(cwd);
                            let _ = cwd_tx.blocking_send(new_cwd);
                        }
                        for event in command_parser.feed(&data) {
                            match &event {
                                Osc1337Event::CmdText(text) => {
                                    last_cmd_text = text.clone();
                                }
                                Osc1337Event::CmdStart => {
                                    let kind = agents
                                        .blocking_read()
                                        .identify_command(&last_cmd_text)
                                        .map(|(kind, _)| kind);
                                    if let Some(kind) = kind {
                                        agent.blocking_lock().pre_arm(kind, now_ms());
                                    }
                                }
                                Osc1337Event::CmdEnd(code) => {
                                    agent.blocking_lock().on_cmd_end(*code);
                                    last_cmd_text.clear();
                                }
                            }
                            let _ = status_tx.send(event);
                        }
                        scrollback.blocking_lock().write(&data);
                        {
                            agent.blocking_lock().feed_output(&data);
                        }
                        let _ = output_tx.send(zem_addon_sdk::OutputEvent {
                            data,
                            exited: false,
                        });
                    }
                    Err(e) => {
                        tracing::warn!("PTY read error for pane {}: {}", pane_id, e);
                        break;
                    }
                }
            }
            let _ = output_tx.send(zem_addon_sdk::OutputEvent {
                data: Vec::new(),
                exited: true,
            });
            // The PTY process is gone (EOF or read error) — e.g. the user
            // typed `exit` or hit Ctrl+D at an empty prompt. For shell panes
            // the session manager closes the pane through the host: there is
            // no live shell left to keep it open. Only fire when the loop
            // ended naturally (EOF/error): when it was stopped by session
            // teardown (`stop()` — the user already closed the pane), the
            // host is closing it itself and a redundant request would race
            // that close.
            if close_on_exit && reader_running.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = exit_tx.send(pane_id);
            }
        })
        .expect("failed to spawn reader thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc_title_osc0_bel_terminated() {
        let mut p = OscTitleParser::new();
        assert_eq!(
            p.feed("\x1b]0;⠋ ⚡ claude code\x07".as_bytes()),
            Some("⠋ ⚡ claude code".to_string())
        );
    }

    #[test]
    fn osc_title_osc2_st_terminated() {
        let mut p = OscTitleParser::new();
        assert_eq!(
            p.feed("\x1b]2;✳ Claude Code\x1b\\".as_bytes()),
            Some("✳ Claude Code".to_string())
        );
    }

    #[test]
    fn osc_title_spans_chunk_boundary() {
        let mut p = OscTitleParser::new();
        // First chunk ends mid-sequence.
        assert_eq!(p.feed("prefix \x1b]0;⠋ ⚡ c".as_bytes()), None);
        // Second chunk completes it.
        assert_eq!(
            p.feed("laude code\x07 rest".as_bytes()),
            Some("⠋ ⚡ claude code".to_string())
        );
        // The trailing " rest" is ordinary text — no lingering state.
        assert_eq!(p.feed(" more".as_bytes()), None);
    }

    #[test]
    fn non_title_osc_is_ignored() {
        let mut p = OscTitleParser::new();
        // OSC 7 (cwd), OSC 9 (progress), OSC 1337 (zem commands) — none are titles.
        assert_eq!(p.feed("\x1b]7;file:///tmp\x07".as_bytes()), None);
        assert_eq!(p.feed("\x1b]9;4;1;0\x07".as_bytes()), None);
        assert_eq!(p.feed("\x1b]1337;CmdStart\x07".as_bytes()), None);
        // A real title after them is still captured.
        assert_eq!(
            p.feed("\x1b]0;claude code\x07".as_bytes()),
            Some("claude code".to_string())
        );
    }

    #[test]
    fn empty_title_yields_none() {
        let mut p = OscTitleParser::new();
        assert_eq!(p.feed("\x1b]0;\x07".as_bytes()), None);
        assert_eq!(p.feed("\x1b]2;   \x1b\\".as_bytes()), None);
    }

    #[test]
    fn control_chars_are_stripped_from_title() {
        let mut p = OscTitleParser::new();
        assert_eq!(
            p.feed("\x1b]0;⠋ \u{1b}[31mred\u{1b}[0m\x07".as_bytes()),
            Some("⠋ red".to_string())
        );
    }
}

impl PtySession {
    pub fn new(_pane_id: i32, initial_cwd: &str, parts: PtyParts, scrollback_size: usize) -> Self {
        let (output_tx, _) = broadcast::channel::<zem_addon_sdk::OutputEvent>(1024);
        let reader_running = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let scrollback = Arc::new(Mutex::new(ScrollbackBuffer::new(scrollback_size)));
        let cwd = Arc::new(Mutex::new(Some(initial_cwd.to_string())));
        let agent = Arc::new(Mutex::new(AgentDetector::new()));

        Self {
            writer: parts.writer,
            master: parts.master,
            child: parts.child,
            output_tx,
            reader_running,
            scrollback,
            cwd,
            agent,
        }
    }

    pub fn write_input(&mut self, data: &[u8]) -> Result<(), String> {
        self.writer
            .write_all(data)
            .map_err(|e| format!("failed to write to PTY: {}", e))?;
        self.writer
            .flush()
            .map_err(|e| format!("failed to flush PTY: {}", e))
    }

    pub fn resize(&mut self, cols: u16, rows: u16, width_px: u16, height_px: u16) {
        if let Err(e) = self.master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: width_px,
            pixel_height: height_px,
        }) {
            tracing::warn!("Failed to resize PTY: {}", e);
        }
    }

    pub fn stop(&mut self) {
        self.reader_running
            .store(false, std::sync::atomic::Ordering::Relaxed);
    }
}
