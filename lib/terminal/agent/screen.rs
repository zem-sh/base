//! Lightweight ANSI terminal screen model.
//!
//! Full-screen TUI agents (OpenCode, Pi, ...) don't emit a linear output
//! stream the way line-based CLIs do — they paint deltas at absolute cursor
//! positions and redraw constantly, so "the last N lines of output" can never
//! tell us what the agent is currently showing. This module reconstructs the
//! *current visible screen* from the same byte stream the reader sees:
//! cursor positioning (CUP), paint, erase, and clear sequences are applied to
//! a row→cell grid. The result is a stateful text snapshot where overwrites
//! remove stale content (a working frame's "esc to interrupt" hint disappears
//! when the idle frame repaints that row) and cursor blinks don't count as
//! content changes — which is exactly the signal needed to distinguish
//! "agent waiting at its prompt" from "agent actively drawing".
//!
//! This mirrors how the herdr terminal samples the rendered screen for its
//! per-agent status rules, but derived from the raw PTY bytes we already have.
//!
//! Only the operations TUI agents actually use are handled: cursor movement,
//! line/display erase, full clears, and printable text (UTF-8). SGR colors,
//! modes, scroll regions and the like are ignored (they don't change visible
//! text). Escape sequences may span read-chunk boundaries — a partial
//! sequence is buffered until the next feed.

use std::collections::BTreeMap;

/// Keep at most this many rows (the bottom of the screen + recent scrollback).
const MAX_ROWS: usize = 300;
/// A malformed OSC payload (no BEL/ST) must not swallow the stream forever —
/// if the in-flight payload exceeds this, force-drop the sequence.
const MAX_OSC_BYTES: usize = 8192;
/// Render at most this many rows when snapshotting the screen text.
const RENDER_ROWS: usize = 60;
/// Safety cap on a row's width.
const MAX_COLS: u32 = 1000;

#[derive(Debug)]
pub struct Screen {
    rows: BTreeMap<u32, BTreeMap<u32, char>>,
    /// Last paint time per row (Unix ms) — used to distinguish a *current*
    /// status row from stale text that lingers in a TUI's on-screen
    /// scrollback (e.g. Pi keeps a failed request's error line visible even
    /// after the model recovers and renders new content below it).
    row_paint_ms: BTreeMap<u32, u64>,
    row: u32,
    col: u32,
    saved_cursor: Option<(u32, u32)>,
    /// Bytes of an escape/CSI/UTF-8 sequence that arrived split across chunks.
    pending: Vec<u8>,
    /// Currently inside an OSC payload (skip until BEL or ST).
    in_osc: bool,
    /// Bytes consumed by the in-flight OSC payload (for the malformed-payload
    /// length cap). Reset on entry/termination — a chunk boundary must not
    /// confuse it.
    osc_len: usize,
    /// Unix ms of the current feed batch — stamped onto every row painted or
    /// erased by it, so recency can be compared across rows and batches.
    feed_ms: u64,
    /// Unix ms when the visible content last changed.
    pub last_change_ms: u64,
}

impl Screen {
    pub fn new(now_ms: u64) -> Self {
        Self {
            rows: BTreeMap::new(),
            row_paint_ms: BTreeMap::new(),
            row: 0,
            col: 0,
            saved_cursor: None,
            pending: Vec::new(),
            in_osc: false,
            osc_len: 0,
            feed_ms: now_ms,
            last_change_ms: now_ms,
        }
    }

    /// Feed a chunk of raw PTY bytes. Returns whether the visible content
    /// changed (used to skip re-rendering when nothing was painted).
    pub fn feed(&mut self, data: &[u8], now_ms: u64) -> bool {
        self.feed_ms = now_ms;
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(data);
        let mut i = 0;
        let mut changed = false;

        while i < buf.len() {
            let b = buf[i];

            if self.in_osc {
                // OSC payload: skip until BEL or ST (`ESC \`). A payload that
                // never terminates (corrupt stream) is force-dropped after
                // MAX_OSC_BYTES so it can't swallow the rest of the session.
                if b == 0x07 {
                    self.in_osc = false;
                    i += 1;
                } else if b == 0x1b {
                    if i + 1 < buf.len() && buf[i + 1] == b'\\' {
                        self.in_osc = false;
                        i += 2;
                    } else {
                        i += 1;
                    }
                } else {
                    i += 1;
                    self.osc_len += 1;
                    if self.osc_len > MAX_OSC_BYTES {
                        self.in_osc = false;
                    }
                }
                continue;
            }

            if b == 0x1b {
                // Need at least one more byte to classify the sequence.
                if i + 1 >= buf.len() {
                    self.pending = buf[i..].to_vec();
                    break;
                }
                let next = buf[i + 1];
                match next {
                    b'[' => {
                        // CSI: scan to the final byte (@–~).
                        let mut j = i + 2;
                        while j < buf.len() && !(0x40..=0x7e).contains(&buf[j]) {
                            j += 1;
                        }
                        if j >= buf.len() {
                            self.pending = buf[i..].to_vec();
                            break;
                        }
                        let params = String::from_utf8_lossy(&buf[i + 2..j]).to_string();
                        changed |= self.csi(&params, buf[j]);
                        i = j + 1;
                    }
                    b']' => {
                        self.in_osc = true;
                        self.osc_len = 0;
                        i += 2;
                    }
                    // Charset designation: skip the selector byte.
                    b'(' | b')' | b'*' | b'+' => {
                        if i + 2 >= buf.len() {
                            self.pending = buf[i..].to_vec();
                            break;
                        }
                        i += 3;
                    }
                    b'7' => {
                        self.saved_cursor = Some((self.row, self.col));
                        i += 2;
                    }
                    b'8' => {
                        if let Some((r, c)) = self.saved_cursor {
                            self.row = r;
                            self.col = c;
                        }
                        i += 2;
                    }
                    // RIS — reset to initial state.
                    b'c' => {
                        self.rows.clear();
                        self.row_paint_ms.clear();
                        self.row = 0;
                        self.col = 0;
                        changed = true;
                        i += 2;
                    }
                    // RI / IND / NEL.
                    b'M' => {
                        self.row = self.row.saturating_sub(1);
                        i += 2;
                    }
                    b'D' => {
                        self.row += 1;
                        i += 2;
                    }
                    b'E' => {
                        self.row += 1;
                        self.col = 0;
                        i += 2;
                    }
                    _ => i += 2,
                }
                continue;
            }

            match b {
                0x0d => self.col = 0,
                0x0a => self.row += 1,
                0x08 => self.col = self.col.saturating_sub(1),
                0x09 => self.col = (self.col / 8 + 1) * 8,
                0x07 => {}
                b if b < 0x20 => {}
                0x7f => {}
                b if b < 0x80 => {
                    self.paint(b as char);
                    changed = true;
                }
                _ => {
                    // UTF-8 lead byte: decode the full character.
                    let len = utf8_char_len(b);
                    if i + len > buf.len() {
                        self.pending = buf[i..].to_vec();
                        break;
                    }
                    let text = std::str::from_utf8(&buf[i..i + len]).unwrap_or("\u{fffd}");
                    for ch in text.chars() {
                        self.paint(ch);
                    }
                    changed = true;
                    i += len;
                    continue;
                }
            }
            i += 1;
        }

        if changed {
            self.last_change_ms = now_ms;
        }
        self.trim_rows();
        changed
    }

    /// Render the most recent rows as plain text, most-recent-row-last.
    pub fn text(&self) -> String {
        let mut keys: Vec<u32> = self.rows.keys().copied().collect();
        keys.sort_unstable();
        let start = keys.len().saturating_sub(RENDER_ROWS);
        let mut out = String::new();
        for (idx, row_key) in keys[start..].iter().enumerate() {
            if idx > 0 {
                out.push('\n');
            }
            out.push_str(&self.row_text(row_key));
            while out.ends_with(' ') {
                out.pop();
            }
        }
        out
    }

    /// Plain text of a single row (trailing spaces preserved).
    fn row_text(&self, row_key: &u32) -> String {
        let cols = &self.rows[row_key];
        let max_col = cols.keys().max().copied().unwrap_or(0).min(MAX_COLS);
        let mut text = String::new();
        for c in 0..=max_col {
            text.push(cols.get(&c).copied().unwrap_or(' '));
        }
        text
    }

    fn paint(&mut self, ch: char) {
        if self.col >= MAX_COLS {
            return;
        }
        self.rows.entry(self.row).or_default().insert(self.col, ch);
        self.row_paint_ms.insert(self.row, self.feed_ms);
        self.col += 1;
    }

    /// Handle one CSI sequence (params + final byte). Returns whether the
    /// visible content changed.
    fn csi(&mut self, params: &str, final_byte: u8) -> bool {
        let mut changed = false;
        let params = params.strip_prefix('?').unwrap_or(params);
        let nums: Vec<u32> = params
            .split(';')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect();
        let first = nums.first().copied().unwrap_or(0);
        let second = nums.get(1).copied().unwrap_or(0);

        match final_byte {
            b'H' | b'f' => {
                self.row = first.saturating_sub(1);
                self.col = second.saturating_sub(1);
            }
            b'A' => self.row = self.row.saturating_sub(first.max(1)),
            b'B' => self.row += first.max(1),
            b'C' => self.col += first.max(1),
            b'D' => self.col = self.col.saturating_sub(first.max(1)),
            b'G' => self.col = first.saturating_sub(1),
            b'd' => self.row = first.saturating_sub(1),
            b'J' => match first {
                0 => changed |= self.erase_display(0),
                1 => changed |= self.erase_display(1),
                // 2 and 3: clear the whole screen (3 also clears scrollback).
                _ => {
                    if !self.rows.is_empty() {
                        self.rows.clear();
                        self.row_paint_ms.clear();
                        changed = true;
                    }
                }
            },
            b'K' => {
                let Some(cols) = self.rows.get_mut(&self.row) else {
                    return false;
                };
                let before = cols.len();
                match first {
                    0 => cols.retain(|c, _| *c < self.col),
                    1 => cols.retain(|c, _| *c >= self.col),
                    _ => cols.clear(),
                }
                changed |= cols.len() != before;
                if changed {
                    self.row_paint_ms.insert(self.row, self.feed_ms);
                }
            }
            b'X' => {
                let Some(cols) = self.rows.get_mut(&self.row) else {
                    return false;
                };
                let end = self.col + first.max(1);
                let before = cols.len();
                cols.retain(|c, _| *c < self.col || *c >= end);
                changed |= cols.len() != before;
                if changed {
                    self.row_paint_ms.insert(self.row, self.feed_ms);
                }
            }
            // Enter alternate screen: the TUI takes over a fresh surface.
            // (Exiting restores the main screen, but by then the agent
            // process is gone and the detector has cleared it.)
            b'h' if first == 1049 => {
                if !self.rows.is_empty() {
                    self.rows.clear();
                    self.row_paint_ms.clear();
                    changed = true;
                }
            }
            // SGR, scroll region, modes, save/restore, DSR: no visible change.
            _ => {}
        }
        changed
    }

    /// Erase part of the display relative to the cursor. `0` = below, `1` = above.
    fn erase_display(&mut self, mode: u8) -> bool {
        let mut changed = false;
        let keys: Vec<u32> = self.rows.keys().copied().collect();
        for key in keys {
            let cols = &mut self.rows.get_mut(&key).unwrap();
            let before = cols.len();
            if mode == 0 {
                // Keep rows above the cursor, and cells left of the cursor on
                // the cursor row.
                if key < self.row {
                    continue;
                }
                if key == self.row {
                    cols.retain(|c, _| *c < self.col);
                } else {
                    cols.clear();
                }
            } else {
                if key > self.row {
                    continue;
                }
                if key == self.row {
                    cols.retain(|c, _| *c >= self.col);
                } else {
                    cols.clear();
                }
            }
            if cols.len() != before {
                changed = true;
                self.row_paint_ms.insert(key, self.feed_ms);
            }
        }
        changed
    }

    /// Drop the oldest rows once the grid exceeds the row cap.
    fn trim_rows(&mut self) {
        if self.rows.len() <= MAX_ROWS {
            return;
        }
        let mut keys: Vec<u32> = self.rows.keys().copied().collect();
        keys.sort_unstable();
        for key in keys.into_iter().take(self.rows.len() - MAX_ROWS) {
            self.rows.remove(&key);
            self.row_paint_ms.remove(&key);
        }
    }

    /// Whether any *rendered* row whose text contains one of `markers` was
    /// part of the most recent paint batch — painted within `batch_ms` of the
    /// latest content change. Used to gate screen error markers: a TUI agent
    /// (Pi, OpenCode) keeps old error lines in its on-screen conversation
    /// scrollback while it recovers and renders new content below, so an
    /// error only counts while its row is still fresh. A static screen keeps
    /// the error current (nothing newer was painted); new content below the
    /// error row makes it stale.
    pub fn has_recent_marker(&self, markers: &[String], batch_ms: u64) -> bool {
        if markers.is_empty() || self.rows.is_empty() {
            return false;
        }
        let cutoff = self.last_change_ms.saturating_sub(batch_ms);
        let mut keys: Vec<u32> = self.rows.keys().copied().collect();
        keys.sort_unstable();
        let start = keys.len().saturating_sub(RENDER_ROWS);
        for &row_key in &keys[start..] {
            let paint = self.row_paint_ms.get(&row_key).copied().unwrap_or(0);
            if paint < cutoff {
                continue;
            }
            let lower = self.row_text(&row_key).to_lowercase();
            if markers.iter().any(|m| lower.contains(m.as_str())) {
                return true;
            }
        }
        false
    }
}

/// Byte length of a UTF-8 character starting with `lead`.
fn utf8_char_len(lead: u8) -> usize {
    if lead >= 0xF0 {
        4
    } else if lead >= 0xE0 {
        3
    } else if lead >= 0xC0 {
        2
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_lines_accumulate() {
        // Real terminal streams use CRLF; bare LF keeps the column (line-feed
        // only), exactly like a real terminal driver.
        let mut s = Screen::new(0);
        s.feed(b"hello\r\nworld", 0);
        assert_eq!(s.text(), "hello\nworld");
    }

    #[test]
    fn cursor_positioning_paints_at_coords() {
        let mut s = Screen::new(0);
        // OpenCode-style delta paint: `[79;4H` then cells, `[75;6H` then text.
        s.feed("\x1b[79;4H■■■■".as_bytes(), 0);
        s.feed("\x1b[75;6H❯ hi".as_bytes(), 0);
        let text = s.text();
        assert!(text.contains("■■■■"), "got: {text}");
        assert!(text.contains("❯ hi"), "got: {text}");
    }

    #[test]
    fn overwrite_removes_stale_content() {
        let mut s = Screen::new(0);
        s.feed(b"\x1b[79;4Hesc to interrupt", 0);
        assert!(s.text().contains("esc to interrupt"));
        // The idle frame repaints the same row — stale working hint disappears.
        s.feed(b"\x1b[79;4Htab agents        ", 0);
        let text = s.text();
        assert!(!text.contains("interrupt"), "got: {text}");
        assert!(text.contains("tab agents"), "got: {text}");
    }

    #[test]
    fn cursor_blink_does_not_count_as_change() {
        let mut s = Screen::new(100);
        s.feed(b"\x1b[75;6H\x1b[?25h\x1b[?25l\x1b[?2026h\x1b[?25l", 200);
        // No paint → no content change timestamp update.
        assert_eq!(s.last_change_ms, 100);
    }

    #[test]
    fn paint_updates_change_time() {
        let mut s = Screen::new(100);
        s.feed(b"hello", 200);
        assert_eq!(s.last_change_ms, 200);
    }

    #[test]
    fn clear_screen_resets_grid() {
        let mut s = Screen::new(0);
        s.feed(b"line one\nline two", 0);
        s.feed(b"\x1b[2J\x1b[Hfresh", 0);
        let text = s.text();
        assert!(!text.contains("line one"), "got: {text}");
        assert!(text.contains("fresh"), "got: {text}");
    }

    #[test]
    fn erase_line_clears_row() {
        // `[2K` erases the whole row without moving the cursor — the text
        // after it paints at the cursor column, so home the cursor first.
        let mut s = Screen::new(0);
        s.feed(b"before\x1b[2K\r\x1b[1Gafter", 0);
        assert_eq!(s.text(), "after");
    }

    #[test]
    fn utf8_is_preserved() {
        let mut s = Screen::new(0);
        s.feed("✻ Working...".as_bytes(), 0);
        assert_eq!(s.text(), "✻ Working...");
    }

    #[test]
    fn csi_spanning_chunk_boundary() {
        let mut s = Screen::new(0);
        // `[75;6` arrives, final `H` + paint in the next chunk.
        assert!(!s.feed(b"\x1b[75;6", 0));
        assert!(s.feed("H❯ hi".as_bytes(), 0));
        assert!(s.text().contains("❯ hi"));
    }

    #[test]
    fn utf8_spanning_chunk_boundary() {
        let full = "✻ done".as_bytes();
        let mut s = Screen::new(0);
        // Lead byte alone is an incomplete character.
        assert!(!s.feed(&full[..1], 0));
        // Continuation bytes complete the character → a change.
        assert!(s.feed(&full[1..3], 0));
        assert!(s.feed(&full[3..], 0));
        assert_eq!(s.text(), "✻ done");
    }

    #[test]
    fn osc_payload_is_skipped() {
        let mut s = Screen::new(0);
        s.feed("\x1b]0;✳ Claude Code\x07tail".as_bytes(), 0);
        assert_eq!(s.text(), "tail");
    }

    #[test]
    fn malformed_osc_is_capped_and_does_not_swallow_stream() {
        // An OSC payload with no BEL/ST must not swallow the whole session:
        // after the cap the stream resumes being tracked (reviewer-caught).
        let mut s = Screen::new(0);
        let mut data = b"\x1b]0;".to_vec();
        data.extend(std::iter::repeat(b'x').take(MAX_OSC_BYTES + 100));
        data.extend(b"\x1b[Hvisible");
        s.feed(&data, 0);
        assert!(s.text().contains("visible"), "got: {}", s.text());
    }

    fn markers(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn recent_marker_on_static_screen_stays_current() {
        // Error painted once, nothing painted since: the row is still the
        // most recent content — the marker is current even minutes later
        // (the agent sits on the error waiting for input).
        let mut s = Screen::new(1000);
        s.feed("Error: 404 status code (no body)".as_bytes(), 1000);
        assert!(s.has_recent_marker(&markers(&["error:"]), 60_000));
    }

    #[test]
    fn recent_marker_goes_stale_after_newer_content() {
        // The user's case: error row painted, then the agent recovers and
        // renders a response on lower rows. The error row is now older than
        // the latest content change — its marker must no longer count.
        let mut s = Screen::new(1000);
        s.feed(b"Error: 404 status code (no body)\r\nModel: minimax", 1000);
        assert!(s.has_recent_marker(&markers(&["error:"]), 2000));
        // New content painted well after the error batch.
        s.feed(b"\r\n\r\nhi\r\n\r\nHi there!", 30_000);
        assert!(!s.has_recent_marker(&markers(&["error:"]), 2000));
    }

    #[test]
    fn retry_repaint_keeps_error_current_until_recovery() {
        // Pi repaints the retry banner every second — the row stays within
        // the recency window, so the error remains current.
        let mut s = Screen::new(1000);
        s.feed(
            "Internal Server Error [retrying in 1s attempt #4]".as_bytes(),
            1000,
        );
        s.feed(
            "Internal Server Error [retrying in 1s attempt #5]".as_bytes(),
            2000,
        );
        assert!(s.has_recent_marker(&markers(&["internal server error"]), 3000));
        // The agent recovers and paints a response below the banner — the
        // error row is superseded and goes stale.
        s.feed(b"\r\n\r\nWorking...\r\nDone!", 30_000);
        assert!(!s.has_recent_marker(&markers(&["internal server error"]), 3000));
    }

    #[test]
    fn static_error_screen_stays_current_forever() {
        // A genuinely stuck agent: the error is the last thing painted and
        // nothing newer arrives. The marker stays current indefinitely (the
        // agent is still failing, waiting for the user).
        let mut s = Screen::new(1000);
        s.feed("Error: 404 status code (no body)".as_bytes(), 1000);
        for now in [5000, 30_000, 300_000] {
            assert!(s.has_recent_marker(&markers(&["error:"]), now), "at {now}");
        }
    }

    #[test]
    fn renders_most_recent_rows_only() {
        let mut s = Screen::new(0);
        let mut data = Vec::new();
        for i in 0..100 {
            data.extend_from_slice(format!("row {i}\r\n").as_bytes());
        }
        s.feed(&data, 0);
        let text = s.text();
        assert!(text.contains("row 99"), "got: {text}");
        assert!(!text.contains("row 0"), "got: {text}");
    }

    #[test]
    fn carraige_return_and_backspace() {
        let mut s = Screen::new(0);
        s.feed(b"abc\rX", 0);
        assert_eq!(s.text(), "Xbc");
        s.feed(b"\x08\x08Y", 0);
        assert_eq!(s.text(), "Ybc");
    }
}
