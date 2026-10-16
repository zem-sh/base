//! Process-tree agent identification.
//!
//! Captures a `ps` snapshot once per detection tick (shared by all panes) and
//! walks each session's descendant process tree looking for a known agent
//! executable. Wrapped installs are handled the same way the herdr terminal
//! does: a generic runtime (`node`, `python`, `sh`, ...) whose command line
//! contains a known agent path is treated as that agent.

use std::collections::{HashMap, HashSet};

use super::AgentKind;

/// One process row from the `ps` snapshot.
#[derive(Debug, Clone)]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    /// Full command line (argv joined by spaces).
    pub args: String,
}

/// A point-in-time view of the process table.
#[derive(Debug, Default)]
pub struct PsSnapshot {
    processes: Vec<Process>,
}

impl PsSnapshot {
    /// Capture the process table via `ps`. Returns `None` when `ps` is
    /// unavailable or fails (detection simply skips that tick).
    pub fn capture() -> Option<Self> {
        let out = std::process::Command::new("ps")
            .args(["-axo", "pid=,ppid=,args="])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut snapshot = PsSnapshot::default();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let mut parts = line.splitn(3, char::is_whitespace);
            let (Some(pid), Some(ppid), args) = (
                parts.next().and_then(|p| p.parse::<u32>().ok()),
                parts.next().and_then(|p| p.parse::<u32>().ok()),
                parts.next().map(|a| a.to_string()),
            ) else {
                continue;
            };
            snapshot.processes.push(Process {
                pid,
                ppid,
                args: args.unwrap_or_default(),
            });
        }
        Some(snapshot)
    }

    #[cfg(test)]
    fn from_processes(processes: Vec<Process>) -> Self {
        Self { processes }
    }

    /// Find the best agent match in the process tree rooted at `root`
    /// (including the root itself — a pane may be launched directly with the
    /// agent executable).
    ///
    /// Returns `(kind, matched_process_name)`. Prefers exact executable-name
    /// matches over wrapped matches, then shallower processes.
    pub fn find_agent(
        &self,
        root: u32,
        aliases: &HashMap<String, AgentKind>,
        fragments: &[(&'static str, AgentKind)],
    ) -> Option<(AgentKind, String)> {
        let mut children: HashMap<u32, Vec<&Process>> = HashMap::new();
        for process in &self.processes {
            children.entry(process.ppid).or_default().push(process);
        }

        let mut best: Option<(AgentKind, String, u8, u32)> = None;
        // Process snapshots can contain orphaned descendants whose parent
        // exited and whose PID was reused. Keep the walk bounded and avoid
        // repeatedly scanning the full process vector for every node.
        let by_pid: HashMap<u32, &Process> = self.processes.iter().map(|p| (p.pid, p)).collect();
        let mut stack: Vec<(u32, u32)> = vec![(root, 0)];
        let mut seen: HashSet<u32> = HashSet::new();

        while let Some((pid, depth)) = stack.pop() {
            if !seen.insert(pid) {
                continue;
            }
            if let Some(process) = by_pid.get(&pid) {
                if let Some((kind, name, score)) = identify_args(&process.args, aliases, fragments)
                {
                    let better = match &best {
                        Some((_, _, best_score, best_depth)) => {
                            score > *best_score || (score == *best_score && depth < *best_depth)
                        }
                        None => true,
                    };
                    if better {
                        best = Some((kind, name, score, depth));
                    }
                }
            }
            if let Some(kids) = children.get(&pid) {
                for kid in kids {
                    stack.push((kid.pid, depth + 1));
                }
            }
        }

        best.map(|(kind, name, _, _)| (kind, name))
    }
}

/// Score + identify an agent from a command line.
///
/// Scoring:
///   * 3 — first token's basename is a direct alias (e.g. `claude` itself);
///   * 2 — a path token contains a known install path fragment or its basename
///         is an alias (node/python-wrapped agents);
///   * 1 — a bare argument token matches an alias.
///
/// Flag payloads (`-c`, `--eval`, ...) are skipped so `bash -c "claude"` or
/// `python -c "import claude"` do not false-positive.
///
/// `pub(crate)` so the registry can reuse the same scoring to match a shell
/// integration's command text (see `AgentRegistry::identify_command`).
pub(crate) fn identify_args(
    args: &str,
    aliases: &HashMap<String, AgentKind>,
    fragments: &[(&'static str, AgentKind)],
) -> Option<(AgentKind, String, u8)> {
    let tokens: Vec<&str> = args.split_whitespace().collect();
    let mut iter = tokens.iter().peekable();

    let first = *iter.next()?;
    let first_base = basename(first);
    if let Some(kind) = lookup_alias(first_base, aliases) {
        return Some((kind, first_base.to_string(), 3));
    }

    let mut best: Option<(AgentKind, String, u8)> = None;
    let mut skip_next = false;
    for tok in iter {
        if skip_next {
            skip_next = false;
            continue;
        }
        if is_payload_flag(tok) {
            skip_next = true;
            continue;
        }

        let mut matched = false;
        for (fragment, kind) in fragments {
            if tok.contains(fragment) {
                best = better(best, (*kind, fragment.to_string(), 2));
                matched = true;
                break;
            }
        }
        if matched {
            continue;
        }

        if tok.contains('/') || tok.contains('\\') {
            let base = basename(tok);
            if let Some(kind) = lookup_alias(base, aliases) {
                best = better(best, (kind, base.to_string(), 2));
            }
        } else if let Some(kind) = lookup_alias(tok, aliases) {
            best = better(best, (kind, tok.to_string(), 1));
        }
    }

    best
}

fn better(
    current: Option<(AgentKind, String, u8)>,
    candidate: (AgentKind, String, u8),
) -> Option<(AgentKind, String, u8)> {
    match current {
        Some((_, _, score)) if score >= candidate.2 => current,
        _ => Some(candidate),
    }
}

/// Flags whose following token is a payload (script/code), not a path.
/// Only flags that *always* take a payload are listed — skipping the next
/// token of a flag without one (e.g. `-l`, `-i`) could hide a real agent.
fn is_payload_flag(token: &str) -> bool {
    matches!(
        token,
        "-c" | "-e"
            | "--eval"
            | "-p"
            | "--print"
            | "-m"
            | "-lc"
            | "--command"
            | "/c"
            | "/k"
            | "-enc"
            | "--"
    )
}

fn lookup_alias(name: &str, aliases: &HashMap<String, AgentKind>) -> Option<AgentKind> {
    aliases.get(&normalize_name(name)).copied()
}

/// Lowercase + strip a trailing platform extension from an executable name.
pub fn normalize_name(name: &str) -> String {
    let mut name = name.trim().to_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".ps1", ".js"] {
        if name.ends_with(suffix) {
            name.truncate(name.len() - suffix.len());
            break;
        }
    }
    name
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alias_map() -> HashMap<String, AgentKind> {
        let mut map = HashMap::new();
        for (name, kind) in [
            ("pi", AgentKind::Pi),
            ("claude", AgentKind::Claude),
            ("claude-code", AgentKind::Claude),
            ("codex", AgentKind::Codex),
            ("gemini", AgentKind::Gemini),
            ("cursor-agent", AgentKind::Cursor),
            ("opencode", AgentKind::OpenCode),
            ("opencode2", AgentKind::OpenCode),
            ("hermes", AgentKind::Hermes),
        ] {
            map.insert(name.to_string(), kind);
        }
        map
    }

    fn fragments() -> Vec<(&'static str, AgentKind)> {
        vec![
            ("@anthropic-ai/claude-code", AgentKind::Claude),
            ("@earendil-works/pi-coding-agent", AgentKind::Pi),
            ("@mariozechner/pi-coding-agent", AgentKind::Pi),
            ("pi-coding-agent", AgentKind::Pi),
            ("@earendil-works/pi-coding-agent", AgentKind::Pi),
            ("@mariozechner/pi-coding-agent", AgentKind::Pi),
            ("@opencode-ai", AgentKind::OpenCode),
        ]
    }

    #[test]
    fn direct_agent_first_token_wins() {
        let aliases = alias_map();
        assert_eq!(
            identify_args(
                "claude --dangerously-skip-permissions",
                &aliases,
                &fragments()
            ),
            Some((AgentKind::Claude, "claude".to_string(), 3))
        );
    }

    #[test]
    fn node_wrapped_claude_via_path_fragment() {
        let aliases = alias_map();
        let args = "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --print";
        assert_eq!(
            identify_args(args, &aliases, &fragments()),
            Some((
                AgentKind::Claude,
                "@anthropic-ai/claude-code".to_string(),
                2
            ))
        );
    }

    #[test]
    fn node_wrapped_codex_via_basename() {
        let aliases = alias_map();
        let args = "node /home/user/.local/bin/codex --model gpt-5";
        assert_eq!(
            identify_args(args, &aliases, &fragments()),
            Some((AgentKind::Codex, "codex".to_string(), 2))
        );
    }

    #[test]
    fn shell_payload_does_not_false_positive() {
        let aliases = alias_map();
        assert_eq!(
            identify_args("bash -c \"claude --version\"", &aliases, &fragments()),
            None
        );
        assert_eq!(
            identify_args("python3 -c \"import codex\"", &aliases, &fragments()),
            None
        );
        assert_eq!(
            identify_args("node -e \"console.log('claude')\"", &aliases, &fragments()),
            None
        );
    }

    #[test]
    fn extension_is_stripped() {
        let aliases = alias_map();
        assert_eq!(
            identify_args("opencode.exe --standalone", &aliases, &fragments()),
            Some((AgentKind::OpenCode, "opencode.exe".to_string(), 3))
        );
    }

    #[test]
    fn find_agent_walks_descendants() {
        let aliases = alias_map();
        let snapshot = PsSnapshot::from_processes(vec![
            Process {
                pid: 100,
                ppid: 0,
                args: "zsh".to_string(),
            },
            Process {
                pid: 101,
                ppid: 100,
                args: "claude".to_string(),
            },
            Process {
                pid: 102,
                ppid: 101,
                args: "git diff".to_string(),
            },
        ]);
        let found = snapshot.find_agent(100, &aliases, &fragments());
        assert_eq!(found, Some((AgentKind::Claude, "claude".to_string())));
    }

    #[test]
    fn find_agent_returns_none_for_plain_shell() {
        let aliases = alias_map();
        let snapshot = PsSnapshot::from_processes(vec![
            Process {
                pid: 100,
                ppid: 0,
                args: "zsh".to_string(),
            },
            Process {
                pid: 101,
                ppid: 100,
                args: "vim README.md".to_string(),
            },
        ]);
        assert_eq!(snapshot.find_agent(100, &aliases, &fragments()), None);
    }

    #[test]
    fn find_agent_prefers_direct_over_wrapped() {
        let aliases = alias_map();
        let snapshot = PsSnapshot::from_processes(vec![
            Process {
                pid: 100,
                ppid: 0,
                args: "zsh".to_string(),
            },
            Process {
                pid: 101,
                ppid: 100,
                args: "node /path/claude".to_string(),
            },
            Process {
                pid: 102,
                ppid: 100,
                args: "codex".to_string(),
            },
        ]);
        // Direct `codex` (score 3) beats wrapped claude (score 2).
        assert_eq!(
            snapshot.find_agent(100, &aliases, &fragments()),
            Some((AgentKind::Codex, "codex".to_string()))
        );
    }
}
