use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio::sync::{Mutex, RwLock};

use zem_addon_sdk::AddonContext;
use zem_addon_sdk::OutputEvent;

use crate::terminal::agent::{now_ms, setting_bool, AgentKind, AgentRegistry, AgentSnapshot};
use crate::terminal::osc::Osc1337Event;
use crate::terminal::pty::{self, PtySession};

const DEFAULT_AUTOSAVE_INTERVAL_SECS: u64 = 10;

pub const DEFAULT_SCROLLBACK_SIZE: usize = 10 * 1024 * 1024;

/// How often the agent detection loop inspects process trees and output tails.
/// How often the agent watch loop re-identifies and re-derives pane status.
/// Deliberately fast (400ms): full-screen TUI agents like Pi keep their
/// working signal (the `⠋ Working...` braille spinner) on screen only for the
/// duration of each request — for a fast model that window can be ~1s — so a
/// slower tick would often land entirely outside it and "working" would never
/// be persisted.
const AGENT_WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(400);

/// How long an armed pane tolerates the agent process not showing up in the
/// process snapshot before the arm is dropped. Must comfortably outlast slow
/// agent boots: `claude`/`codex` spawn a node/bun runtime and can take
/// several seconds to exec their main process (cold `npx`/`bunx` resolution
/// longer), and a single `ps` snapshot can miss a mid-fork process. A drop
/// here is final — the pane is never re-inspected — so this window is the
/// difference between "detected" and "not detected at all".
///
/// After the window, an armed pane whose agent process is gone is treated as
/// closed — detection terminates (launch-mode panes have no shell integration
/// `CmdEnd`, so the process tree is their close signal).
const ARM_CONFIRM_MS: u64 = 15_000;

/// The status-bar action id that surfaces running agents across panes.
const AGENTS_ACTION_ID: &str = "agents";

/// Per-status colors for the status-bar agent view.
/// Cyan (not the emerald `running` green) so a working agent reads as a
/// distinct activity from a plain command running in a shell.
const AGENT_COLOR_WORKING: &str = "#22d3ee";
const AGENT_COLOR_IDLE: &str = "#94a3b8";
const AGENT_COLOR_BLOCKED: &str = "#fbbf24";
const AGENT_COLOR_ERROR: &str = "#f87171";

/// Braille frames for the animated "working" glyph in the status-bar agent
/// view. Derived from the wall clock so the 400ms watch tick rotates it.
const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<i32, PtySession>>>,
    ctx: AddonContext,
    settings: Arc<Mutex<serde_json::Value>>,
    create_lock: Arc<tokio::sync::Mutex<()>>,
    /// Agent mechanisms + identity tables. Read on every detection tick,
    /// written when settings change (enable toggles / custom markers).
    agents: Arc<RwLock<AgentRegistry>>,
    /// Panes with an active agent command (`(kind, armed_at_ms)`). Detection
    /// is tied to the command lifecycle: armed when an agent command starts
    /// (shell `CmdStart` or a launch command), disarmed when it ends
    /// (`CmdEnd` or the agent process disappearing).
    agent_arms: Arc<Mutex<HashMap<i32, (AgentKind, u64)>>>,
    /// Monotonic command generations. Watch ticks capture a generation and
    /// re-check it before host writes, so an old async tick cannot resurrect
    /// an agent after CmdEnd or a new command.
    agent_generations: Arc<Mutex<HashMap<i32, u64>>>,
    /// Serializes host metadata writes for each pane. A watch tick can await
    /// several RPCs; this prevents CmdEnd cleanup from interleaving and lets
    /// the final clear win over an older persistence operation.
    agent_write_locks: Arc<Mutex<HashMap<i32, Arc<tokio::sync::Mutex<()>>>>>,
    last_agents_view: Arc<Mutex<Option<String>>>,
}

impl SessionManager {
    pub fn new(ctx: AddonContext) -> Self {
        let mgr = Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            ctx,
            settings: Arc::new(Mutex::new(
                serde_json::Value::Object(serde_json::Map::new()),
            )),
            create_lock: Arc::new(tokio::sync::Mutex::new(())),
            agents: Arc::new(RwLock::new(AgentRegistry::builtin())),
            agent_arms: Arc::new(Mutex::new(HashMap::new())),
            agent_generations: Arc::new(Mutex::new(HashMap::new())),
            agent_write_locks: Arc::new(Mutex::new(HashMap::new())),
            last_agents_view: Arc::new(Mutex::new(None)),
        };
        mgr.spawn_agent_watch();
        mgr
    }

    pub async fn load_settings(&self) {
        if let Ok(settings) = self.ctx.get_settings().await {
            let mut s = self.settings.lock().await;
            *s = settings.clone();
            drop(s);
            self.apply_settings(&settings).await;
        }
    }

    /// Rebuild the agent registry from settings (per-agent enable toggles and
    /// custom status markers). Runs at startup and on every `settings_changed`.
    async fn apply_settings(&self, settings: &serde_json::Value) {
        let mut registry = self.agents.write().await;
        registry.configure(settings);
        tracing::debug!(agents = registry.mechanisms_len(), "agent settings applied");
    }

    /// React to the host's `settings_changed` app event. The event is
    /// broadcast to every addon process, so only our own addon's settings are
    /// applied. Re-reading from the host keeps the local cache authoritative
    /// regardless of how the settings were changed.
    pub async fn handle_settings_changed(&self, payload: &serde_json::Value) {
        let addon_id = payload
            .get("addon_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        // The event carries the canonical manifest id (e.g. `com.zem.core`)
        // while this addon was spawned with the short key (`core`).
        let is_ours = addon_id == self.ctx.addon_id()
            || addon_id == format!("com.zem.{}", self.ctx.addon_id());
        if !is_ours {
            return;
        }
        tracing::info!("terminal addon settings changed — reapplying agent detection");
        self.load_settings().await;
    }

    pub async fn get_scrollback_size(&self) -> usize {
        let settings = self.settings.lock().await;
        settings
            .get("max_scrollback_size")
            .and_then(|v| v.as_u64())
            .map(|v| (v * 1024 * 1024) as usize)
            .unwrap_or(DEFAULT_SCROLLBACK_SIZE)
    }

    pub async fn get_autosave_interval(&self) -> std::time::Duration {
        let settings = self.settings.lock().await;
        let secs = settings
            .get("autosave_interval_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_AUTOSAVE_INTERVAL_SECS);
        std::time::Duration::from_secs(secs.clamp(1, 300))
    }

    /// `temp_cwd` — whether an idle pane inside a git working tree shows the
    /// repository name instead of the folder name as its temp title.
    async fn use_git_repo_name(&self) -> bool {
        let settings = self.settings.lock().await;
        setting_bool(&settings, "temp_cwd", false)
    }

    /// Minimum command duration before a completion notification is sent —
    /// failed or successful (`notify_duration_seconds`, default 30s).
    async fn get_notify_threshold(&self) -> std::time::Duration {
        let settings = self.settings.lock().await;
        let secs = settings
            .get("notify_duration_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(30);
        std::time::Duration::from_secs(secs.clamp(1, 3600))
    }

    /// `notify_success` — whether long-running successful commands get a
    /// completion notification. Failures always notify (past the threshold).
    async fn get_notify_success(&self) -> bool {
        let settings = self.settings.lock().await;
        setting_bool(&settings, "notify_success", false)
    }

    pub async fn create(
        &self,
        pane_id: i32,
        cwd: &str,
        extra: &serde_json::Value,
    ) -> Result<(), String> {
        // Stop old session if any (save scrollback to DB first)
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(mut old) = sessions.remove(&pane_id) {
                tracing::info!("pane {} - stopping existing session", pane_id);
                let scrollback_data = old.scrollback.lock().await.get_all();
                old.stop();
                self.save_scrollback_data(pane_id, scrollback_data).await;
            }
        }

        let scrollback_size = self.get_scrollback_size().await;

        // Create new PTY
        let launch = extra.get("launch").unwrap_or(&serde_json::Value::Null);
        let explicit_args: Vec<String> = launch
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let (command, args) = match launch.get("command").and_then(|v| v.as_str()) {
            Some(raw) => {
                let mut parts = raw.split_whitespace();
                let prog = parts.next().unwrap_or_default();
                let mut split_args: Vec<String> = parts.map(|s| s.to_string()).collect();
                if !explicit_args.is_empty() {
                    split_args = explicit_args;
                }
                (if prog.is_empty() { None } else { Some(prog) }, split_args)
            }
            None => (None, explicit_args),
        };
        let init_cols = extra
            .get("init_cols")
            .and_then(|v| v.as_u64())
            .unwrap_or(80) as u16;
        let init_rows = extra
            .get("init_rows")
            .and_then(|v| v.as_u64())
            .unwrap_or(24) as u16;
        let mut parts = pty::open_pty(pane_id, cwd, command, &args, init_cols, init_rows)?;
        let reader = std::mem::replace(&mut parts.reader, Box::new(std::io::empty()));
        let session = PtySession::new(pane_id, cwd, parts, scrollback_size);
        let launch_agent_kind = self.launch_agent_kind(extra).await;
        if let Some(kind) = launch_agent_kind {
            // Arm before starting the reader. A directly launched Pi process
            // can paint its first full-screen frame immediately; pre-arming
            // here prevents that frame from being wiped by a later async arm.
            session.agent.lock().await.pre_arm(kind, now_ms());
        }

        // Load saved scrollback from DB and replay it into the new session's buffer
        let saved_scrollback = self.load_scrollback_from_db(pane_id).await;
        if !saved_scrollback.is_empty() {
            session.scrollback.lock().await.write(&saved_scrollback);
            tracing::info!(
                "pane {} - loaded {} bytes of scrollback from DB",
                pane_id,
                saved_scrollback.len()
            );
        }

        // Seed only line-oriented tail history. A fresh TUI agent must not
        // replay old escape sequences into its new screen model: stale Pi
        // frames can otherwise look like a live spinner before the new process
        // paints its first screen.
        if !saved_scrollback.is_empty() {
            session.agent.lock().await.seed_tail(&saved_scrollback);
        }

        // Set up channels for background tasks
        let (_cwd_tx, cwd_rx) = mpsc::channel::<String>(4);
        // Status markers must never back-pressure the PTY reader. The watcher
        // deliberately waits during command debounce, so a bounded channel
        // could block terminal output and make agent startup look frozen.
        let (_status_tx, status_rx) = mpsc::unbounded_channel::<Osc1337Event>();

        // Spawn CWD watcher
        let mgr_cwd = self.clone();
        let pane_id_cwd = pane_id;
        tokio::spawn(async move {
            Self::watch_cwd(mgr_cwd, pane_id_cwd, cwd_rx).await;
        });

        // Spawn status watcher
        let mgr_status = self.clone();
        let ctx_status = self.ctx.clone();
        let pane_id_status = pane_id;
        tokio::spawn(async move {
            SessionManager::watch_status(&mgr_status, ctx_status, pane_id_status, status_rx).await;
        });

        // Spawn reader thread. When a shell pane's process ends (EOF — e.g.
        // the user typed `exit` or hit Ctrl+D at an empty prompt) it signals
        // `exit_tx`, and the watcher below closes the pane through the host so
        // the layout updates instead of leaving a dead shell behind. Closing
        // an already-closed pane is a host no-op. Launch-mode panes (a direct
        // command, no shell) are excluded: their process ending is not an
        // "exit" — Ctrl+C on a dev server or a finished `ls` must not tear
        // the pane down.
        let (exit_tx, mut exit_rx) = mpsc::unbounded_channel::<i32>();
        pty::spawn_reader(
            pane_id,
            reader,
            session.output_tx.clone(),
            session.reader_running.clone(),
            session.scrollback.clone(),
            session.cwd.clone(),
            _cwd_tx,
            _status_tx,
            session.agent.clone(),
            self.agents.clone(),
            command.is_none(), // close on exit only for interactive shells
            exit_tx,
        );
        // Use a fresh context (its own socket connection) for the close
        // request. The shared context must NOT be used here: while
        // `close_pane` awaits the host's response, the host calls `on_destroy`
        // back into this addon (session teardown, which itself performs host
        // RPCs over the shared connection) — awaiting a response on the same
        // serialized connection would deadlock.
        let exit_ctx = zem_addon_sdk::AddonContext::from_env();
        tokio::spawn(async move {
            while let Some(pid) = exit_rx.recv().await {
                if let Err(e) = exit_ctx.close_pane(pid).await {
                    tracing::warn!("failed to close pane {} after process exit: {}", pid, e);
                }
            }
        });

        // Spawn periodic scrollback saver
        let save_interval = self.get_autosave_interval().await;
        self.spawn_scrollback_saver(pane_id, save_interval);

        // Store session
        self.sessions.lock().await.insert(pane_id, session);
        tracing::info!("created PTY session for pane {}", pane_id);

        // A pane launched directly with an agent command arms detection up
        // front — there is no shell integration involved, so the process tree
        // (and this arm) is the signal. Shell panes arm via the OSC 1337
        // `CmdStart` when the user runs an agent.
        if let Some(kind) = launch_agent_kind {
            self.arm_agent(pane_id, kind).await;
        }

        // Seed the pane's dynamic name: launch panes run their command
        // directly (no shell integration, so no `CmdStart` will fire) and show
        // the launched program; shell panes show the current directory until
        // their first command. Kept updated by `update_temp_name`.
        self.update_temp_name(pane_id, command.unwrap_or("")).await;

        // Type the last command as PTY input so it actually runs after reconnect
        if let Some(last_cmd) = extra.get("last_command").and_then(|v| v.as_str()) {
            if !last_cmd.is_empty() {
                if let Some(session) = self.sessions.lock().await.get_mut(&pane_id) {
                    let input = format!("{}\n", last_cmd);
                    session.write_input(input.as_bytes())?;
                    tracing::info!("typed last command for pane {}: {}", pane_id, last_cmd);
                }
            }
        }

        Ok(())
    }

    /// Reuse an existing session if present, otherwise create one. Serialized
    /// so concurrent attaches from multiple clients can't double-create.
    pub async fn create_or_attach(
        &self,
        pane_id: i32,
        cwd: &str,
        extra: &serde_json::Value,
    ) -> Result<(), String> {
        let _guard = self.create_lock.lock().await;
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get_mut(&pane_id) {
                tracing::info!(
                    "pane {} - reusing existing session (concurrent attach)",
                    pane_id
                );
                session
                    .reader_running
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                return Ok(());
            }
        }
        self.create(pane_id, cwd, extra).await
    }

    pub async fn destroy(&self, pane_id: i32, reason: &str) {
        tracing::info!("on_destroy pane {} ({})", pane_id, reason);
        let had_agent = {
            let mut sessions = self.sessions.lock().await;
            match sessions.remove(&pane_id) {
                Some(mut session) => {
                    let scrollback_data = session.scrollback.lock().await.get_all();
                    self.save_scrollback_data(pane_id, scrollback_data).await;
                    session.stop();
                    drop(session.writer);
                    drop(session.child);
                    session
                        .agent
                        .try_lock()
                        .ok()
                        .map(|d| d.current.is_some())
                        .unwrap_or(false)
                }
                None => false,
            }
        };
        // Invalidate queued watch writes before clearing host metadata. This
        // ordering prevents a stale tick from being queued between the clear
        // and the generation bump and resurrecting the disconnected agent.
        self.bump_agent_generation(pane_id).await;
        self.agent_arms.lock().await.remove(&pane_id);
        // A killed/disconnected session no longer gets watch ticks — clear any
        // stale `extra.agent` so the pane leaves the Agents collection instead
        // of being pinned to a dead agent forever.
        if had_agent {
            self.clear_agent(pane_id, None).await;
        }
        // Refresh the status-bar agent list (this pane's agent is gone).
        self.publish_agents_view().await;
    }

    pub async fn subscribe(&self, pane_id: i32) -> Result<mpsc::Receiver<OutputEvent>, String> {
        let sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(&pane_id) {
            let scrollback = Arc::clone(&session.scrollback);
            let output_tx = session.output_tx.clone();
            drop(sessions);

            let scrollback_data = scrollback.lock().await.get_all();
            let mut rx = output_tx.subscribe();

            let (output_tx, output_rx) = mpsc::channel(256);
            if !scrollback_data.is_empty() {
                let _ = output_tx
                    .send(OutputEvent {
                        data: scrollback_data,
                        exited: false,
                    })
                    .await;
            }
            tokio::spawn(async move {
                while let Ok(event) = rx.recv().await {
                    if output_tx.send(event).await.is_err() {
                        break;
                    }
                }
            });
            Ok(output_rx)
        } else {
            drop(sessions);
            let (_output_tx, output_rx) = mpsc::channel(256);
            Ok(output_rx)
        }
    }

    pub async fn write_input(&self, pane_id: i32, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let session = sessions
            .get_mut(&pane_id)
            .ok_or_else(|| format!("no session found for pane {} to write input", pane_id))?;
        session.write_input(data)
    }

    pub async fn resize(&self, pane_id: i32, cols: u16, rows: u16, width_px: u16, height_px: u16) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&pane_id) {
            session.resize(cols, rows, width_px, height_px);
            tracing::info!(
                "pane {} resized to {}x{} ({}x{}px)",
                pane_id,
                cols,
                rows,
                width_px,
                height_px
            );
        } else {
            tracing::warn!("no session found for pane {} to resize", pane_id);
        }
    }

    async fn watch_cwd(mgr: SessionManager, pane_id: i32, mut rx: mpsc::Receiver<String>) {
        while let Some(new_cwd) = rx.recv().await {
            if let Err(e) = mgr.ctx.set_cwd(pane_id, &new_cwd).await {
                tracing::warn!("Failed to save CWD for pane {}: {}", pane_id, e);
            }
            // The pane's dynamic name is the current directory's basename at
            // the prompt — a running command takes it over on `CmdStart`.
            // OSC 7 is emitted when the shell draws its prompt (i.e. while
            // idle), so this can't race a running command's name in practice.
            mgr.update_temp_name(pane_id, "").await;
        }
    }

    async fn save_scrollback_data(&self, pane_id: i32, data: Vec<u8>) {
        if data.is_empty() {
            return;
        }
        if let Err(e) = self.ctx.set_pane_data(pane_id, "scrollback", &data).await {
            tracing::warn!("Failed to save scrollback for pane {}: {}", pane_id, e);
        }
    }

    async fn load_scrollback_from_db(&self, pane_id: i32) -> Vec<u8> {
        self.ctx
            .get_data(pane_id, "scrollback")
            .await
            .unwrap_or_default()
    }

    fn spawn_scrollback_saver(&self, pane_id: i32, interval: std::time::Duration) {
        let ctx = self.ctx.clone();
        let sessions = self.sessions.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let sessions = sessions.lock().await;
                if let Some(session) = sessions.get(&pane_id) {
                    if !session
                        .reader_running
                        .load(std::sync::atomic::Ordering::Relaxed)
                    {
                        break;
                    }
                    let scrollback = session.scrollback.lock().await;
                    let data = scrollback.get_all();
                    drop(scrollback);
                    if data.is_empty() {
                        continue;
                    }
                    if let Err(e) = ctx.set_pane_data(pane_id, "scrollback", &data).await {
                        tracing::warn!("Scrollback autosave failed for pane {}: {}", pane_id, e);
                    }
                } else {
                    break;
                }
            }
        });
    }

    /// Save scrollback for all active sessions (called on server_stopped)
    pub async fn save_all_scrollback(&self) {
        let pane_ids: Vec<i32> = self.sessions.lock().await.keys().copied().collect();
        for pane_id in pane_ids {
            let sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get(&pane_id) {
                let data = session.scrollback.lock().await.get_all();
                drop(sessions);
                self.save_scrollback_data(pane_id, data).await;
            }
        }
    }

    /// Merge launch params (if any) into the status extra before persisting, so
    /// the pane's configured launch command survives status updates. Also
    /// preserves the live `agent` object — otherwise the OSC status watcher
    /// would clobber `extra.agent` on every CmdStart/CmdEnd and briefly eject
    /// agent panes from the Agents collection.
    async fn set_status_extra_preserving_launch(
        ctx: &AddonContext,
        pane_id: i32,
        base: &serde_json::Value,
    ) {
        let mut merged = base.clone();
        if let Ok(current) = ctx.get_extra_json(pane_id).await {
            if let Some(obj) = merged.as_object_mut() {
                if let Some(launch) = current.get("launch") {
                    obj.insert("launch".to_string(), launch.clone());
                }
                if let Some(agent) = current.get("agent") {
                    obj.insert("agent".to_string(), agent.clone());
                }
            }
        }
        let _ = ctx.set_extra(pane_id, &merged).await;
    }

    async fn watch_status(
        mgr: &SessionManager,
        ctx: AddonContext,
        pane_id: i32,
        mut rx: mpsc::UnboundedReceiver<Osc1337Event>,
    ) {
        let mut last_cmd = String::new();
        // Commands shorter than this won't trigger the "running" status (e.g. `ls`, `pwd`).
        let debounce = std::time::Duration::from_millis(100);
        // Unix ms when the current command started — gates completion
        // notifications: only commands that run at least the configured
        // threshold (`notify_duration_seconds`) ever notify.
        let mut cmd_started_ms: Option<u64> = None;

        while let Some(event) = rx.recv().await {
            match event {
                Osc1337Event::CmdText(text) => {
                    last_cmd = text;
                }
                Osc1337Event::CmdStart => {
                    // Record when the command started so `finalize_status` can
                    // decide whether it ran long enough to notify.
                    cmd_started_ms = Some(now_ms());
                    // If the command is a supported agent, arm detection for
                    // the pane — detection is tied to the agent command's
                    // lifecycle, and the agent watch loop owns the pane
                    // status from here (idle at the prompt, running/error
                    // while working). The generic "running" is skipped so
                    // opening an agent never flashes running.
                    let is_agent_cmd = mgr.maybe_arm_agent(pane_id, &last_cmd).await;

                    // Debounce: wait before marking as "running".
                    // If CmdEnd arrives before the timer fires (e.g. a quick `ls`),
                    // skip the "running" intermediate state entirely.
                    let timer = tokio::time::sleep(debounce);
                    tokio::pin!(timer);

                    loop {
                        tokio::select! {
                            _ = &mut timer => {
                                // Debounce window expired — mark as running.
                                // Agent commands are skipped (the agent loop
                                // owns their status); agent panes detected from
                                // a previous cycle are also skipped so
                                // per-tool-command OSC events don't flicker the
                                // status between real ticks.
                                if !is_agent_cmd && !mgr.is_agent_pane(pane_id).await {
                                    let _ = ctx.set_status(pane_id, "running").await;
                                }
                                Self::set_status_extra_preserving_launch(
                                    &ctx,
                                    pane_id,
                                    &serde_json::json!({"last_command": last_cmd, "running": true}),
                                ).await;
                                // The pane's dynamic name follows the running
                                // program (agent panes are skipped — the agent
                                // loop owns their name).
                                mgr.update_temp_name(pane_id, &last_cmd).await;
                                break;
                            }
                            event = rx.recv() => {
                                match event {
                                    Some(Osc1337Event::CmdEnd(exit_code)) => {
                                        // Command finished within the debounce window
                                        let was_agent = mgr.disarm_agent(pane_id, &last_cmd, exit_code).await;
                                        Self::finalize_status(mgr, &ctx, pane_id, &last_cmd, exit_code, was_agent, cmd_started_ms).await;
                                        cmd_started_ms = None;
                                        break; // Return to the main event loop for future commands
                                    }
                                    Some(Osc1337Event::CmdText(text)) => {
                                        last_cmd = text;
                                        // Continue the debounce wait
                                    }
                                    Some(Osc1337Event::CmdStart) => {
                                        // A new command started — restart the debounce window
                                        cmd_started_ms = Some(now_ms());
                                        timer.as_mut().reset(tokio::time::Instant::now() + debounce);
                                    }
                                    None => return,
                                }
                            }
                        }
                    }
                }
                Osc1337Event::CmdEnd(exit_code) => {
                    let was_agent = mgr.disarm_agent(pane_id, &last_cmd, exit_code).await;
                    Self::finalize_status(
                        mgr,
                        &ctx,
                        pane_id,
                        &last_cmd,
                        exit_code,
                        was_agent,
                        cmd_started_ms,
                    )
                    .await;
                    cmd_started_ms = None;
                }
            }
        }
    }

    /// Handle a CmdEnd event: set final status (idle/cancelled/error) and optionally notify.
    /// `was_agent` is set when the pane had an armed agent command (disarmed by
    /// the caller) — the agent watch loop owns its status and error reporting.
    /// `cmd_started_ms` is when the command began (from the CmdStart event) —
    /// completion notifications only fire for commands that ran at least the
    /// configured threshold.
    async fn finalize_status(
        mgr: &SessionManager,
        ctx: &AddonContext,
        pane_id: i32,
        last_cmd: &str,
        exit_code: i32,
        was_agent: bool,
        cmd_started_ms: Option<u64>,
    ) {
        let is_cancel = Self::is_cancellation(exit_code);
        // For agent panes the agent watch loop owns the pane status — each tool
        // command the agent runs would otherwise flip the status to idle/error
        // between ticks and hide the agent's real state (idle while waiting).
        // `extra` (last_command / running / exit_code) is still recorded.
        let is_agent = mgr.is_agent_pane(pane_id).await;
        let is_agent_pane = is_agent || was_agent;
        // A *held* agent error (the agent already exited with a failure and the
        // watch loop is showing the error for the failure window) must not pin
        // the pane: the next normal command means the user is back at shell
        // work, so release the stale error and fall through to the command's
        // own idle/error status.
        let held_agent_error = !was_agent && is_agent && !mgr.is_agent_armed(pane_id).await;
        if held_agent_error {
            mgr.release_held_agent_error(pane_id).await;
        }
        if !is_agent_pane || held_agent_error {
            let status = if exit_code == 0 || is_cancel {
                "idle"
            } else {
                "error"
            };
            let _ = ctx.set_status(pane_id, status).await;
        }
        let extra = serde_json::json!({
            "last_command": last_cmd,
            "running": false,
            "exit_code": exit_code
        });
        Self::set_status_extra_preserving_launch(ctx, pane_id, &extra).await;
        // Completion notifications — only for commands that ran at least the
        // configured threshold (`notify_duration_seconds`, default 30s).
        // Shorter commands never notify, failed or successful. Agent panes
        // are handled by the agent watch loop (which owns their status and
        // error toasts), so skip them to avoid duplicates.
        let threshold_ms = mgr.get_notify_threshold().await.as_millis() as u64;
        let ran_long =
            cmd_started_ms.is_some_and(|started| now_ms().saturating_sub(started) >= threshold_ms);
        if ran_long && !is_agent_pane {
            let secs = cmd_started_ms
                .map(|started| now_ms().saturating_sub(started) / 1000)
                .unwrap_or(0);
            // Actual failures (not user-cancelled Ctrl+C) always notify.
            if exit_code != 0 && !is_cancel {
                let _ = ctx
                    .notify(
                        pane_id,
                        "Command Failed",
                        &format!(
                            "`{}` exited with code {} after {}s",
                            last_cmd, exit_code, secs
                        ),
                        "error",
                        false,
                        None,
                    )
                    .await;
            } else if exit_code == 0 && mgr.get_notify_success().await {
                let _ = ctx
                    .notify(
                        pane_id,
                        "Command Finished",
                        &format!("`{}` finished in {}s", last_cmd, secs),
                        "success",
                        false,
                        None,
                    )
                    .await;
            }
        }
        // The command finished — the pane is back at the prompt, so its
        // dynamic name falls back to the current directory.
        mgr.update_temp_name(pane_id, "").await;
    }

    // -----------------------------------------------------------------------
    // Agent detection
    // -----------------------------------------------------------------------

    /// Whether the pane currently has a detected agent (used to suppress the
    /// generic command-failure notification so the agent loop reports errors).
    /// Armed panes count even before the first detection tick persists them.
    pub async fn is_agent_pane(&self, pane_id: i32) -> bool {
        if self.agent_arms.lock().await.contains_key(&pane_id) {
            return true;
        }
        let sessions = self.sessions.lock().await;
        sessions
            .get(&pane_id)
            .and_then(|session| session.agent.try_lock().ok())
            .map(|detector| detector.current.is_some())
            .unwrap_or(false)
    }

    /// Whether the pane currently has an *active* agent command (armed, not yet
    /// ended). Distinct from [`is_agent_pane`], which also counts a held error
    /// snapshot left after an agent already exited with a failure.
    async fn is_agent_armed(&self, pane_id: i32) -> bool {
        self.agent_arms.lock().await.contains_key(&pane_id)
    }

    /// If `command` is a supported agent, arm detection for the pane — the
    /// agent command's lifecycle starts now. Returns whether it matched.
    async fn bump_agent_generation(&self, pane_id: i32) -> u64 {
        let write_lock = self.agent_write_lock(pane_id).await;
        let _write_guard = write_lock.lock().await;
        let mut generations = self.agent_generations.lock().await;
        let generation = generations.entry(pane_id).or_insert(0);
        *generation = generation.saturating_add(1);
        *generation
    }

    async fn is_current_agent_generation(&self, pane_id: i32, generation: u64) -> bool {
        self.agent_generations
            .lock()
            .await
            .get(&pane_id)
            .copied()
            .unwrap_or(0)
            == generation
    }

    async fn maybe_arm_agent(&self, pane_id: i32, command: &str) -> bool {
        let kind = {
            let registry = self.agents.read().await;
            registry.identify_command(command).map(|(kind, _)| kind)
        };
        match kind {
            Some(kind) => {
                self.arm_agent(pane_id, kind).await;
                true
            }
            None => false,
        }
    }

    /// Arm agent detection for a pane with the given agent kind. The detector
    /// is reset for a clean slate (the previous command's output must not leak
    /// into the new agent's status) unless the pane is already armed with the
    /// same agent (a re-entrant `CmdStart` must not wipe a live session).
    async fn arm_agent(&self, pane_id: i32, kind: AgentKind) {
        let is_new = {
            let mut arms = self.agent_arms.lock().await;
            match arms.get(&pane_id) {
                Some((existing, _)) if *existing == kind => false,
                _ => {
                    arms.insert(pane_id, (kind, now_ms()));
                    true
                }
            }
        };
        if is_new {
            let generation = self.bump_agent_generation(pane_id).await;
            if let Some(session) = self.sessions.lock().await.get(&pane_id) {
                session.agent.lock().await.confirm_arm(kind, now_ms());
            }
            tracing::debug!(pane_id, generation, agent = ?kind, "agent lifecycle armed");
        }
    }

    /// End an agent command's lifecycle (`CmdEnd`). Only the agent command's
    /// own end terminates detection — a tool command the agent ran through the
    /// interactive shell (a terminal/PTY tool) fires its own `CmdStart`/
    /// `CmdEnd` and must not kill the session, so `last_cmd` is re-checked
    /// against the agent registry first. A normal close (exit 0 or Ctrl+C)
    /// terminates immediately — `extra.agent` is removed so the pane leaves
    /// the Agents collection. A non-zero exit keeps the current agent state so
    /// the watch loop holds a visible error until the failure window expires
    /// (or the next normal command releases it — see `finalize_status`).
    /// Returns whether the pane's agent command ended, so callers can suppress
    /// the generic command-status handling.
    async fn disarm_agent(&self, pane_id: i32, last_cmd: &str, exit_code: i32) -> bool {
        let is_agent_cmd = {
            let registry = self.agents.read().await;
            registry.identify_command(last_cmd).is_some()
        };
        if !is_agent_cmd {
            return false;
        }
        let was_armed = { self.agent_arms.lock().await.remove(&pane_id).is_some() };
        if !was_armed {
            return false;
        }
        self.bump_agent_generation(pane_id).await;
        if let Some(session) = self.sessions.lock().await.get(&pane_id) {
            session.agent.lock().await.clear_arm();
        }
        let clean = exit_code == 0 || Self::is_cancellation(exit_code);
        if clean {
            // Clear the host first; only record the in-memory clear once the
            // write succeeds — marking None before would make `changed()`
            // false and a transiently-failed clear would never be retried,
            // leaving a stale `extra.agent` that pins the pane to the Agents
            // collection forever.
            if self.clear_agent(pane_id, None).await {
                if let Some(session) = self.sessions.lock().await.get(&pane_id) {
                    let mut detector = session.agent.lock().await;
                    detector.mark_persisted(None);
                    detector.clear_arm();
                }
                // The agent loop owned the status while the agent ran —
                // restore the shell's idle state on close.
                let _ = self.ctx.set_status(pane_id, "idle").await;
            }
        }
        true
    }

    /// The agent kind a pane's `launch.command` runs, if any (launch-mode
    /// panes bypass the shell, so there is no `CmdStart` to arm from).
    async fn launch_agent_kind(&self, extra: &serde_json::Value) -> Option<AgentKind> {
        let command = extra
            .get("launch")
            .and_then(|launch| launch.get("command"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        if command.is_empty() {
            return None;
        }
        let registry = self.agents.read().await;
        registry.identify_command(command).map(|(kind, _)| kind)
    }

    fn spawn_agent_watch(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(AGENT_WATCH_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                this.agent_watch_tick().await;
            }
        });
    }

    /// One detection pass. Detection is tied to the agent command lifecycle:
    /// only panes with an active agent command (armed) or an in-flight agent
    /// lifecycle (a current snapshot — error hold, reconnect) are inspected.
    /// Everything else is skipped entirely, so no process snapshot is taken
    /// unless an agent is actually (or was recently) running.
    async fn agent_watch_tick(&self) {
        let sessions: Vec<(
            i32,
            Option<u32>,
            Arc<Mutex<crate::terminal::agent::AgentDetector>>,
            bool,
        )> = {
            let sessions = self.sessions.lock().await;
            sessions
                .iter()
                .map(|(id, session)| {
                    let has_current = session
                        .agent
                        .try_lock()
                        .ok()
                        .map(|detector| detector.current.is_some())
                        .unwrap_or(false);
                    (
                        *id,
                        session.child.process_id(),
                        Arc::clone(&session.agent),
                        has_current,
                    )
                })
                .collect()
        };
        if sessions.is_empty() {
            return;
        }
        let armed: HashMap<i32, (AgentKind, u64)> = self.agent_arms.lock().await.clone();
        let generations = self.agent_generations.lock().await.clone();
        let active: Vec<(
            i32,
            Option<u32>,
            Arc<Mutex<crate::terminal::agent::AgentDetector>>,
            u64,
        )> = sessions
            .into_iter()
            .filter(|(pane_id, _, _, has_current)| armed.contains_key(pane_id) || *has_current)
            .map(|(pane_id, pid, detector, _)| {
                (
                    pane_id,
                    pid,
                    detector,
                    generations.get(&pane_id).copied().unwrap_or(0),
                )
            })
            .collect();
        if active.is_empty() {
            return;
        }
        // `ps` is a synchronous subprocess. Running it on Tokio's executor
        // was the main source of visible lag during agent startup and under
        // multiple panes. Keep the async watch loop responsive by isolating
        // process discovery on the blocking pool.
        let Some(ps) = tokio::task::spawn_blocking(crate::terminal::agent::process::PsSnapshot::capture)
            .await
            .ok()
            .flatten()
        else {
            return;
        };
        let now = now_ms();

        for (pane_id, root_pid, detector, generation) in active {
            let armed_kind = armed.get(&pane_id).map(|(kind, _)| *kind);
            let armed_since = armed.get(&pane_id).map(|(_, at)| *at).unwrap_or(0);
            // Read the registry per-pane and clone the matched mechanism so the
            // guard drops before any await (a settings write must never be
            // starved by a long tick).
            let found = {
                let registry = self.agents.read().await;
                registry.identify(&ps, root_pid).and_then(|(kind, name)| {
                    registry
                        .mechanism(kind)
                        .map(|mech| (Arc::clone(mech), name))
                })
            };
            // Prefer the armed command's agent; the process tree confirms it
            // (and supplies the process name). An armed pane whose process is
            // gone or a different agent reads as closed.
            let mech = match armed_kind {
                Some(kind) => match &found {
                    Some((mech, name)) if mech.kind() == kind => {
                        Some((Arc::clone(mech), name.clone()))
                    }
                    _ => None,
                },
                None => found.clone(),
            };

            // Once the armed agent's process is gone — or resolves to a
            // different agent / was disabled in settings (`mech` None) — past
            // the confirm window, the command lifecycle is over even if
            // `CmdEnd` was missed (launch mode has no shell integration; a
            // killed agent may not emit one).
            let lifecycle_over = armed_kind.is_some()
                && mech.is_none()
                && now.saturating_sub(armed_since) >= ARM_CONFIRM_MS;
            if lifecycle_over {
                self.agent_arms.lock().await.remove(&pane_id);
                let generation = self.bump_agent_generation(pane_id).await;
                detector.lock().await.clear_arm();
                tracing::debug!(
                    pane_id,
                    generation,
                    ?armed_kind,
                    "agent arm dropped — no matching process within the confirm window"
                );
            }

            let det = detector.lock().await;
            let next = det.detect(
                mech.as_ref()
                    .map(|(mech, name)| (mech.as_ref(), name.clone())),
                now,
            );
            if !det.changed(&next) {
                continue;
            }
            let error_transition = matches!(&next, Some(s) if s.status == "error")
                && det.current.as_ref().map(|c| c.status.as_str()) != Some("error");
            drop(det);

            // The snapshot is only recorded as persisted *after* the host
            // write succeeds. Marking it before — while swallowing write
            // errors — could silently drop a pane from detection forever: the
            // in-memory state would say "detected", `changed()` would stay
            // false, and the failed `extra.agent` write would never retry. On
            // a transient failure the next tick re-sees the change and retries.
            match next {
                Some(snapshot) => {
                    if !self.is_current_agent_generation(pane_id, generation).await {
                        continue;
                    }
                    if self.persist_agent(pane_id, &snapshot, generation).await {
                        if error_transition {
                            self.notify_agent_error(pane_id, &snapshot).await;
                        }
                        let write_lock = self.agent_write_lock(pane_id).await;
                        let _write_guard = write_lock.lock().await;
                        if self.is_current_agent_generation(pane_id, generation).await {
                            detector.lock().await.mark_persisted(Some(snapshot));
                        }
                    }
                }
                None => {
                    if self.clear_agent(pane_id, Some(generation)).await {
                        let mut detector = detector.lock().await;
                        detector.mark_persisted(None);
                        detector.clear_arm();
                    }
                }
            }
        }

        self.publish_agents_view().await;
    }

    /// Rebuild and publish the status-bar `agents` action view: one colored
    /// element per pane running a coding agent, clickable to focus the pane.
    /// The host dedups identical broadcasts; we additionally skip round-trips
    /// when nothing changed. An empty view hides the action entirely.
    ///
    /// Published as a global action (workspace 0): every workspace sees all
    /// detected agents. The addon has no pane→workspace mapping, so agents in
    /// a workspace that isn't loaded client-side won't be focusable — the
    /// common single-workspace case works fully.
    async fn publish_agents_view(&self) {
        // Clone the detector handles under the sessions guard (no await inside),
        // then lock each detector — the guard may not span an await because
        // PtySession holds non-`Sync` PTY writers.
        let detectors: Vec<(i32, Arc<Mutex<crate::terminal::agent::AgentDetector>>)> = {
            let sessions = self.sessions.lock().await;
            sessions
                .iter()
                .map(|(pane_id, session)| (*pane_id, Arc::clone(&session.agent)))
                .collect()
        };
        let mut entries: Vec<(i32, AgentSnapshot)> = Vec::new();
        for (pane_id, detector) in detectors {
            let det = detector.lock().await;
            if let Some(snapshot) = &det.current {
                entries.push((pane_id, snapshot.clone()));
            }
        }
        entries.sort_by_key(|(pane_id, _)| *pane_id);

        let mut elements = Vec::new();
        for (index, (pane_id, snapshot)) in entries.iter().enumerate() {
            if index > 0 {
                elements.push(serde_json::json!({
                    "type": "separator",
                    "value": "|",
                    "color": "",
                }));
            }
            let color = match snapshot.status.as_str() {
                "error" => AGENT_COLOR_ERROR,
                "idle" => AGENT_COLOR_IDLE,
                "blocked" => AGENT_COLOR_BLOCKED,
                _ => AGENT_COLOR_WORKING,
            };
            // Surfacing the last message inline (truncated) makes errors and
            // blockers visible without hovering; the tooltip carries the rest.
            // Working agents get a braille spinner, animated by the wall clock:
            // the 400ms watch tick re-publishes, and each frame is a different
            // payload so the dedup below lets it rotate. Other statuses keep a
            // static `●` (identical payloads dedup, so idle/error views stay
            // still instead of flickering).
            let glyph = if snapshot.status == "working" {
                SPINNER_FRAMES[(now_ms() / 80) as usize % SPINNER_FRAMES.len()]
            } else {
                "●"
            };
            let mut value = format!("{} {} · {}", glyph, snapshot.display, snapshot.status);
            if let Some(message) = &snapshot.message {
                let truncated: String = message.chars().take(48).collect();
                let suffix = if message.chars().count() > 48 {
                    "…"
                } else {
                    ""
                };
                value.push_str(&format!(" — {}{}", truncated, suffix));
            }
            elements.push(serde_json::json!({
                "type": "text",
                "value": value,
                "color": color,
                "data": {
                    "pane_id": pane_id,
                    "title": snapshot.message.clone().unwrap_or_default(),
                },
            }));
        }

        let payload = serde_json::json!({ "view": elements });
        let payload_key = payload.to_string();
        {
            let last = self.last_agents_view.lock().await;
            if last.as_deref() == Some(payload_key.as_str()) {
                return;
            }
        }
        if let Err(e) = self.ctx.set_action(AGENTS_ACTION_ID, 0, &payload).await {
            // Don't cache on failure so the next tick retries.
            tracing::warn!("failed to publish agents action view: {}", e);
            return;
        }
        *self.last_agents_view.lock().await = Some(payload_key);
    }

    async fn agent_write_lock(&self, pane_id: i32) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.agent_write_locks.lock().await;
        locks
            .entry(pane_id)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Persist `extra.agent` + pane status. The pane stays in the Agents
    /// collection for as long as `extra.agent` exists (host rule-driven).
    /// Returns whether the `extra.agent` write succeeded — the caller only
    /// records the snapshot as persisted when it did, so a transient failure
    /// is retried on the next watch tick instead of dropping the pane
    /// silently.
    async fn persist_agent(&self, pane_id: i32, snapshot: &AgentSnapshot, generation: u64) -> bool {
        let write_lock = self.agent_write_lock(pane_id).await;
        let _write_guard = write_lock.lock().await;
        // Re-check while holding the same lock used by clear_agent. If the
        // lifecycle ended while this write was queued, never resurrect the
        // stale snapshot.
        if !self.is_current_agent_generation(pane_id, generation).await {
            return false;
        }
        let mut extra = self
            .ctx
            .get_extra_json(pane_id)
            .await
            .unwrap_or_else(|_| serde_json::json!({}));
        if !extra.is_object() {
            extra = serde_json::json!({});
        }
        if let Some(obj) = extra.as_object_mut() {
            obj.insert(
                "agent".to_string(),
                serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null),
            );
        }
        if self.ctx.set_extra(pane_id, &extra).await.is_err() {
            tracing::warn!(pane_id, agent = %snapshot.kind, "failed to persist extra.agent");
            return false;
        }
        // Drive the pane's dynamic name/icon from the agent identity: while an
        // agent runs, the pane shows the agent's display name (e.g. "Pi") and
        // an `agent:<id>` icon (rendered as a per-agent glyph client-side).
        // The user's manually-set name/icon still win — the host resolves
        // manual → temp → default. Cleared again in `clear_agent` when the
        // agent closes, restoring the plain terminal identity.
        let _ = self.ctx.set_temp_name(pane_id, &snapshot.display).await;
        let _ = self
            .ctx
            .set_temp_icon(pane_id, &format!("agent:{}", snapshot.kind))
            .await;
        // The pane's own status field is the single source of truth for agent
        // state — the agent snapshot keeps its status in memory only and is
        // never persisted into `extra.agent` (see `AgentSnapshot::status`).
        // An agent waiting at its prompt is `idle`, one waiting on a question
        // (permission dialog, y/n) is `blocked`, and only active work is
        // `working` (distinct from a generic command's `running`).
        let status = match snapshot.status.as_str() {
            "error" => "error",
            "working" => "working",
            "blocked" => "blocked",
            _ => "idle",
        };
        let _ = self.ctx.set_status(pane_id, status).await;
        tracing::debug!(
            pane_id,
            agent = %snapshot.kind,
            status = %snapshot.status,
            "agent state persisted"
        );
        true
    }

    /// Release a held agent error: the agent already exited with a failure and
    /// the watch loop is displaying the error during the failure window. Called
    /// when the user runs a normal command — the stale error must not pin the
    /// pane. Mirrors the watch loop's `None` clear path (generation bump, then
    /// clear `extra.agent` and reset the detector).
    async fn release_held_agent_error(&self, pane_id: i32) {
        let generation = self.bump_agent_generation(pane_id).await;
        if self.clear_agent(pane_id, Some(generation)).await {
            if let Some(session) = self.sessions.lock().await.get(&pane_id) {
                let mut detector = session.agent.lock().await;
                detector.mark_persisted(None);
                detector.clear_arm();
            }
            // The pane just left the Agents collection — refresh the status-bar
            // agents view so the stale error entry doesn't linger.
            self.publish_agents_view().await;
        }
    }

    /// Remove `extra.agent` so the pane leaves the Agents collection.
    /// Returns whether the removal write succeeded (or there was nothing to
    /// remove) — on failure the caller keeps the in-memory snapshot so the
    /// next watch tick retries.
    async fn clear_agent(&self, pane_id: i32, expected_generation: Option<u64>) -> bool {
        let write_lock = self.agent_write_lock(pane_id).await;
        let _write_guard = write_lock.lock().await;
        if let Some(generation) = expected_generation {
            if !self.is_current_agent_generation(pane_id, generation).await {
                return false;
            }
        }
        let mut extra = self
            .ctx
            .get_extra_json(pane_id)
            .await
            .unwrap_or_else(|_| serde_json::json!({}));
        let had_agent = extra.get("agent").is_some();
        // Don't force status to idle when another command is already running
        // (the OSC watcher may have just set `running`).
        let is_running = extra
            .get("running")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if had_agent {
            if let Some(obj) = extra.as_object_mut() {
                obj.remove("agent");
            }
            if self.ctx.set_extra(pane_id, &extra).await.is_err() {
                tracing::warn!(pane_id, "failed to clear extra.agent");
                return false;
            }
            // Restore the pane's own identity — drop the agent-driven icon;
            // the temp name falls back to the current directory (or a running
            // command).
            let _ = self.ctx.set_temp_icon(pane_id, "").await;
            self.update_temp_name(pane_id, "").await;
            if !is_running {
                let _ = self.ctx.set_status(pane_id, "idle").await;
            }
        }
        tracing::debug!(pane_id, "agent state cleared");
        true
    }

    async fn notify_agent_error(&self, pane_id: i32, snapshot: &AgentSnapshot) {
        let body = snapshot
            .message
            .clone()
            .unwrap_or_else(|| "Agent exited with an error".to_string());
        let _ = self
            .ctx
            .notify(
                pane_id,
                &format!("{} error", snapshot.display),
                &body,
                "error",
                false,
                None,
            )
            .await;
    }

    /// Returns `true` when the exit code corresponds to a user-initiated cancellation.
    /// 130 = 128 + SIGINT, which is what Ctrl+C sends to the foreground process.
    fn is_cancellation(exit_code: i32) -> bool {
        exit_code == 130
    }

    /// Recompute and persist the pane's dynamic temp name: the running
    /// command's program while a command is running (`CmdStart`), otherwise
    /// the basename of the pane's current directory. Agent panes are excluded
    /// — the agent watch loop owns their name (`persist_agent` /
    /// `clear_agent`), so a generic command or cwd change never stomps the
    /// agent identity.
    async fn update_temp_name(&self, pane_id: i32, running_cmd: &str) {
        if self.is_agent_pane(pane_id).await {
            return;
        }
        let cwd = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&pane_id)
                .and_then(|s| s.cwd.try_lock().ok())
                .and_then(|c| c.clone())
        };
        let base = Self::dynamic_temp_name(running_cmd, cwd.as_deref());
        // With `temp_cwd` enabled, an idle pane inside a git working tree
        // shows the repository name instead of the immediate folder name.
        let name = if running_cmd.trim().is_empty() && self.use_git_repo_name().await {
            Self::git_repo_name(cwd.as_deref().unwrap_or("")).unwrap_or(base)
        } else {
            base
        };
        let _ = self.ctx.set_temp_name(pane_id, &name).await;
    }

    /// The repository root folder name when `dir` is inside a git working
    /// tree (`~/code/zem` → `zem`), else `None`. Walks up until a `.git`
    /// entry (directory or file — covers submodules and worktrees) is found.
    fn git_repo_name(dir: &str) -> Option<String> {
        if dir.is_empty() {
            return None;
        }
        let mut current = std::path::Path::new(dir);
        loop {
            if current.join(".git").exists() {
                return current
                    .file_name()
                    .map(|f| f.to_string_lossy().into_owned());
            }
            current = current.parent()?;
        }
    }

    /// The pane's dynamic temp name: the running command's program while one
    /// is running, else the current directory's basename.
    fn dynamic_temp_name(running_cmd: &str, cwd: Option<&str>) -> String {
        if let Some(program) = running_cmd.split_whitespace().next() {
            if !program.is_empty() {
                return program.to_string();
            }
        }
        cwd.and_then(|c| std::path::Path::new(c).file_name())
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_name_uses_running_program() {
        assert_eq!(
            SessionManager::dynamic_temp_name("vim foo.txt", Some("/tmp")),
            "vim"
        );
        assert_eq!(
            SessionManager::dynamic_temp_name("npm run dev", Some("/proj")),
            "npm"
        );
        assert_eq!(
            SessionManager::dynamic_temp_name("claude", Some("/proj")),
            "claude"
        );
        assert_eq!(
            SessionManager::dynamic_temp_name("sudo htop", Some("/")),
            "sudo"
        );
    }

    #[test]
    fn dynamic_name_falls_back_to_cwd_basename() {
        assert_eq!(
            SessionManager::dynamic_temp_name("", Some("/Users/me/code/zem")),
            "zem"
        );
        assert_eq!(
            SessionManager::dynamic_temp_name("   ", Some("/var/log")),
            "log"
        );
        assert_eq!(SessionManager::dynamic_temp_name("", Some("/")), "");
        assert_eq!(SessionManager::dynamic_temp_name("", None), "");
    }

    #[test]
    fn git_repo_name_finds_repo_root_upwards() {
        let dir = std::env::temp_dir().join(format!("zem-git-name-test-{}", std::process::id()));
        let nested = dir.join("src");
        std::fs::create_dir_all(&nested).expect("create temp dirs");
        std::fs::write(dir.join(".git"), "gitdir: fake").expect("create .git");

        assert_eq!(
            SessionManager::git_repo_name(nested.to_str().unwrap()),
            dir.file_name().map(|f| f.to_string_lossy().into_owned())
        );
        assert_eq!(
            SessionManager::git_repo_name(dir.to_str().unwrap()),
            dir.file_name().map(|f| f.to_string_lossy().into_owned())
        );
        // A sibling dir without `.git` up the tree → None.
        let plain = std::env::temp_dir().join(format!("zem-plain-dir-{}", std::process::id()));
        std::fs::create_dir_all(&plain).expect("create plain dir");
        assert_eq!(SessionManager::git_repo_name(plain.to_str().unwrap()), None);
        assert_eq!(SessionManager::git_repo_name(""), None);

        let _ = std::fs::remove_dir_all(&plain);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
