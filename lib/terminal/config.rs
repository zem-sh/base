use zem_addon_sdk::ConfigField;

use crate::terminal::agent::{display_name, AgentKind};

/// `max_scrollback_size` — max scrollback buffer in megabytes.
pub fn max_scrollback_size() -> ConfigField {
    ConfigField::new("max_scrollback_size")
        .label("Max Scrollback Size (MB)")
        .field_type("number")
        .default("10")
        .description("Maximum scrollback buffer size in megabytes. Default is 10MB.")
}

/// `autosave_interval_seconds` — seconds between scrollback autosaves.
pub fn autosave_interval() -> ConfigField {
    ConfigField::new("autosave_interval_seconds")
        .label("Scrollback Autosave Interval (s)")
        .field_type("number")
        .default("10")
        .description("How often to save terminal scrollback to disk. Default is 10 seconds.")
}

/// `temp_cwd` — when enabled, an idle pane whose directory is inside a git
/// working tree shows the repository name in its title instead of the plain
/// folder name. Default false = current behavior (folder name).
pub fn temp_cwd() -> ConfigField {
    ConfigField::new("temp_cwd")
        .label("Use git repo name for title")
        .field_type("boolean")
        .default("false")
        .description(
            "When enabled, a pane inside a git repository shows the repo name (e.g. `zem`) in its title instead of the folder name. Default is false.",
        )
}

/// `notify_duration_seconds` — commands running at least this long get a
/// completion notification (failure always, success when enabled below).
/// Shorter commands never notify — failed or successful.
pub fn notify_duration() -> ConfigField {
    ConfigField::new("notify_duration_seconds")
        .label("Completion Notification Threshold (s)")
        .field_type("number")
        .default("30")
        .description(
            "Commands running at least this many seconds get a completion notification. Quicker commands never notify. Default is 30.",
        )
}

/// `notify_success` — send a success notification for long-running commands
/// (those past the duration threshold above). Failures always notify.
pub fn notify_success() -> ConfigField {
    ConfigField::new("notify_success")
        .label("Notify on Successful Commands")
        .field_type("boolean")
        .default("false")
        .description(
            "Send a success notification when a command finishes successfully after the threshold above. Default is false.",
        )
}

/// `agents.enabled` — master switch for coding-agent detection. When off, no
/// agent is detected regardless of the per-agent toggles below, and existing
/// agent panes leave the Agents collection on the next watch tick.
pub fn agents_enabled() -> ConfigField {
    ConfigField::new("agents.enabled")
        .label("Detect coding agents")
        .field_type("boolean")
        .default("true")
        .description(
            "Master switch for coding agent detection. When off, agents are not detected and panes leave the Agents collection.",
        )
}

/// Per-agent detection settings — one enable toggle plus custom status
/// patterns for each supported agent. Keys are `agents.<id>.enabled`,
/// `agents.<id>.blocked` and `agents.<id>.error`, which the settings form
/// persists as flat field names and the agent detector parses back out.
///
/// Custom marker fields accept comma/semicolon separated phrases; leaving a
/// field empty keeps that agent's built-in defaults.
/// Per-agent detection settings — the master switch (`agents.enabled`) is
/// declared separately in [`agents_enabled`] (before these in the builder
/// chain) so it renders at the top of the agent section of the settings form.
pub fn agent_fields() -> Vec<ConfigField> {
    let mut fields = Vec::new();
    for kind in AgentKind::ALL {
        let id = kind.id();
        let display = display_name(kind);
        fields.push(
            ConfigField::new(&format!("agents.{}.enabled", id))
                .label(&format!("Detect {}", display))
                .field_type("boolean")
                .default("true")
                .description(&format!(
                    "Enable detection for {}. Disable to ignore it in the Agents collection.",
                    display
                )),
        );
        fields.push(
            ConfigField::new(&format!("agents.{}.blocked", id))
                .label(&format!("{} — waiting markers", display))
                .description(&format!(
                    "Comma-separated output phrases that mean {} is waiting for your input. Empty uses built-in defaults.",
                    display
                )),
        );
        fields.push(
            ConfigField::new(&format!("agents.{}.error", id))
                .label(&format!("{} — error markers", display))
                .description(&format!(
                    "Comma-separated output phrases that mean {} failed. Empty uses built-in defaults.",
                    display
                )),
        );
    }
    fields
}
