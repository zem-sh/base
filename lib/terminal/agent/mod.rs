//! Headless coding-agent detection and tracking for terminal panes.
//!
//! This module inspects the process tree of each PTY session (like the herdr
//! terminal's agent detection) to determine *which* coding agent is running
//! (`claude`, `codex`, ...), and matches the recent terminal output tail
//! against per-agent status patterns to determine *what* the agent is doing
//! (`working`, `idle` waiting at its prompt, `blocked` on a question,
//! `error`).
//!
//! The system is deliberately data-driven and pluggable:
//!   * [`AgentMechanism`] is the extension point — implement it and register it
//!     on an [`AgentRegistry`] to add a brand-new agent with custom
//!     identification and status logic.
//!   * For the common case, a [`AgentProfile`] entry (kind + display name +
//!     executable aliases + path fragments) is all that is needed; status
//!     matching falls back to shared default patterns.
//!
//! Detection is headless: it runs as a background tick in
//! [`crate::terminal::session::SessionManager`] and communicates with the host purely
//! through pane metadata (`extra.agent`, pane status, notifications) and the
//! `sh.zem.base:agent` collection, which the host auto-assigns via its
//! `extra.agent` collection rule while `extra.agent` is present.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub mod process;
pub mod screen;

const MAX_TAIL_BYTES: usize = 32 * 1024;
const ERROR_GRACE_MS: u64 = 60_000;
const FAILURE_WINDOW_MS: u64 = 60_000;
const MESSAGE_MAX_CHARS: usize = 240;
/// A pane whose last output is older than this is considered "quiet" — used
/// to tell "at the prompt, done" from "at the prompt but actively drawing"
/// when the terminal title carries no working/idle signal.
const QUIET_MS: u64 = 1200;
/// A title older than this no longer counts as a *working* spinner — agents
/// refresh the title on every spinner tick while working, so a stale spinner
/// with a quiet screen means the agent has finished and the idle-title update
/// was missed (or the agent never cleared it).
const TITLE_STALE_MS: u64 = 5000;
/// A screen error marker counts as *current* only while its row was painted
/// within this margin of the screen's latest content change. TUI agents (Pi,
/// OpenCode) keep a failed request's error line in their on-screen
/// conversation scrollback forever, even after the model recovers — without
/// this gate, the error status could never clear. A retry counter or fresh
/// error repaints the row continuously, so it stays current; once newer
/// content renders below it, the row goes stale and the error clears.
const SCREEN_ERROR_BATCH_MS: u64 = 3000;
/// A freshly armed agent (its command just started) is treated as Idle for
/// this long unless it shows a real working/error signal. The agent is
/// booting to its prompt — opening `claude`/`pi` must not flash "working"
/// while the banner prints. Real signals (a working title spinner, screen
/// working markers, an error) still win during the grace.
const ARMED_GRACE_MS: u64 = 5000;

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

/// Canonical set of supported coding agents (mirrors the herdr terminal's
/// agent list so detection behavior matches what users already expect).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentKind {
    Pi,
    Claude,
    Codex,
    Gemini,
    Cursor,
    Devin,
    Antigravity,
    Cline,
    Omp,
    Mastracode,
    OpenCode,
    GithubCopilot,
    Kimi,
    Kiro,
    Droid,
    Amp,
    Grok,
    Hermes,
    Kilo,
    Qodercli,
    Maki,
}

impl AgentKind {
    /// All supported agent kinds, in declaration order (mirrors the herdr list).
    pub const ALL: [AgentKind; 21] = [
        AgentKind::Pi,
        AgentKind::Claude,
        AgentKind::Codex,
        AgentKind::Gemini,
        AgentKind::Cursor,
        AgentKind::Devin,
        AgentKind::Antigravity,
        AgentKind::Cline,
        AgentKind::Omp,
        AgentKind::Mastracode,
        AgentKind::OpenCode,
        AgentKind::GithubCopilot,
        AgentKind::Kimi,
        AgentKind::Kiro,
        AgentKind::Droid,
        AgentKind::Amp,
        AgentKind::Grok,
        AgentKind::Hermes,
        AgentKind::Kilo,
        AgentKind::Qodercli,
        AgentKind::Maki,
    ];

    /// Canonical identifier used in `extra.agent.kind` and matching.
    pub fn id(self) -> &'static str {
        match self {
            AgentKind::Pi => "pi",
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Gemini => "gemini",
            AgentKind::Cursor => "cursor",
            AgentKind::Devin => "devin",
            AgentKind::Antigravity => "agy",
            AgentKind::Cline => "cline",
            AgentKind::Omp => "omp",
            AgentKind::Mastracode => "mastracode",
            AgentKind::OpenCode => "opencode",
            AgentKind::GithubCopilot => "copilot",
            AgentKind::Kimi => "kimi",
            AgentKind::Kiro => "kiro",
            AgentKind::Droid => "droid",
            AgentKind::Amp => "amp",
            AgentKind::Grok => "grok",
            AgentKind::Hermes => "hermes",
            AgentKind::Kilo => "kilo",
            AgentKind::Qodercli => "qodercli",
            AgentKind::Maki => "maki",
        }
    }
}

// ---------------------------------------------------------------------------
// Agent status
// ---------------------------------------------------------------------------

/// What an agent is currently doing inside the pane, surfaced as the pane's
/// own `status` field (working / idle / blocked / error).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus {
    /// Agent is actively working.
    Working,
    /// Agent is alive and at its input prompt, waiting for the user to send
    /// a message. Maps to the pane status `idle`.
    Idle,
    /// Agent is waiting on the user to answer a question — a permission
    /// dialog, a y/n prompt, a select menu, etc. Maps to the pane status
    /// `blocked` so it is distinguishable from a plain idle prompt.
    Blocked,
    /// Agent failed (non-zero exit or error output at the prompt).
    Error,
}

impl AgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatus::Working => "working",
            AgentStatus::Idle => "idle",
            AgentStatus::Blocked => "blocked",
            AgentStatus::Error => "error",
        }
    }
}

// ---------------------------------------------------------------------------
// Persisted snapshot (stored under pane `extra.agent`)
// ---------------------------------------------------------------------------

/// The agent state persisted on the pane as `extra.agent`. The host renders
/// this in the sidebar and uses its mere presence to keep the pane in the
/// Agents collection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentSnapshot {
    /// Canonical agent id, e.g. `"claude"`.
    pub kind: String,
    /// Human label, e.g. `"Claude Code"`.
    pub display: String,
    /// One of `working` / `idle` / `blocked` / `error`. **In-memory only** —
    /// the pane's own `status` field is the single persisted status (the
    /// addon drives it via `set_status`), so this is never written into
    /// `extra.agent`.
    #[serde(skip)]
    pub status: String,
    /// Last error/question text captured from the output tail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The process name that was matched (for diagnostics).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    /// Unix ms when the agent was first detected in this pane.
    pub since_ms: u64,
    /// Unix ms of the last state change.
    pub updated_ms: u64,
}

impl AgentSnapshot {
    fn equals_ignoring_updated(&self, other: &AgentSnapshot) -> bool {
        self.kind == other.kind
            && self.display == other.display
            && self.status == other.status
            && self.message == other.message
            && self.process == other.process
            && self.since_ms == other.since_ms
    }
}

// ---------------------------------------------------------------------------
// Detection context
// ---------------------------------------------------------------------------

/// Everything a mechanism needs to decide the agent's status.
///
/// * `tail` — the sanitized output tail (primary text signal for line-based
///   agents like Claude).
/// * `screen` — the reconstructed *current visible screen* (see [`screen`]).
///   Full-screen TUI agents (OpenCode, Pi, ...) repaint cells at absolute
///   positions and never produce a linear last-line, so their state can only
///   be read from the screen snapshot.
/// * `title` — the latest terminal title (OSC 0/2). Claude/Codex write a
///   braille spinner (U+2800–U+28FF) into the title *while working* and a
///   static marker (`✳`, plain text, "Action Required") when idle. Because
///   the input prompt stays on screen while the agent works, this is the most
///   reliable "working right now" signal for title-driven agents.
/// * `quiet` — no raw output bytes for the quiet window (tail-based).
/// * `screen_quiet` — the reconstructed screen content has been unchanged
///   for the quiet window. TUI cursor blinks don't repaint cells, so this is
///   the reliable "static screen" signal for TUI agents.
/// * `title_fresh` — the title was updated within the staleness window. A
///   stale spinner title (agent finished but never cleared it) must not keep
///   the status Working.
/// * `screen_error_fresh` — the screen contains an error marker on a row that
///   was painted in the same recent batch as the latest content change. TUI
///   agents keep stale error lines in their on-screen scrollback, so a bare
///   marker anywhere on the screen is not enough — it must be *current*.
/// * `armed_grace` — the agent command started within the arming grace. A
///   just-launched agent is booting to its prompt: without a real working or
///   error signal it reports Idle instead of falling through to the per-agent
///   default (so opening `claude` doesn't flash "working" while it boots).
///
/// Note: the interactive shell's OSC 133 command markers are *not* a status
/// signal — launching the agent (`claude`, `codex`, ...) is itself a
/// foreground command, so a "running command" is indistinguishable from the
/// agent sitting at its prompt.
#[derive(Debug)]
pub struct StatusContext<'a> {
    pub tail: &'a str,
    pub screen: &'a str,
    pub title: &'a str,
    pub quiet: bool,
    pub screen_quiet: bool,
    pub title_fresh: bool,
    /// Whether a *current* (recently-painted) screen row carries an error
    /// marker — computed by the detector from the screen model's row paint
    /// times, so stale scrollback errors don't pin the status.
    pub screen_error_fresh: bool,
    /// The agent command started within the arming grace (booting to its
    /// prompt — treat as Idle unless a real working/error signal appears).
    pub armed_grace: bool,
}

// ---------------------------------------------------------------------------
// Pluggable mechanism
// ---------------------------------------------------------------------------

/// The extension point for agent detection.
///
/// To add a new coding agent: implement this trait and call
/// [`AgentRegistry::register`]. For the common case wrap an
/// [`AgentProfile`] instead — identity + shared status patterns are enough.
pub trait AgentMechanism: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn display(&self) -> &'static str;
    /// Executable names (basenames) that identify this agent. Lowercased and
    /// extension-stripped before matching.
    fn aliases(&self) -> &'static [&'static str];
    /// Substrings that, when found in a process command line, identify this
    /// agent (used for node/python-wrapped installs, e.g.
    /// `node .../node_modules/@anthropic-ai/claude-code/cli.js`).
    fn path_fragments(&self) -> &'static [&'static str] {
        &[]
    }
    /// Prompt glyphs that mean "at the input prompt, waiting for the user"
    /// — but only while they are the *last* output line (a submitted prompt
    /// line lingers in the scrollback while the agent works).
    fn prompt_markers(&self) -> &[String] {
        &DEFAULT_PROMPT_MARKERS
    }
    /// Markers in the recent output tail that mean "waiting for user input"
    /// (permission questions, y/n, select prompts). Custom per-agent markers
    /// (from settings) replace the defaults when set.
    fn blocked_markers(&self) -> &[String] {
        &DEFAULT_BLOCKED_MARKERS
    }
    /// Markers in the last output lines that mean "failed".
    fn error_markers(&self) -> &[String] {
        &DEFAULT_ERROR_MARKERS
    }
    /// Markers that, when present on the *current screen*, mean the agent is
    /// actively working. TUI agents repaint these only while working (e.g.
    /// OpenCode's "esc to interrupt" hint, Pi's "Working..."); line-based,
    /// title-driven agents (Claude) leave this empty.
    fn working_markers(&self) -> &[String] {
        &[]
    }
    /// Whether a braille spinner character (U+2800–U+28FF) on the current
    /// screen means the agent is actively working. Pi repaints its spinner
    /// row for the whole thinking phase — the char itself is a more reliable
    /// "working now" signal than the adjacent text, which changes
    /// ("Working...", "Reading files...", ...) while the spinner keeps
    /// spinning. Substring markers can't express a *range*, hence the hook.
    fn braille_working(&self) -> bool {
        false
    }
    /// Status when no signal matches. Streaming/title-driven agents default
    /// to Working (streaming output = active work); full-screen TUI agents
    /// default to Idle — for them, the absence of working markers on a
    /// repainted screen is the idle signal.
    fn default_status(&self) -> AgentStatus {
        AgentStatus::Working
    }
    fn detect_status(&self, ctx: &StatusContext) -> AgentStatus {
        status_from_markers(
            self.prompt_markers(),
            self.blocked_markers(),
            self.error_markers(),
            self.working_markers(),
            self.braille_working(),
            self.default_status(),
            ctx,
        )
    }
    fn extract_message(&self, ctx: &StatusContext, status: AgentStatus) -> Option<String> {
        match status {
            AgentStatus::Error => error_message(ctx.tail, ctx.screen, self.error_markers()),
            AgentStatus::Blocked => blocked_message(ctx.tail, ctx.screen, self.blocked_markers()),
            AgentStatus::Idle => {
                if self.default_status() == AgentStatus::Idle {
                    // Full-screen TUI agent: the static layout carries no
                    // meaningful message (a waiting question is `Blocked` and
                    // gets its own message), so the sidebar shows just the
                    // agent name + status otherwise.
                    None
                } else {
                    idle_message(ctx.tail, ctx.screen)
                }
            }
            AgentStatus::Working => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Data-driven profile (the common case)
// ---------------------------------------------------------------------------

/// A data-driven [`AgentMechanism`] backed by a static profile row. This is
/// how the built-in agents are declared — adding one is a single table entry.
pub struct AgentProfile {
    pub kind: AgentKind,
    pub display: &'static str,
    pub aliases: &'static [&'static str],
    pub path_fragments: &'static [&'static str],
    /// Screen-content markers meaning "working" (TUI agents only). Empty for
    /// line/title-driven agents.
    pub working_markers: Vec<String>,
    /// Whether any braille spinner char (U+2800–U+28FF) on the current screen
    /// means "working" (Pi's `⠧ Working...` spinner).
    pub braille_working: bool,
    /// Fallback status when no marker matches — `Idle` for full-screen TUI
    /// agents, `Working` for streaming/title-driven agents.
    pub default_status: AgentStatus,
}

impl AgentProfile {
    fn profile(
        kind: AgentKind,
        display: &'static str,
        aliases: &'static [&'static str],
        path_fragments: &'static [&'static str],
    ) -> Self {
        Self {
            kind,
            display,
            aliases,
            path_fragments,
            working_markers: Vec::new(),
            braille_working: false,
            default_status: AgentStatus::Working,
        }
    }

    /// Mark a profile as a full-screen TUI agent: the given screen markers
    /// mean "working", and the fallback is Idle (their screen, not a linear
    /// tail, is the source of truth).
    fn tui_agent(mut self, working_markers: &[&str]) -> Self {
        self.working_markers = working_markers.iter().map(|s| s.to_string()).collect();
        self.default_status = AgentStatus::Idle;
        self
    }

    /// `tui_agent` plus the braille spinner signal: any U+2800–U+28FF char
    /// on the current screen means "working" (Pi's `⠧ Working...`).
    fn tui_agent_with_braille(self, working_markers: &[&str]) -> Self {
        let mut me = self.tui_agent(working_markers);
        me.braille_working = true;
        me
    }
}

impl AgentMechanism for AgentProfile {
    fn kind(&self) -> AgentKind {
        self.kind
    }
    fn display(&self) -> &'static str {
        self.display
    }
    fn aliases(&self) -> &'static [&'static str] {
        self.aliases
    }
    fn path_fragments(&self) -> &'static [&'static str] {
        self.path_fragments
    }
    fn working_markers(&self) -> &[String] {
        &self.working_markers
    }
    fn braille_working(&self) -> bool {
        self.braille_working
    }
    fn default_status(&self) -> AgentStatus {
        self.default_status
    }
}

/// The built-in agent profiles. Kept in sync with the herdr agent list.
/// Full-screen TUI agents (Pi, OpenCode) carry screen working-markers and
/// default to Idle; line/title-driven agents (Claude, ...) keep the shared
/// tail/title heuristics with a Working fallback.
fn builtin_profiles() -> Vec<AgentProfile> {
    vec![
        AgentProfile::profile(
            AgentKind::Pi,
            "Pi",
            &["pi"],
            &[
                "pi-coding-agent",
                "@earendil-works/pi-coding-agent",
                "@mariozechner/pi-coding-agent",
            ],
        )
        .tui_agent_with_braille(&["working...", "esc interrupt", "■■■■", "⬝⬝⬝⬝"]),
        AgentProfile::profile(
            AgentKind::Claude,
            "Claude Code",
            &["claude", "claude-code"],
            &["@anthropic-ai/claude-code"],
        ),
        AgentProfile::profile(AgentKind::Codex, "Codex", &["codex"], &[]),
        AgentProfile::profile(AgentKind::Gemini, "Gemini CLI", &["gemini"], &[]),
        AgentProfile::profile(
            AgentKind::Cursor,
            "Cursor",
            &["cursor", "cursor-agent"],
            &[],
        ),
        AgentProfile::profile(AgentKind::Devin, "Devin", &["devin", "devin-cli"], &[]),
        AgentProfile::profile(
            AgentKind::Antigravity,
            "Antigravity",
            &["agy", "antigravity", "antigravity-cli"],
            &[],
        ),
        AgentProfile::profile(AgentKind::Cline, "Cline", &["cline"], &[]),
        AgentProfile::profile(AgentKind::Omp, "OMP", &["omp"], &[]),
        AgentProfile::profile(
            AgentKind::Mastracode,
            "Mastra Code",
            &["mastracode", "mastra-code"],
            &[],
        ),
        AgentProfile::profile(
            AgentKind::OpenCode,
            "OpenCode",
            &["opencode", "opencode2", "open-code"],
            &["@opencode-ai"],
        )
        .tui_agent(&[
            "esc to interrupt",
            "esc again to interrupt",
            "press esc to interrupt",
            "esc interrupt",
            "ctrl+c to interrupt",
            "■■■■",
            "⬝⬝⬝⬝",
        ]),
        AgentProfile::profile(
            AgentKind::GithubCopilot,
            "GitHub Copilot",
            &["copilot", "github-copilot", "ghcs"],
            &[],
        ),
        AgentProfile::profile(AgentKind::Kimi, "Kimi Code", &["kimi", "kimi-code"], &[]),
        AgentProfile::profile(AgentKind::Kiro, "Kiro", &["kiro", "kiro-cli"], &[]),
        AgentProfile::profile(AgentKind::Droid, "Droid", &["droid"], &[]),
        AgentProfile::profile(AgentKind::Amp, "Amp", &["amp", "amp-local"], &[]),
        AgentProfile::profile(AgentKind::Grok, "Grok", &["grok", "grok-build"], &[]),
        AgentProfile::profile(
            AgentKind::Hermes,
            "Hermes",
            &["hermes", "hermes-agent"],
            &[],
        ),
        AgentProfile::profile(AgentKind::Kilo, "Kilo Code", &["kilo", "kilo-code"], &[]),
        AgentProfile::profile(
            AgentKind::Qodercli,
            "Qoder",
            &["qodercli", "qoderclicn", "qoder"],
            &[],
        ),
        AgentProfile::profile(AgentKind::Maki, "Maki", &["maki"], &[]),
    ]
}

// ---------------------------------------------------------------------------
// Per-agent user settings
// ---------------------------------------------------------------------------

/// Per-agent configuration read from the addon settings (declared as
/// `agents.<id>.enabled | blocked | error` config fields). Custom status
/// markers replace the builtin defaults when non-empty.
#[derive(Debug, Clone)]
pub struct AgentSettings {
    /// Whether detection is enabled for this agent (default `true`).
    pub enabled: bool,
    /// Custom "waiting for input" markers, comma/newline separated.
    pub blocked: Vec<String>,
    /// Custom "failed" markers, comma/newline separated.
    pub error: Vec<String>,
}

impl AgentSettings {
    /// Parse per-agent settings from the addon settings object. The settings
    /// form persists flat field names, so keys are `agents.<id>.enabled`,
    /// `agents.<id>.blocked` and `agents.<id>.error`. Boolean values may arrive
    /// as real booleans or as the strings `"true"/"false"` the form emits.
    pub fn from_settings(settings: &serde_json::Value, agent_id: &str) -> Self {
        Self {
            enabled: setting_bool(settings, &format!("agents.{}.enabled", agent_id), true),
            blocked: parse_markers(settings.get(&format!("agents.{}.blocked", agent_id))),
            error: parse_markers(settings.get(&format!("agents.{}.error", agent_id))),
        }
    }
}

/// Read a boolean setting that may be a real boolean or the string
/// `"true"/"false"` the settings form emits. Missing/invalid → `default`.
pub(crate) fn setting_bool(settings: &serde_json::Value, key: &str, default: bool) -> bool {
    settings
        .get(key)
        .and_then(|v| match v {
            serde_json::Value::Bool(b) => Some(*b),
            serde_json::Value::String(s) => s.parse::<bool>().ok(),
            _ => None,
        })
        .unwrap_or(default)
}

/// Split a marker string (or array) on commas, semicolons and newlines.
/// Empty or absent values produce an empty list, meaning "keep the defaults".
fn parse_markers(value: Option<&serde_json::Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let text = match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect::<Vec<_>>()
            .join(","),
        _ => String::new(),
    };
    text.split([',', ';', '\n'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// An [`AgentMechanism`] decorated with per-agent user settings. Custom status
/// markers (when configured) replace the mechanism's builtin defaults.
pub struct ConfiguredMechanism {
    pub inner: Arc<dyn AgentMechanism>,
    pub settings: AgentSettings,
}

impl AgentMechanism for ConfiguredMechanism {
    fn kind(&self) -> AgentKind {
        self.inner.kind()
    }
    fn display(&self) -> &'static str {
        self.inner.display()
    }
    fn aliases(&self) -> &'static [&'static str] {
        self.inner.aliases()
    }
    fn path_fragments(&self) -> &'static [&'static str] {
        self.inner.path_fragments()
    }
    fn prompt_markers(&self) -> &[String] {
        self.inner.prompt_markers()
    }
    fn blocked_markers(&self) -> &[String] {
        if self.settings.blocked.is_empty() {
            self.inner.blocked_markers()
        } else {
            &self.settings.blocked
        }
    }
    fn error_markers(&self) -> &[String] {
        if self.settings.error.is_empty() {
            self.inner.error_markers()
        } else {
            &self.settings.error
        }
    }
    fn working_markers(&self) -> &[String] {
        self.inner.working_markers()
    }
    fn braille_working(&self) -> bool {
        self.inner.braille_working()
    }
    fn default_status(&self) -> AgentStatus {
        self.inner.default_status()
    }
}

/// Human label for an agent kind, from the builtin profile table (single
/// source of truth for display names).
pub fn display_name(kind: AgentKind) -> &'static str {
    builtin_profiles()
        .iter()
        .find(|p| p.kind == kind)
        .map(|p| p.display)
        .unwrap_or("")
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// Holds all registered [`AgentMechanism`]s and the lookup tables built from
/// them (aliases → kind, path fragments → kind).
#[derive(Default)]
pub struct AgentRegistry {
    mechanisms: Vec<Arc<dyn AgentMechanism>>,
    aliases: HashMap<String, AgentKind>,
    fragments: Vec<(&'static str, AgentKind)>,
}

impl AgentRegistry {
    pub fn builtin() -> Self {
        let mut registry = Self::default();
        for profile in builtin_profiles() {
            registry.register(Arc::new(profile));
        }
        registry
    }

    /// Rebuild the registry from the builtin profiles, applying per-agent
    /// settings (enable toggles + custom status markers). Agents disabled in
    /// settings are not registered, so process identification skips them;
    /// panes already running a disabled agent are cleared on the next watch
    /// tick (identification no longer matches → `extra.agent` removed).
    ///
    /// Keeps the identity tables (`aliases`, `fragments`) in sync, so this is
    /// the one call to make after settings change — at startup and live.
    pub fn configure(&mut self, settings: &serde_json::Value) {
        self.mechanisms.clear();
        self.aliases.clear();
        self.fragments.clear();
        // Master switch (`agents.enabled`) — the per-agent keys are
        // `agents.<id>.enabled`, so this never collides. When off, nothing is
        // registered and the next watch tick clears every pane from the
        // Agents collection.
        if !setting_bool(settings, "agents.enabled", true) {
            return;
        }
        for profile in builtin_profiles() {
            let agent_settings = AgentSettings::from_settings(settings, profile.kind.id());
            if !agent_settings.enabled {
                continue;
            }
            self.register(Arc::new(ConfiguredMechanism {
                inner: Arc::new(profile),
                settings: agent_settings,
            }));
        }
    }

    /// Register a new agent mechanism. Aliases and path fragments become
    /// available to process identification immediately.
    pub fn register(&mut self, mech: Arc<dyn AgentMechanism>) {
        for alias in mech.aliases() {
            self.aliases
                .insert(process::normalize_name(alias), mech.kind());
        }
        for frag in mech.path_fragments() {
            self.fragments.push((frag, mech.kind()));
        }
        self.mechanisms.push(mech);
    }

    pub fn mechanism(&self, kind: AgentKind) -> Option<&Arc<dyn AgentMechanism>> {
        self.mechanisms.iter().find(|m| m.kind() == kind)
    }

    /// Number of currently registered mechanisms (diagnostics / settings log).
    pub fn mechanisms_len(&self) -> usize {
        self.mechanisms.len()
    }

    /// Identify which agent is running in the process tree rooted at `root`.
    pub fn identify(
        &self,
        snapshot: &process::PsSnapshot,
        root: Option<u32>,
    ) -> Option<(AgentKind, String)> {
        snapshot.find_agent(root?, &self.aliases, &self.fragments)
    }

    /// Identify an agent from a command line — the shell integration's
    /// `CmdText` payload ("claude --resume …", "npx @anthropic-ai/claude-code",
    /// "pi"). Reuses the same scoring as process-tree identification, so the
    /// command text is the trigger for detection while the process tree
    /// confirms it. Returns the agent kind when the command is supported.
    pub fn identify_command(&self, command: &str) -> Option<(AgentKind, String)> {
        process::identify_args(command, &self.aliases, &self.fragments)
            .map(|(kind, name, _)| (kind, name))
    }
}

// ---------------------------------------------------------------------------
// Default status patterns
// ---------------------------------------------------------------------------

/// Prompt glyphs that mean "at the input prompt, waiting for the user". Only
/// counted as waiting while they are the *last* output line (a submitted prompt
/// line lingers in the scrollback while the agent works). `✻` is Claude's
/// *working* spinner and is deliberately not listed here.
static DEFAULT_PROMPT_MARKERS: LazyLock<Vec<String>> =
    LazyLock::new(|| ["❯", "▌"].iter().map(|s| s.to_string()).collect());

static DEFAULT_BLOCKED_MARKERS: LazyLock<Vec<String>> = LazyLock::new(|| {
    [
        "press enter",
        "press return",
        "press <enter>",
        "use arrow keys",
        "(use arrow keys)",
        "waiting for your response",
        "waiting for your input",
        "waiting for response",
        "waiting for input",
        "yes, and",
        "no, and",
        "allow tool",
        "allow access",
        "allow this",
        "do you want to proceed",
        "do you want to continue",
        "would you like to",
        "continue?",
        "select an option",
        "choose an option",
        "y/n",
        "(y/n)",
        "yes/no",
        "? select",
        // OpenCode's permission dialog (herdr's `permission_required` rule):
        // the dialog banner and its key-hint rows only appear while a tool
        // request awaits approval.
        "△ permission required",
        "esc dismiss",
        "enter confirm",
        "enter submit",
        "enter toggle",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
});

static DEFAULT_ERROR_MARKERS: LazyLock<Vec<String>> = LazyLock::new(|| {
    [
        "✖",
        "✗",
        "❌",
        "❎",
        "command failed",
        "failed to",
        "error:",
        "an error occurred",
        "error occurred",
        "traceback",
        "syntaxerror",
        "typeerror",
        "referenceerror",
        "nameerror",
        "valueerror",
        "keyerror",
        "indexerror",
        "attributeerror",
        "importerror",
        "modulenotfounderror",
        "fatal:",
        "fatal error",
        "exited with code",
        "unexpected error",
        "operation failed",
        // TUI agents surface provider failures as persistent status text
        // (Pi retries a failed request with this on screen).
        "internal server error",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
});

/// Fatal / startup blockers: persistent banners agents print when they can't
/// run (not logged in, missing API key, ...). Checked anywhere in the recent
/// tail — unlike the generic error markers (last lines only) because these
/// sit on screen above the prompt indefinitely.
///
/// Kept deliberately narrow: these are substring-matched across the whole
/// recent tail *before* the working-spinner check, so a generic word like
/// `authentication` or `unauthorized` (common in test suites and HTTP logs)
/// would false-positive mid-work. Only full banner phrases belong here.
static DEFAULT_FATAL_MARKERS: LazyLock<Vec<String>> = LazyLock::new(|| {
    [
        "not logged in",
        "please run /login",
        "run /login",
        "please login",
        "please log in",
        "log in to continue",
        "sign in to continue",
        "missing api key",
        "invalid api key",
        "api key required",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
});

/// Default status decision (highest priority first). Signals come from three
/// sources — the linear tail (`ctx.tail`, line-based agents), the current
/// screen (`ctx.screen`, TUI agents), and the terminal title (`ctx.title`,
/// title-driven agents):
///   1. error markers in the tail's last non-empty lines or anywhere on the
///      current screen → error — checked before the working signals so a
///      fresh prompt (`❯`) after a failure can't mask it;
///   2. fatal / startup blockers ("Not logged in", "Please run /login", ...)
///      in the recent tail or on the screen → error (persistent banners);
///   3. a *fresh* working spinner in the terminal title → running — the most
///      reliable "working right now" signal for title-driven agents;
///   4. waiting markers (permission questions, y/n prompts, select menus,
///      OpenCode's permission dialog) in the tail's last lines or on the
///      current screen → blocked — the agent is waiting on the user to
///      answer, distinct from a plain idle prompt;
///   5. the agent's working markers on the current screen (Pi's "Working..."
///      and its braille spinner `⠧`, OpenCode's "esc to interrupt",
///      progress bars) → working — TUI agents repaint these only while
///      working;
///   6. at the input prompt — `❯` as the tail's last line or a `❯` line on
///      the current screen → idle when the screen is static or a title is
///      present (typing echo must not flip the status);
///   7. an idle title marker (`✳` prefix, "Action Required") → idle;
///   8. a static screen (unchanged for the quiet window) → idle — TUI agents
///      stop redrawing when they're done, so a repaint-free screen means
///      waiting;
///   9. otherwise → the per-agent default (`Working` for streaming agents,
///      `Idle` for full-screen TUI agents).
///
/// Generic error markers are constrained to the last lines so mid-build
/// "error:" noise from a failing compile inside the agent's output doesn't
/// flip state. Agent *exit* failures are detected via the detector's own
/// last_exit signal once the process is gone.
fn status_from_markers(
    prompt_markers: &[String],
    blocked_markers: &[String],
    error_markers: &[String],
    working_markers: &[String],
    braille_working: bool,
    default_status: AgentStatus,
    ctx: &StatusContext,
) -> AgentStatus {
    let recent = recent_lines(ctx.tail, 14);
    let last_line = recent
        .iter()
        .find(|line| !line.trim().is_empty())
        .map(|line| *line)
        .unwrap_or("");
    let last = recent
        .iter()
        .filter(|line| !line.trim().is_empty())
        .take(2)
        .map(|line| *line)
        .collect::<Vec<_>>()
        .join(" ");
    let last_lower = last.to_lowercase();
    let recent_text = recent.join("\n");
    let recent_lower = recent_text.to_lowercase();
    let screen = ctx.screen;
    let screen_lower = screen.to_lowercase();

    // 1. Error markers — tail's last lines (a fresh prompt reappears right
    //    after a failure, so the error must win) or a *current* error row on
    //    the screen (TUI agents paint persistent error status text, but only
    //    while the row is freshly painted — stale scrollback error lines must
    //    not pin the status after the agent recovers).
    if contains_any(&last_lower, error_markers) || ctx.screen_error_fresh {
        return AgentStatus::Error;
    }
    // 2. Fatal / startup blockers — persistent banners (e.g. "Not logged in ·
    //    Please run /login") that sit on screen above the prompt.
    if contains_any(&recent_lower, &DEFAULT_FATAL_MARKERS)
        || (!screen.is_empty() && contains_any(&screen_lower, &DEFAULT_FATAL_MARKERS))
    {
        return AgentStatus::Error;
    }
    // 3. A *fresh* working spinner in the terminal title. Stale spinners
    //    (agent finished but the idle-title update was missed) fall through
    //    to the quiet-screen rules below.
    if ctx.title_fresh && title_has_braille_spinner(ctx.title) {
        return AgentStatus::Working;
    }
    // 4. Waiting markers — permission questions, y/n prompts, select menus
    //    (tail or screen) → blocked. Only the tail's *last* non-empty lines
    //    count: a permission prompt always sits at the bottom of the output,
    //    and an answered prompt scrolls away once work resumes (a stale line
    //    in the wider scrollback must not pin the pane to blocked). Eight
    //    lines comfortably covers even long permission menus (option rows
    //    like "yes, and…" are themselves markers). The current screen is
    //    authoritative for TUI dialogs, which repaint it away the moment
    //    they are answered.
    //
    //    Note: a *fresh* title spinner (step 3) still outranks this — the
    //    agent is mid-animation, mirroring herdr's working > permission
    //    priority; the spinner title stops refreshing the moment the agent
    //    parks on a question.
    let blocked_recent = recent
        .iter()
        .filter(|line| !line.trim().is_empty())
        .take(8)
        .map(|line| *line)
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    if contains_any(&blocked_recent, blocked_markers)
        || (!screen.is_empty() && contains_any(&screen_lower, blocked_markers))
    {
        return AgentStatus::Blocked;
    }
    // 5. The agent's working markers on the current screen — plus, for Pi,
    //    its braille spinner: the spinner char (U+2800–U+28FF) keeps
    //    repainting for the whole thinking phase even while the adjacent
    //    text changes ("Working...", "Reading files...", ...), so it is the
    //    most reliable "working right now" screen signal. TUI agents
    //    repaint these only while working, so their presence means Working.
    //
    //    Unlike the error markers (step 1), these are deliberately *not*
    //    recency-gated: TUI agents erase the spinner/hint rows when they
    //    finish (the idle frame repaints them), so a lingering "Working..."
    //    or braille char can't pin the status — while a long quiet tool run
    //    (e.g. a build that repaints nothing for seconds) must keep Working.
    let screen_working = (!working_markers.is_empty()
        && contains_any(&screen_lower, working_markers))
        || (braille_working && screen.chars().any(|c| matches!(c as u32, 0x2800..=0x28FF)));
    if screen_working {
        return AgentStatus::Working;
    }
    // 6. At the input prompt. Line-based agents (Claude): `❯` as the tail's
    //    last line. TUI agents (default Idle): a `❯` line anywhere on the
    //    current screen — their input box sits at a fixed row, and the screen
    //    is stateful (working markers on screen already returned Working in
    //    step 5), so the prompt on screen means waiting. A static screen or
    //    any non-empty title means idle; typing echo must not flip the
    //    status. Only with *no* title and output actively streaming do we
    //    guess "working" (an agent drawing without a title signal).
    let is_tui = default_status == AgentStatus::Idle;
    let last_trimmed = last_line.trim();
    let at_prompt_tail = last_trimmed.starts_with('❯')
        || prompt_markers
            .iter()
            .any(|m| last_trimmed.eq_ignore_ascii_case(m));
    let at_prompt_screen = is_tui
        && screen.lines().any(|l| {
            let t = l.trim();
            t.starts_with('❯') || prompt_markers.iter().any(|m| t.eq_ignore_ascii_case(m))
        });
    if at_prompt_tail || at_prompt_screen {
        if is_tui || ctx.quiet || ctx.screen_quiet || !ctx.title.is_empty() || ctx.armed_grace {
            return AgentStatus::Idle;
        }
        return AgentStatus::Working;
    }
    // 7. Idle title marker (static ✳ / "Action Required").
    if title_is_idle(ctx.title) {
        return AgentStatus::Idle;
    }
    // 8. A static screen — TUI agents stop redrawing when they're done; the
    //    reconstructed screen content (not cursor blinks) has been unchanged
    //    for the quiet window, so the agent is waiting.
    if ctx.screen_quiet {
        return AgentStatus::Idle;
    }
    // 9. Per-agent default. A freshly armed agent is booting to its prompt —
    //    no signal yet must read Idle, not the (Working) default, so opening
    //    an agent never flashes "working". Real work/error signals already
    //    returned above and win during the grace.
    if ctx.armed_grace {
        return AgentStatus::Idle;
    }
    default_status
}

/// Claude/Codex write a braille spinner (U+2800–U+28FF) into the terminal
/// title while the agent is working.
fn title_has_braille_spinner(title: &str) -> bool {
    title.chars().any(|c| matches!(c as u32, 0x2800..=0x28FF))
}

/// Static terminal-title markers that mean the agent is *not* working:
/// Claude's `✳` (U+2733) prefix and Codex's "Action Required" banner.
fn title_is_idle(title: &str) -> bool {
    let trimmed = title.trim_start();
    trimmed.starts_with('✳') || trimmed.contains("Action Required")
}

fn contains_any(text: &str, markers: &[String]) -> bool {
    markers.iter().any(|m| text.contains(m.as_str()))
}

/// Most recent `n` lines, most-recent first, empty lines kept.
fn recent_lines(tail: &str, n: usize) -> Vec<&str> {
    let mut lines: Vec<&str> = tail.lines().collect();
    let skip = lines.len().saturating_sub(n);
    lines.drain(..skip);
    lines.reverse();
    lines
}

/// Message for the idle state: the last visible text, but `None` when it's
/// just a bare prompt marker (❯ / ✻ / ▌) — an empty waiting line carries no
/// information. Prefers the current screen (TUI agents' visible state),
/// falling back to the tail.
fn idle_message(tail: &str, screen: &str) -> Option<String> {
    let source = if screen.trim().is_empty() {
        tail
    } else {
        screen
    };
    let msg = tail_message(source)?;
    let stripped = msg
        .trim()
        .trim_matches(|c| matches!(c, '❯' | '✻' | '▌' | '>' | '·'));
    if stripped.is_empty() {
        None
    } else {
        Some(msg)
    }
}

/// Message for the blocked state: the most recent line carrying a waiting
/// marker (the permission question itself, the y/n line, the dialog banner),
/// so the sidebar shows *what* the agent is asking for. Falls back to the
/// last visible lines. Scans the current screen first (TUI agents paint the
/// dialog there), then the tail — the wider tail scan is fine here because
/// this only runs when the status is already Blocked (the marker is current
/// on the screen or in the detection window).
fn blocked_message(tail: &str, screen: &str, markers: &[String]) -> Option<String> {
    for line in screen.lines().chain(recent_lines(tail, 14)) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if contains_any(&trimmed.to_lowercase(), markers) {
            return Some(truncate_message(trimmed));
        }
    }
    tail_message(if screen.trim().is_empty() {
        tail
    } else {
        screen
    })
}

/// Message for the error state: the most recent line carrying an error
/// marker (so a persistent banner like "Not logged in · Please run /login"
/// surfaces instead of the prompt that sits below it), falling back to the
/// last visible lines. Scans the current screen first (TUI agents paint
/// persistent error status text there), then the tail.
fn error_message(tail: &str, screen: &str, markers: &[String]) -> Option<String> {
    for line in screen.lines().chain(recent_lines(tail, 14)) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if contains_any(&trimmed.to_lowercase(), markers)
            || contains_any(&trimmed.to_lowercase(), &DEFAULT_FATAL_MARKERS)
        {
            return Some(truncate_message(trimmed));
        }
    }
    tail_message(if screen.trim().is_empty() {
        tail
    } else {
        screen
    })
}

fn truncate_message(text: &str) -> String {
    if text.chars().count() > MESSAGE_MAX_CHARS {
        text.chars().take(MESSAGE_MAX_CHARS).collect::<String>() + "…"
    } else {
        text.to_string()
    }
}

/// Capture the last visible output lines (most recent first, up to 2
/// non-empty) as a short message for error/blocked badges.
fn tail_message(tail: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for line in recent_lines(tail, 8) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        parts.push(trimmed.to_string());
        if parts.len() == 2 {
            break;
        }
    }
    if parts.is_empty() {
        return None;
    }
    let text = truncate_message(&parts.join(" · "));
    Some(text)
}

/// Strip ANSI/OSC escape sequences from PTY output so status patterns match
/// against plain text. Best-effort: sequences split across chunk boundaries
/// are dropped (the tail is fed fresh data constantly).
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                Some('[') => {
                    // CSI: consume until final byte in @–~
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: consume until BEL or ST
                    for n in chars.by_ref() {
                        match n {
                            '\x07' => break,
                            '\x1b' => {
                                let _ = chars.next();
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                Some('(') | Some(')') | Some('*') | Some('+') => {
                    // Charset designation: consume the selector
                    let _ = chars.next();
                }
                // 7 save cursor, 8 restore, =/> keypad, M/D/E/CU, c reset, \\ ST
                Some('7' | '8' | '=' | '>' | 'M' | 'D' | 'E' | 'c' | '\\') => {}
                Some(other) => {
                    out.push('\x1b');
                    out.push(other);
                }
                None => {}
            },
            '\x07' | '\x08' => {}
            _ => out.push(c),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Per-pane detector
// ---------------------------------------------------------------------------

/// Tracks one pane's agent state. Fed by the PTY reader thread (output bytes
/// + terminal title) and polled by the session-level watch loop.
#[derive(Debug)]
pub struct AgentDetector {
    tail: String,
    /// Reconstructed current visible screen (TUI agents: OpenCode, Pi, ...).
    screen: screen::Screen,
    /// Cached render of the screen, rebuilt only when content changes.
    screen_text: String,
    last_exit: Option<(i32, u64)>,
    /// Latest terminal title (OSC 0/2) — Claude/Codex set a braille spinner
    /// while working and a static marker when idle.
    title: String,
    /// When the title was last updated (staleness for the spinner signal).
    last_title_ms: u64,
    /// When output bytes were last fed (the quiet/idle discriminator).
    last_output_ms: u64,
    /// Unix ms until which the agent is in its arming grace (just launched —
    /// booting to its prompt). See `armed()`.
    armed_until_ms: u64,
    /// Agent kind pre-armed synchronously by the PTY reader. Keeping this
    /// separate from the host-side arm map closes the race where output arrives
    /// before the async status watcher handles CmdStart.
    armed_kind: Option<AgentKind>,
    prearmed: bool,
    /// The snapshot last persisted to the host (what the collection/membership
    /// currently reflects).
    pub current: Option<AgentSnapshot>,
}

impl Default for AgentDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentDetector {
    pub fn new() -> Self {
        Self {
            tail: String::new(),
            screen: screen::Screen::new(now_ms()),
            screen_text: String::new(),
            last_exit: None,
            title: String::new(),
            last_title_ms: 0,
            last_output_ms: 0,
            armed_until_ms: 0,
            armed_kind: None,
            prearmed: false,
            current: None,
        }
    }

    /// Arm detection for a fresh agent session: wipe the previous command's
    /// output/screen/title so stale signals can't leak into the new agent's
    /// status, and start the arming grace — until it shows real work the new
    /// agent reads as Idle (it is booting to its prompt, so opening an agent
    /// must never flash "working"). Called when an agent command starts.
    #[allow(dead_code)]
    pub fn arm(&mut self, now: u64) {
        self.reset_for_arm(now);
        self.armed_kind = None;
        self.prearmed = false;
    }

    /// Reset immediately when the reader sees CmdStart, before any later PTY
    /// output can race the async status watcher. The manager subsequently calls
    /// `confirm_arm`, which intentionally preserves this captured output.
    pub fn pre_arm(&mut self, kind: AgentKind, now: u64) {
        if self.armed_kind != Some(kind) {
            self.reset_for_arm(now);
            self.armed_kind = Some(kind);
        }
        self.prearmed = true;
    }

    /// Confirm an arm recorded in the manager's lifecycle map. A synchronous
    /// reader-side pre-arm for the same command is already clean and must not
    /// wipe Pi's startup frame a second time.
    pub fn confirm_arm(&mut self, kind: AgentKind, now: u64) {
        if !(self.prearmed && self.armed_kind == Some(kind)) {
            self.reset_for_arm(now);
            self.armed_kind = Some(kind);
        }
        self.prearmed = false;
    }

    /// Clear the command-generation marker after the agent command ends, so a
    /// later invocation of the same agent starts from a clean detector.
    pub fn clear_arm(&mut self) {
        self.armed_kind = None;
        self.prearmed = false;
    }

    fn reset_for_arm(&mut self, now: u64) {
        self.tail.clear();
        self.screen = screen::Screen::new(now);
        self.screen_text.clear();
        self.last_exit = None;
        self.title.clear();
        self.last_title_ms = 0;
        self.last_output_ms = 0;
        self.current = None;
        self.armed_until_ms = now + ARMED_GRACE_MS;
    }

    /// Record the terminal title reported by the agent (OSC 0/2). An empty
    /// title clears the previous one (the app relinquished the title).
    pub fn on_title(&mut self, title: String) {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            self.title.clear();
        } else {
            self.title = trimmed.to_string();
        }
        self.last_title_ms = now_ms();
    }

    /// Append raw PTY output: reconstruct the visible screen from the raw
    /// bytes (cursor positioning), then append the sanitized text tail.
    pub fn feed_output(&mut self, data: &[u8]) {
        let now = now_ms();
        if self.screen.feed(data, now) {
            self.screen_text = self.screen.text();
        }
        let text = String::from_utf8_lossy(data);
        let clean = strip_ansi(&text);
        self.append_tail(&clean);
        self.last_output_ms = now;
    }

    /// Replay saved scrollback into the text tail (e.g. after reconnect) so
    /// line-oriented status detection has history. It intentionally does not
    /// feed the screen model: saved TUI escape sequences belong to an old
    /// process and must not contaminate a newly launched Pi screen.
    pub fn seed_tail(&mut self, data: &[u8]) {
        let text = String::from_utf8_lossy(data);
        self.append_tail(&strip_ansi(&text));
    }

    fn append_tail(&mut self, clean: &str) {
        self.tail.push_str(clean);
        if self.tail.len() > MAX_TAIL_BYTES {
            let excess = self.tail.len() - MAX_TAIL_BYTES;
            let cut = self
                .tail
                .char_indices()
                .find(|(i, _)| *i >= excess)
                .map(|(i, _)| i)
                .unwrap_or(excess);
            self.tail.drain(..cut);
        }
    }

    /// Record a command exit reported by the shell integration. Used to detect
    /// agent failures after the process is gone (non-zero exit). Note: the
    /// *start* of a command is deliberately ignored — launching the agent
    /// (`claude`, `codex`, ...) is itself a foreground command that only ends
    /// when the agent exits, so it carries no working/idle information.
    pub fn on_cmd_end(&mut self, code: i32) {
        self.last_exit = Some((code, now_ms()));
    }

    /// Compute the next state given the current process-tree match.
    ///
    /// Returns:
    ///   * `Some(snapshot)` — persist `extra.agent` with this state;
    ///   * `None` — clear `extra.agent` (no agent, pane leaves the collection).
    pub fn detect(
        &self,
        found: Option<(&dyn AgentMechanism, String)>,
        now: u64,
    ) -> Option<AgentSnapshot> {
        match found {
            Some((mech, process)) => {
                let since_ms = self
                    .current
                    .as_ref()
                    .filter(|c| {
                        c.kind == mech.kind().id() && c.process.as_deref() == Some(&process)
                    })
                    .map(|c| c.since_ms)
                    .unwrap_or(now);
                let ctx = StatusContext {
                    tail: &self.tail,
                    screen: &self.screen_text,
                    title: &self.title,
                    quiet: now.saturating_sub(self.last_output_ms) >= QUIET_MS,
                    screen_quiet: now.saturating_sub(self.screen.last_change_ms) >= QUIET_MS,
                    title_fresh: now.saturating_sub(self.last_title_ms) < TITLE_STALE_MS,
                    // A screen error counts only while its row is freshly
                    // painted — Pi/OpenCode keep old error lines in their
                    // on-screen scrollback after recovery.
                    screen_error_fresh: self
                        .screen
                        .has_recent_marker(mech.error_markers(), SCREEN_ERROR_BATCH_MS),
                    armed_grace: now < self.armed_until_ms,
                };
                let status = mech.detect_status(&ctx);
                let message = mech.extract_message(&ctx, status);
                Some(AgentSnapshot {
                    kind: mech.kind().id().to_string(),
                    display: mech.display().to_string(),
                    status: status.as_str().to_string(),
                    message,
                    process: Some(process),
                    since_ms,
                    updated_ms: now,
                })
            }
            None => {
                let cur = self.current.as_ref()?;
                // Agent gone. Hold an error state briefly so failures stay
                // visible, then clear `extra.agent` (drops collection
                // membership).
                let recent_failure = self.last_exit.is_some_and(|(code, ts)| {
                    code != 0 && code != 130 && now.saturating_sub(ts) < FAILURE_WINDOW_MS
                });
                let in_error_grace =
                    cur.status == "error" && now.saturating_sub(cur.updated_ms) < ERROR_GRACE_MS;
                if recent_failure || in_error_grace {
                    let mut snap = cur.clone();
                    snap.status = "error".to_string();
                    if snap.message.is_none() {
                        snap.message = tail_message(&self.tail);
                    }
                    Some(snap)
                } else {
                    None
                }
            }
        }
    }

    /// Whether `next` differs from what was last persisted.
    pub fn changed(&self, next: &Option<AgentSnapshot>) -> bool {
        match (next, &self.current) {
            (None, None) => false,
            (Some(a), Some(b)) => !a.equals_ignoring_updated(b),
            _ => true,
        }
    }

    /// Record the snapshot that was persisted (or `None` when cleared).
    pub fn mark_persisted(&mut self, snap: Option<AgentSnapshot>) {
        self.current = snap;
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(kind: AgentKind) -> AgentProfile {
        builtin_profiles()
            .into_iter()
            .find(|p| p.kind == kind)
            .expect("builtin profile")
    }

    /// Tail-only context (no screen) — screen_quiet=false keeps the legacy
    /// tail-driven behavior in tests that don't exercise the screen model.
    fn ctx(tail: &str) -> StatusContext<'_> {
        StatusContext {
            tail,
            screen: "",
            title: "",
            quiet: true,
            screen_quiet: false,
            title_fresh: true,
            screen_error_fresh: false,
            armed_grace: false,
        }
    }

    fn ctx_full<'a>(
        tail: &'a str,
        title: &'a str,
        quiet: bool,
        title_fresh: bool,
    ) -> StatusContext<'a> {
        StatusContext {
            tail,
            screen: "",
            title,
            quiet,
            screen_quiet: false,
            title_fresh,
            screen_error_fresh: false,
            armed_grace: false,
        }
    }

    fn ctx_screen<'a>(
        tail: &'a str,
        screen: &'a str,
        quiet: bool,
        screen_quiet: bool,
    ) -> StatusContext<'a> {
        StatusContext {
            tail,
            screen,
            title: "",
            quiet,
            screen_quiet,
            title_fresh: true,
            screen_error_fresh: false,
            armed_grace: false,
        }
    }

    #[test]
    fn strip_ansi_removes_csi_osc_and_control() {
        assert_eq!(
            strip_ansi("\x1b[31mred\x1b[0m \x1b]7;file:///tmp\x07done"),
            "red done"
        );
        assert_eq!(strip_ansi("plain \x07 bell"), "plain  bell");
        assert_eq!(strip_ansi("a\x1b[1;32mb\x1b[Kc"), "abc");
    }

    #[test]
    fn claude_waiting_prompt_is_idle() {
        let mech = profile(AgentKind::Claude);
        let tail = "Thinking...\n\n❯ \x1b[0m";
        assert_eq!(
            mech.detect_status(&ctx(&strip_ansi(tail))),
            AgentStatus::Idle
        );
    }

    #[test]
    fn permission_prompt_is_blocked() {
        let mech = profile(AgentKind::Codex);
        let tail = "Do you want to proceed?\n❯ Allow\n  Deny";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Blocked);
    }

    #[test]
    fn y_n_prompt_is_blocked() {
        let mech = profile(AgentKind::Claude);
        let tail = "Allow the agent to run this tool? (y/n)";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Blocked);
    }

    #[test]
    fn blocked_beats_idle_title() {
        // A permission question on screen wins over the idle ✳ title marker.
        let mech = profile(AgentKind::Codex);
        let tail = "Do you want to continue?\n❯ 1. Yes\n   2. No";
        assert_eq!(
            mech.detect_status(&ctx_full(tail, "✳ Codex", true, true)),
            AgentStatus::Blocked
        );
    }

    #[test]
    fn answered_permission_scrolls_away_stays_working() {
        // Once the user answers, the prompt scrolls out of the recent window
        // as work resumes — a stale "proceed?" line must not pin the pane to
        // blocked while the agent is clearly working again.
        let mech = profile(AgentKind::Claude);
        let tail = "Do you want to proceed?\n❯ Allow\n✓ file updated\n✓ tests pass\n✓ build ok\n✓ lint ok\n✓ commit created\n✓ pushed\n✓ ci green\nDone.";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Working);
    }

    #[test]
    fn error_before_prompt_is_error_not_idle() {
        // A fresh prompt reappears right after a failure — the error must win
        // or the prompt would mask every error.
        let mech = profile(AgentKind::Claude);
        let tail = "✖ Error: Command failed\nError: npm test exited 1\n❯ ";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Error);
    }

    #[test]
    fn trailing_error_line_is_error() {
        let mech = profile(AgentKind::Claude);
        let tail = "Running tests...\nerror: command failed with exit code 1";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Error);
    }

    #[test]
    fn mid_output_error_noise_stays_running() {
        let mech = profile(AgentKind::Claude);
        let tail = "error: failed to compile foo.rs\nexample.rs:1:1: some more output\nfixing the issue now";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Working);
    }

    #[test]
    fn active_work_is_running() {
        let mech = profile(AgentKind::Gemini);
        let tail = "Generating response...\n✓ file updated";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Working);
    }

    #[test]
    fn working_spinner_is_running_not_idle() {
        // ✻ is Claude's *working* spinner, not a waiting glyph.
        let mech = profile(AgentKind::Claude);
        let tail = "✻ Running tests…";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Working);
    }

    #[test]
    fn lingering_prompt_with_output_after_is_running() {
        // Once output appears after the prompt line, the prompt is no longer
        // the last line and the agent is working.
        let mech = profile(AgentKind::Claude);
        let tail = "❯ build the feature\n✓ file updated\nDone.";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Working);
    }

    #[test]
    fn typing_at_prompt_stays_idle() {
        // The user is typing at the prompt — the last line is still the
        // prompt, so the status must not move off idle.
        let mech = profile(AgentKind::Claude);
        assert_eq!(
            mech.detect_status(&ctx("❯ add a test for ")),
            AgentStatus::Idle
        );
        assert_eq!(mech.detect_status(&ctx("❯ ")), AgentStatus::Idle);
    }

    // ---------------------------------------------------------------------
    // TUI agents (Pi, OpenCode) — screen-model status
    // ---------------------------------------------------------------------

    #[test]
    fn pi_working_marker_on_screen_is_running() {
        // Pi repaints "Working..." while working (herdr's working_literal rule).
        let mech = profile(AgentKind::Pi);
        let screen = "pi v0.83.0\nWorking...\n~/code/zem (main)";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, false)),
            AgentStatus::Working
        );
    }

    #[test]
    fn pi_braille_spinner_on_screen_is_running() {
        // The user's case: Pi paints `⠧ Working...` while thinking — the
        // braille spinner char is the working signal.
        let mech = profile(AgentKind::Pi);
        let screen = "pi v0.83.0\n ⠧ Working...\n~/code/zem (main)";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, false)),
            AgentStatus::Working
        );
    }

    #[test]
    fn pi_braille_spinner_with_changing_text_is_running() {
        // The spinner keeps spinning even while the adjacent text changes
        // ("Working...", "Reading files...", ...) — any braille char on the
        // screen means the agent is actively working.
        let mech = profile(AgentKind::Pi);
        let screen = " ⠋ Reading files...\n~/code/zem (main)";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, false)),
            AgentStatus::Working
        );
    }

    #[test]
    fn non_braille_agent_ignores_screen_braille() {
        // Only agents that opt in (Pi) read a braille char as a working
        // signal — OpenCode must keep its marker-only behavior.
        let mech = profile(AgentKind::OpenCode);
        let screen = " ⠧ some content\ntab agents · ctrl+p commands";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, true)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn pi_progress_bar_on_screen_is_running() {
        let mech = profile(AgentKind::Pi);
        let screen = "┃ Build · Claude Opus 5\n■■■■⬝⬝⬝⬝";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, false)),
            AgentStatus::Working
        );
    }

    #[test]
    fn pi_static_startup_screen_is_idle() {
        // Pi's idle screen is a static help/status layout — no working marker,
        // unchanged for the quiet window → idle.
        let mech = profile(AgentKind::Pi);
        let screen = "pi v0.83.0\nescape interrupt · ctrl+c/ctrl+d clear/exit\n───\n~/code/zem (main)\n0.0%/128k (auto)";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, true)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn pi_typing_changes_screen_but_stays_idle() {
        // User typing at Pi's prompt repaints the input row (screen not quiet)
        // with no working marker → the TUI default (Idle) applies.
        let mech = profile(AgentKind::Pi);
        let screen = "~/code/zem (main)\n0.0%/128k (auto)\nls";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, false, false)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn opencode_interrupt_hint_is_running() {
        let mech = profile(AgentKind::OpenCode);
        let screen = "Build · Claude Opus 5\nesc to interrupt";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, false)),
            AgentStatus::Working
        );
    }

    #[test]
    fn opencode_at_prompt_screen_is_idle() {
        // OpenCode idle: the input box `❯` sits at its fixed row.
        let mech = profile(AgentKind::OpenCode);
        let screen = "ls\n❯ hi";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, true)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn opencode_idle_hint_bar_is_idle() {
        // Idle bottom bar has no interrupt hint; static screen → idle.
        let mech = profile(AgentKind::OpenCode);
        let screen = "tab agents · ctrl+p commands";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, true)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn opencode_progress_bar_is_running() {
        let mech = profile(AgentKind::OpenCode);
        let screen = "⬝⬝⬝⬝■■■■";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, false)),
            AgentStatus::Working
        );
    }

    #[test]
    fn opencode_permission_dialog_is_blocked() {
        // A permission dialog awaits approval — blocked beats the screen's
        // working markers (herdr: permission_required 300 > working 110).
        let mech = profile(AgentKind::OpenCode);
        let screen = "△ Permission required\nesc dismiss · enter confirm\n⬝⬝⬝⬝";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, false)),
            AgentStatus::Blocked
        );
    }

    #[test]
    fn claude_screen_prompt_does_not_override_streaming() {
        // Claude's input box `❯` persists on the screen while it works — a
        // non-TUI agent must NOT read Idle from a screen prompt when output
        // is actively streaming (reviewer-caught regression risk).
        let mech = profile(AgentKind::Claude);
        let screen = "Running tests...\n❯ fix the bug";
        assert_eq!(
            mech.detect_status(&ctx_screen("output streaming", screen, false, false)),
            AgentStatus::Working
        );
    }

    #[test]
    fn opencode_screen_prompt_is_idle_even_when_streaming() {
        // For a TUI agent the screen is authoritative: the `❯` input box at
        // its fixed row means waiting (working markers on screen would have
        // returned Running in the earlier step).
        let mech = profile(AgentKind::OpenCode);
        let screen = "Running tests...\n❯ fix the bug";
        assert_eq!(
            mech.detect_status(&ctx_screen("output streaming", screen, false, false)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn tui_idle_message_is_none() {
        // The sidebar must show just the agent name + status for a TUI agent
        // at its static layout — an idle layout carries no message.
        let mech = profile(AgentKind::OpenCode);
        assert_eq!(
            mech.extract_message(
                &ctx_screen("", "tab agents · ctrl+p commands", true, true),
                AgentStatus::Idle
            ),
            None
        );
    }

    #[test]
    fn blocked_message_surfaces_the_question() {
        // The blocked message carries the permission line itself, not the
        // prompt below it.
        let mech = profile(AgentKind::OpenCode);
        let msg = mech
            .extract_message(
                &ctx_screen(
                    "",
                    "△ Permission required\nesc dismiss · enter confirm",
                    true,
                    true,
                ),
                AgentStatus::Blocked,
            )
            .expect("permission message");
        assert!(msg.contains("Permission required"), "got: {msg}");

        // Line-based agent: the question in the tail surfaces too.
        let mech = profile(AgentKind::Claude);
        let msg = mech
            .extract_message(
                &ctx("Do you want to proceed?\n❯ Allow\n  Deny"),
                AgentStatus::Blocked,
            )
            .expect("question message");
        assert!(msg.contains("proceed"), "got: {msg}");
    }

    #[test]
    fn tui_agent_screen_error_marker_is_error() {
        // A *freshly painted* error row on the screen is an error (the retry
        // counter repaints the row every second, keeping it current).
        let mech = profile(AgentKind::Pi);
        let screen = "Internal Server Error [retrying in 1s attempt #4]";
        let mut ctx = ctx_screen("", screen, true, false);
        ctx.screen_error_fresh = true;
        assert_eq!(mech.detect_status(&ctx), AgentStatus::Error);
    }

    #[test]
    fn stale_screen_error_clears_after_recovery() {
        // The user's case: Pi shows "Error: 404 status code (no body)" and
        // the user then sends "hi" — the model recovers and renders a
        // response below the error line. The error row is no longer freshly
        // painted (new content superseded it), so the status must leave error
        // and reflect the agent's actual state.
        let mech = profile(AgentKind::Pi);
        let screen = "Error: 404 status code (no body)\nModel: minimax/minimax-m2.5\n\nhi\n\nHi there! How can I help you today?\n\n~/code/zem (main)\n0.0%/128k (auto)";
        // Stale error row: the marker is on screen but the row was painted
        // long ago — newer content renders below it.
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, true, true)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn stale_screen_error_while_working_is_running() {
        // Even with a stale error line in the scrollback, active working
        // markers on the screen must win (the agent recovered and is now
        // working on the new request).
        let mech = profile(AgentKind::Pi);
        let screen = "Error: 404 status code (no body)\nWorking...\n■■■■⬝⬝⬝⬝";
        assert_eq!(
            mech.detect_status(&ctx_screen("", screen, false, false)),
            AgentStatus::Working
        );
    }

    #[test]
    fn fresh_screen_error_beats_working_markers() {
        // A *current* error (row freshly painted) must beat working markers
        // — Pi repaints the retry banner while failing, so the agent is NOT
        // succeeding.
        let mech = profile(AgentKind::Pi);
        let screen = "Internal Server Error [retrying in 1s attempt #4]\nWorking...";
        let mut ctx = ctx_screen("", screen, false, false);
        ctx.screen_error_fresh = true;
        assert_eq!(mech.detect_status(&ctx), AgentStatus::Error);
    }

    #[test]
    fn screen_detector_pi_lifecycle() {
        // End-to-end through the detector: feed raw Pi-style TUI bytes and
        // watch idle → running → idle as the screen content changes.
        let mut d = AgentDetector::new();
        d.feed_output("\x1b[2J\x1b[Hpi v0.83.0\n~/code/zem (main)\n0.0%/128k (auto)".as_bytes());
        d.last_output_ms = 0;
        d.screen.last_change_ms = 0;
        let mech = profile(AgentKind::Pi);

        let snap = d
            .detect(Some((&mech, "pi".to_string())), 1500)
            .expect("detected");
        assert_eq!(snap.status, "idle");

        // Working: Pi repaints "Working..." — screen content changes.
        d.feed_output(b"\x1b[3;1HWorking...");
        d.last_output_ms = 0;
        d.screen.last_change_ms = 0;
        let snap = d
            .detect(Some((&mech, "pi".to_string())), 2000)
            .expect("detected");
        assert_eq!(snap.status, "working");
    }

    #[test]
    fn screen_detector_pi_braille_spinner_running() {
        // End-to-end: Pi paints its braille spinner row (`⠧ Working...`)
        // while thinking — the detector must derive Running from it.
        let mut d = AgentDetector::new();
        d.feed_output("\x1b[2J\x1b[Hpi v0.83.0\n~/code/zem (main)\n0.0%/128k (auto)".as_bytes());
        d.last_output_ms = 0;
        d.screen.last_change_ms = 0;
        let mech = profile(AgentKind::Pi);

        let snap = d
            .detect(Some((&mech, "pi".to_string())), 1500)
            .expect("detected");
        assert_eq!(snap.status, "idle");

        // Pi repaints the spinner row: braille char + "Working...".
        d.feed_output(b"\x1b[3;1H \xe2\xa0\xa7 Working...");
        d.last_output_ms = 0;
        d.screen.last_change_ms = 0;
        let snap = d
            .detect(Some((&mech, "pi".to_string())), 2000)
            .expect("detected");
        assert_eq!(snap.status, "working");

        // The spinner stops and Pi repaints the idle frame — status returns
        // to idle (the spinner row is overwritten, no linger).
        d.feed_output("\x1b[3;1H\x1b[2K\r\n0.0%/128k (auto)".as_bytes());
        d.last_output_ms = 0;
        d.screen.last_change_ms = 0;
        let snap = d
            .detect(Some((&mech, "pi".to_string())), 2500)
            .expect("detected");
        assert_eq!(snap.status, "idle");
    }

    #[test]
    fn registry_identify_command_matches_agent_commands() {
        let registry = AgentRegistry::builtin();
        assert_eq!(
            registry.identify_command("claude").map(|(k, _)| k),
            Some(AgentKind::Claude)
        );
        assert_eq!(
            registry
                .identify_command("claude --resume ce574888")
                .map(|(k, _)| k),
            Some(AgentKind::Claude)
        );
        assert_eq!(
            registry
                .identify_command("npx @anthropic-ai/claude-code")
                .map(|(k, _)| k),
            Some(AgentKind::Claude)
        );
        assert_eq!(
            registry.identify_command("opencode").map(|(k, _)| k),
            Some(AgentKind::OpenCode)
        );
        assert_eq!(
            registry.identify_command("pi").map(|(k, _)| k),
            Some(AgentKind::Pi)
        );
        // Non-agent commands must not arm detection.
        assert_eq!(registry.identify_command("ls -la"), None);
        assert_eq!(registry.identify_command("vim README.md"), None);
        assert_eq!(
            registry.identify_command("bash -c \"claude --version\""),
            None
        );
    }

    #[test]
    fn armed_detector_starts_idle_then_defaults_after_grace() {
        // A freshly armed agent is booting to its prompt: empty output must
        // read Idle (never the Running default) while in the arming grace.
        let mut d = AgentDetector::new();
        d.arm(1000);
        let mech = profile(AgentKind::Claude);
        let snap = d
            .detect(Some((&mech, "claude".to_string())), 1500)
            .expect("detected");
        assert_eq!(snap.status, "idle", "armed grace must not flash running");

        // The banner prints (output flows) but there is still no conclusive
        // signal — the grace keeps it Idle.
        d.feed_output("Claude Code\nType /help for help".as_bytes());
        let snap = d
            .detect(Some((&mech, "claude".to_string())), 2500)
            .expect("detected");
        assert_eq!(snap.status, "idle");

        // After the grace, streaming output without a signal falls back to
        // the per-agent default (Running for Claude).
        let snap = d
            .detect(
                Some((&mech, "claude".to_string())),
                1000 + ARMED_GRACE_MS + 1,
            )
            .expect("detected");
        assert_eq!(snap.status, "working");
    }

    #[test]
    fn armed_grace_does_not_block_real_working_signal() {
        // Claude sets its working title spinner immediately — that genuine
        // signal wins even during the arming grace.
        let mut d = AgentDetector::new();
        d.arm(1000);
        d.on_title("⠋ ⚡ claude code".to_string());
        let mech = profile(AgentKind::Claude);
        let snap = d
            .detect(Some((&mech, "claude".to_string())), 1500)
            .expect("detected");
        assert_eq!(snap.status, "working");
    }

    #[test]
    fn armed_grace_does_not_hide_error() {
        // A fatal startup banner (not logged in) is an error even during the
        // arming grace — the user must see why the agent can't run.
        let mut d = AgentDetector::new();
        d.arm(1000);
        d.feed_output("Not logged in · Please run /login".as_bytes());
        let mech = profile(AgentKind::Claude);
        let snap = d
            .detect(Some((&mech, "claude".to_string())), 1500)
            .expect("detected");
        assert_eq!(snap.status, "error");
    }

    #[test]
    fn detector_screen_error_clears_after_recovery_bytes() {
        // End-to-end through the detector with controlled timestamps: Pi
        // paints an error row, then the user sends "hi" and the model
        // recovers with a response below it — the error must clear.
        let mut d = AgentDetector::new();
        let mech = profile(AgentKind::Pi);

        // t=1000: Pi paints the error frame. (Direct screen feeds bypass
        // `feed_output`, so sync the cached render like it does.)
        d.screen
            .feed(b"Error: 404 status code (no body)\r\nModel: minimax", 1000);
        d.screen_text = d.screen.text();
        d.last_output_ms = 1000;
        let snap = d
            .detect(Some((&mech, "pi".to_string())), 2000)
            .expect("detected");
        assert_eq!(snap.status, "error", "fresh error row should be error");
        let msg = snap.message.expect("error message");
        assert!(msg.contains("404"), "got: {msg}");

        // t=20000: the agent recovers and paints a response below the error.
        d.screen.feed(
            b"\r\n\r\nhi\r\n\r\nHi there! How can I help you?\r\n\r\n~/code/zem (main)",
            20_000,
        );
        d.screen_text = d.screen.text();
        d.last_output_ms = 20_000;
        let snap = d
            .detect(Some((&mech, "pi".to_string())), 21_000)
            .expect("detected");
        // Stale error + static screen → idle (the user's report: it must not
        // stay error after the model works).
        assert_eq!(snap.status, "idle", "stale error row must clear");
    }

    #[test]
    fn detector_fresh_retry_error_stays_error() {
        // The retry banner keeps being repainted — the error must persist
        // across watch ticks while the agent keeps failing.
        let mut d = AgentDetector::new();
        let mech = profile(AgentKind::Pi);
        d.screen
            .feed(b"Internal Server Error [retrying in 1s attempt #4]", 1000);
        d.screen_text = d.screen.text();
        d.last_output_ms = 1000;
        let snap = d
            .detect(Some((&mech, "pi".to_string())), 1500)
            .expect("detected");
        assert_eq!(snap.status, "error");
        // Repainted attempt counter keeps the row current.
        d.screen
            .feed(b"Internal Server Error [retrying in 1s attempt #5]", 2500);
        d.screen_text = d.screen.text();
        d.last_output_ms = 2500;
        let snap = d
            .detect(Some((&mech, "pi".to_string())), 3000)
            .expect("detected");
        assert_eq!(snap.status, "error", "active retry must stay error");
    }

    #[test]
    fn benign_auth_words_in_output_stay_running() {
        // "authentication" / "unauthorized" are common in test suites and
        // HTTP client output during legit agent work — they must NOT trip the
        // fatal-marker path (only full banner phrases do).
        let mech = profile(AgentKind::Claude);
        let tail = "Running auth tests...\n\u{2713} unauthorized response handled\n\u{2713} authentication flow passed";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Working);
    }

    #[test]
    fn not_logged_in_banner_is_error() {
        // The user's real case: a fresh Claude that isn't logged in shows a
        // persistent "Not logged in · Please run /login" banner above the
        // prompt — that must surface as error, not running/idle.
        let mech = profile(AgentKind::Claude);
        let tail = "  Not logged in · Please run /login\n❯ hi";
        assert_eq!(mech.detect_status(&ctx(tail)), AgentStatus::Error);
    }

    #[test]
    fn fatal_marker_beats_idle_title() {
        // Even with an idle "✳" title, a fatal banner must win.
        let mech = profile(AgentKind::Claude);
        let tail = "  Please run /login to continue\n❯ ";
        assert_eq!(
            mech.detect_status(&ctx_full(tail, "✳ Claude Code", true, true)),
            AgentStatus::Error
        );
    }

    #[test]
    fn error_message_surfaces_banner_line() {
        // The error message should carry the banner line, not the prompt that
        // sits below it.
        let mech = profile(AgentKind::Claude);
        let tail = "  Not logged in · Please run /login\n❯ hi";
        let msg = mech
            .extract_message(&ctx(tail), AgentStatus::Error)
            .expect("error message");
        assert!(msg.contains("Not logged in"), "got: {msg}");
        assert!(!msg.contains("❯"), "got: {msg}");
    }

    #[test]
    fn title_braille_spinner_is_running_despite_prompt() {
        // The agent's working spinner lives in the terminal title even though
        // the input prompt stays on screen — the title must win over the
        // prompt line (this was the "status stuck at idle while working" bug).
        let mech = profile(AgentKind::Claude);
        let tail = "❯ fix the bug";
        assert_eq!(
            mech.detect_status(&ctx_full(tail, "⠋ ⚡ claude code", true, true)),
            AgentStatus::Working
        );
    }

    #[test]
    fn stale_spinner_title_with_quiet_prompt_is_idle() {
        // The agent finished but the idle-title update was missed — a stale
        // spinner on a quiet screen must not pin the status to Running.
        let mech = profile(AgentKind::Claude);
        assert_eq!(
            mech.detect_status(&ctx_full("❯ ", "⠋ ⚡ claude code", true, false)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn stale_spinner_typing_stays_idle() {
        // The user typed a reply after the agent finished but the idle-title
        // update was missed: a stale spinner + typing echo must not flip the
        // status off idle (the user's "typing must not change the status").
        let mech = profile(AgentKind::Claude);
        assert_eq!(
            mech.detect_status(&ctx_full(
                "❯ yes, add the test",
                "⠋ ⚡ claude code",
                false,
                false
            )),
            AgentStatus::Idle
        );
    }

    #[test]
    fn title_idle_marker_is_idle() {
        let mech = profile(AgentKind::Claude);
        assert_eq!(
            mech.detect_status(&ctx_full("❯ ", "✳ Claude Code", true, true)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn typing_with_idle_title_stays_idle() {
        // The user types at the prompt: recent echo output (quiet=false) must
        // not flip the status off idle while the title still says idle.
        let mech = profile(AgentKind::Claude);
        let tail = "❯ add a test for the parser";
        assert_eq!(
            mech.detect_status(&ctx_full(tail, "✳ Claude Code", false, true)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn no_title_quiet_prompt_is_idle() {
        let mech = profile(AgentKind::Claude);
        assert_eq!(
            mech.detect_status(&ctx_full("❯ ", "", true, true)),
            AgentStatus::Idle
        );
    }

    #[test]
    fn no_title_recent_output_at_prompt_is_running() {
        // No title signal but output is actively arriving at the prompt — the
        // agent is drawing (working), not waiting.
        let mech = profile(AgentKind::Claude);
        assert_eq!(
            mech.detect_status(&ctx_full("❯ …", "", false, true)),
            AgentStatus::Working
        );
    }

    #[test]
    fn title_working_beats_permission_prompt() {
        // Mirrors herdr: the working spinner outranks a permission prompt that
        // just appeared on screen (the spinner is still animating).
        let mech = profile(AgentKind::Codex);
        let tail = "Do you want to proceed?\n❯ 1. Yes\n   2. No";
        assert_eq!(
            mech.detect_status(&ctx_full(tail, "⠙ ⚡ codex", true, true)),
            AgentStatus::Working
        );
    }

    #[test]
    fn detector_tracks_terminal_title() {
        let mut d = AgentDetector::new();
        d.feed_output("❯ run tests\n".as_bytes());
        d.last_output_ms = 0;
        let mech = profile(AgentKind::Claude);

        d.on_title("⠋ ⚡ claude code".to_string());
        d.last_title_ms = 0; // control freshness against the fabricated `now`
        let snap = d
            .detect(Some((&mech, "claude".to_string())), 1000)
            .expect("detected");
        assert_eq!(snap.status, "working");

        d.on_title("✳ Claude Code".to_string());
        d.last_title_ms = 0;
        let snap = d
            .detect(Some((&mech, "claude".to_string())), 2000)
            .expect("detected");
        assert_eq!(snap.status, "idle");
    }

    #[test]
    fn detector_detects_then_clears() {
        let mut d = AgentDetector::new();
        d.feed_output(b"\x1b[32m\xE2\x9D\xAF \x1b[0m");
        d.last_output_ms = 0;
        let mech = profile(AgentKind::Claude);

        // First detection: idle snapshot at the prompt (quiet screen).
        let snap = d
            .detect(Some((&mech, "claude".to_string())), 1500)
            .expect("detected");
        assert_eq!(snap.kind, "claude");
        assert_eq!(snap.status, "idle");
        assert!(d.changed(&Some(snap.clone())));
        d.mark_persisted(Some(snap.clone()));
        assert!(!d.changed(&Some(snap)));

        // Agent gone: no recent failure -> clear.
        let next = d.detect(None, 2000);
        assert!(next.is_none());
        assert!(d.changed(&next));
    }

    #[test]
    fn detector_keeps_error_for_grace_period() {
        let mut d = AgentDetector::new();
        d.feed_output(b"error: command failed");
        let mech = profile(AgentKind::Codex);
        let snap = d
            .detect(Some((&mech, "codex".to_string())), 1000)
            .expect("detected");
        assert_eq!(snap.status, "error");
        d.mark_persisted(Some(snap));

        // Failure exit shortly after -> still error.
        d.on_cmd_end(1);
        let next = d.detect(None, 2000);
        let next = next.expect("kept during failure window");
        assert_eq!(next.status, "error");

        // Simulate long idle after the failure window: last_exit is old and
        // the error grace expired -> clear.
        d.last_exit = Some((1, 1000));
        let next = d.detect(None, 1000 + FAILURE_WINDOW_MS + ERROR_GRACE_MS + 1);
        assert!(next.is_none());
    }

    #[test]
    fn configure_applies_custom_markers_and_disables_agents() {
        let mut registry = AgentRegistry::builtin();
        let settings = serde_json::json!({
            "agents.claude.enabled": "false",
            "agents.codex.blocked": "custom wait marker, another one",
            "agents.codex.error": "custom failure",
        });
        registry.configure(&settings);

        // Disabled agent is not registered → identification skips it.
        assert!(registry.mechanism(AgentKind::Claude).is_none());
        // Unconfigured agent keeps its defaults.
        assert!(registry.mechanism(AgentKind::Gemini).is_some());

        // Custom markers replace the builtin defaults — a custom waiting
        // marker maps to blocked (the agent is waiting on the user).
        let codex = registry
            .mechanism(AgentKind::Codex)
            .expect("codex registered");
        assert_eq!(
            codex.detect_status(&ctx("custom wait marker")),
            AgentStatus::Blocked
        );
        assert_eq!(
            codex.detect_status(&ctx("custom failure")),
            AgentStatus::Error
        );
        // The builtin "error:" marker no longer matches — replaced by the
        // custom set.
        assert_eq!(
            codex.detect_status(&ctx("error: something")),
            AgentStatus::Working
        );

        // Reconfiguring without settings restores everything.
        registry.configure(&serde_json::json!({}));
        assert!(registry.mechanism(AgentKind::Claude).is_some());
    }

    #[test]
    fn snapshot_status_is_in_memory_only() {
        // The pane's own status field is the single persisted status — the
        // agent snapshot must never serialize its `status` into extra.agent.
        let snap = AgentSnapshot {
            kind: "claude".to_string(),
            display: "Claude Code".to_string(),
            status: "idle".to_string(),
            message: Some("waiting".to_string()),
            process: Some("claude".to_string()),
            since_ms: 1,
            updated_ms: 2,
        };
        let json = serde_json::to_value(&snap).expect("serialize snapshot");
        assert!(
            json.get("status").is_none(),
            "status must not be persisted into extra.agent: {json}"
        );
        assert_eq!(json["kind"], "claude");
        assert_eq!(json["message"], "waiting");
    }

    #[test]
    fn master_switch_disables_all_detection() {
        let mut registry = AgentRegistry::builtin();
        registry.configure(&serde_json::json!({ "agents.enabled": "false" }));
        assert_eq!(
            registry.mechanisms_len(),
            0,
            "master off → no agents registered"
        );
        assert!(registry.mechanism(AgentKind::Claude).is_none());

        // Re-enabling restores everything, including per-agent toggles.
        registry.configure(&serde_json::json!({
            "agents.enabled": true,
            "agents.codex.enabled": "false",
        }));
        assert!(registry.mechanism(AgentKind::Claude).is_some());
        assert!(registry.mechanism(AgentKind::Codex).is_none());
    }

    #[test]
    fn agent_settings_parse_boolean_strings_and_markers() {
        let settings = serde_json::json!({
            "agents.grok.enabled": true,
            "agents.grok.blocked": "hold on, just a sec",
            "agents.grok.error": "boom; exploded",
        });
        let s = AgentSettings::from_settings(&settings, "grok");
        assert!(s.enabled);
        assert_eq!(s.blocked, vec!["hold on", "just a sec"]);
        assert_eq!(s.error, vec!["boom", "exploded"]);

        let unset = AgentSettings::from_settings(&settings, "claude");
        assert!(unset.enabled, "unconfigured agents default to enabled");
        assert!(unset.blocked.is_empty());
        assert!(unset.error.is_empty());
    }

    #[test]
    fn detector_keeps_agent_identity_across_ticks() {
        let mut d = AgentDetector::new();
        let mech = profile(AgentKind::Claude);
        let first = d
            .detect(Some((&mech, "claude".to_string())), 1000)
            .expect("detected");
        d.mark_persisted(Some(first.clone()));
        let second = d
            .detect(Some((&mech, "claude".to_string())), 5000)
            .expect("detected");
        assert_eq!(second.since_ms, first.since_ms);
        assert!(!d.changed(&Some(second)));
    }
}
