use std::collections::VecDeque;

/// Initial allocation for the scrollback ring buffer. Grows to max_capacity
/// on demand; avoids pre-allocating the full scrollback size (up to 10MB)
/// for panes that never fill it, while keeping reallocations rare.
const INITIAL_SCROLLBACK_CAPACITY: usize = 262144; // 256KB

/// Append-only ring buffer capped at `max_capacity` bytes.
/// Front drain is O(1) — the buffer tracks a byte count and pops from the
/// front in one operation regardless of remaining size.
pub struct ScrollbackBuffer {
    data: VecDeque<u8>,
    len: usize,
    max_capacity: usize,
}

impl ScrollbackBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            data: VecDeque::with_capacity(capacity.min(INITIAL_SCROLLBACK_CAPACITY)),
            len: 0,
            max_capacity: capacity,
        }
    }

    pub fn write(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.data.extend(bytes);
        self.len += bytes.len();
        if self.len > self.max_capacity {
            let excess = self.len - self.max_capacity;
            self.data.drain(..excess);
            self.len = self.max_capacity;
        }
    }

    pub fn get_all(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.len);
        // VecDeque as slices: two contiguous slices (head.., ..tail)
        let (a, b) = self.data.as_slices();
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out
    }
}

// ─── Replay sanitization ────────────────────────────────────────────────────
//
// Scrollback is a byte-for-byte copy of PTY output, so it still contains the
// queries a prompt or TUI issued while running: background/foreground colors,
// cursor position, pixel and cell sizes, device attributes. Replaying those
// into a freshly attached client makes its emulator answer every query by
// writing the reply into the PTY. The program that asked has already got its
// answer, so the reply reaches the shell's idle prompt as typed input and is
// echoed as `^[]11;rgb:0d0d/0d0d/0d0d^G` garbage. Queries carry no visual
// state, so drop them from the replay and keep everything else.

/// Copy `data`, dropping control sequences that solicit a terminal reply.
pub fn strip_reply_queries(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == 0x1b {
            if let Some((end, is_query)) = scan_escape(data, i) {
                if !is_query {
                    out.extend_from_slice(&data[i..end]);
                }
                i = end;
                continue;
            }
        }
        out.push(data[i]);
        i += 1;
    }
    out
}

/// End (exclusive) of the escape sequence beginning at `start`, plus whether it
/// is a query that expects a reply. `None` for an incomplete trailing sequence.
fn scan_escape(data: &[u8], start: usize) -> Option<(usize, bool)> {
    match *data.get(start + 1)? {
        b']' => {
            // OSC: ESC ] … (BEL | ST)
            let mut j = start + 2;
            while j < data.len() {
                if data[j] == 0x07 {
                    return Some((j + 1, is_osc_query(&data[start + 2..j])));
                }
                if data[j] == 0x1b && data.get(j + 1) == Some(&b'\\') {
                    return Some((j + 2, is_osc_query(&data[start + 2..j])));
                }
                j += 1;
            }
            None
        }
        b'[' => {
            // CSI: ESC [ … final byte 0x40..=0x7e
            let mut j = start + 2;
            while j < data.len() {
                if (0x40..=0x7e).contains(&data[j]) {
                    return Some((j + 1, is_csi_query(&data[start + 2..=j])));
                }
                j += 1;
            }
            None
        }
        b'P' => {
            // DCS: ESC P … ST (XTGETTCAP requests start with "+q")
            let mut j = start + 2;
            while j < data.len() {
                if data[j] == 0x1b && data.get(j + 1) == Some(&b'\\') {
                    return Some((j + 2, data[start + 2..j].starts_with(b"+q")));
                }
                j += 1;
            }
            None
        }
        _ => Some((start + 2, false)),
    }
}

fn is_osc_query(body: &[u8]) -> bool {
    let Some(semi) = body.iter().position(|&b| b == b';') else {
        return false;
    };
    matches!(&body[..semi], b"4" | b"10" | b"11" | b"12" | b"52") && body[semi..].contains(&b'?')
}

fn is_csi_query(seq: &[u8]) -> bool {
    let Some((&final_byte, body)) = seq.split_last() else {
        return false;
    };
    let private = matches!(body.first().copied(), Some(b'?' | b'>' | b'=' | b'<'));
    match final_byte {
        // Device status report (also cursor position report).
        b'n' => true,
        // Primary, secondary and tertiary device attributes.
        b'c' => true,
        // Window, cell and screen size reports: CSI 14t, 16t, 18t, 19t.
        b't' => matches!(body, b"14" | b"16" | b"18" | b"19"),
        // Kitty keyboard protocol flags query.
        b'u' => body.first() == Some(&b'?'),
        // DECRQM (request mode).
        b'p' => private && body.contains(&b'$'),
        // XTVERSION.
        b'q' => body.first() == Some(&b'>'),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::strip_reply_queries;

    #[test]
    fn drops_color_and_cursor_queries_but_keeps_rendering_sequences() {
        let input = b"\x1b[31mred\x1b[0m\x1b]11;?\x07\x1b[6n\x1b[14t\x1b[1;1Hdone";
        assert_eq!(
            strip_reply_queries(input),
            b"\x1b[31mred\x1b[0m\x1b[1;1Hdone"
        );
    }

    #[test]
    fn keeps_non_query_osc_and_window_commands() {
        let input = b"\x1b]0;title\x07\x1b[8;24;80t\x1b]11;rgb:0d0d/0d0d/0d0d\x07ok";
        assert_eq!(strip_reply_queries(input), input);
    }

    #[test]
    fn handles_st_terminated_queries_and_device_attributes() {
        let input = b"\x1b]10;?\x1b\\\x1b[c\x1b[>c\x1b[?u\x1b[?1$pkeep";
        assert_eq!(strip_reply_queries(input), b"keep");
    }

    #[test]
    fn leaves_incomplete_trailing_escape_untouched() {
        let input = b"abc\x1b[6";
        assert_eq!(strip_reply_queries(input), input);
    }
}
