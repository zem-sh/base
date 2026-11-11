pub fn detect_osc7_cwd(data: &[u8]) -> Option<String> {
    const SEQ: &[u8] = b"\x1b]7;file://";
    let mut search = 0;
    while let Some(rel) = memchr::memmem::find(&data[search..], SEQ) {
        let start = search + rel + SEQ.len();
        // Skip the authority (host) portion up to the first `/`.
        let path_start = memchr::memchr(b'/', &data[start..])
            .map(|p| start + p)
            .unwrap_or(start);
        // OSC 7 ends with BEL or ST (`ESC \`). Jump between terminators instead
        // of inspecting every byte: directory payloads are usually short, but
        // this runs on every PTY read.
        let mut end = path_start;
        while let Some(rel) = memchr::memchr2(0x07, 0x1b, &data[end..]) {
            let pos = end + rel;
            if data[pos] == 0x07 {
                return std::str::from_utf8(&data[path_start..pos])
                    .ok()
                    .map(|s| s.to_string());
            }
            if data.get(pos + 1) == Some(&b'\\') {
                return std::str::from_utf8(&data[path_start..pos])
                    .ok()
                    .map(|s| s.to_string());
            }
            end = pos + 1;
        }
        search = start;
        if search >= data.len() {
            break;
        }
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
pub enum Osc1337Event {
    CmdText(String),
    CmdStart,
    CmdEnd(i32),
}

/// Stateful parser for the terminal's OSC 1337 command markers.
///
/// PTY reads are arbitrary byte chunks. A marker can be split between any two
/// reads (`ESC ] 1337;CmdSt` / `art BEL`), so parsing each read independently
/// loses the arm event and makes agent detection appear intermittent. This
/// parser holds one in-flight OSC payload until BEL or ST terminates it.
pub struct Osc1337Parser {
    in_osc: bool,
    pending_esc: bool,
    payload: Vec<u8>,
}

impl Osc1337Parser {
    pub fn new() -> Self {
        Self {
            in_osc: false,
            pending_esc: false,
            payload: Vec::new(),
        }
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<Osc1337Event> {
        const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
        let mut events = Vec::new();
        let mut i = 0;

        while i < data.len() {
            let byte = data[i];

            if self.in_osc {
                if self.pending_esc {
                    self.pending_esc = false;
                    if byte == b'\\' {
                        self.finish(&mut events);
                        i += 1;
                        continue;
                    }
                    // It was not ST. Preserve the literal ESC and process the
                    // current byte as part of the payload.
                    self.payload.push(0x1b);
                }

                match byte {
                    0x07 => {
                        self.finish(&mut events);
                        i += 1;
                    }
                    0x1b => {
                        // ST may be split across reads; defer deciding until
                        // the next byte arrives.
                        self.pending_esc = true;
                        i += 1;
                    }
                    _ => {
                        if self.payload.len() < MAX_PAYLOAD_BYTES {
                            self.payload.push(byte);
                        } else {
                            // A malformed OSC must not retain unbounded data.
                            self.in_osc = false;
                            self.pending_esc = false;
                            self.payload.clear();
                        }
                        i += 1;
                    }
                }
                continue;
            }

            if self.pending_esc {
                self.pending_esc = false;
                if byte == b']' {
                    self.in_osc = true;
                    self.payload.clear();
                    i += 1;
                    continue;
                }
            }

            // Outside an OSC payload, skip runs of ordinary output with a
            // vectorized search for the next ESC instead of per-byte tests.
            if !self.pending_esc && byte != 0x1b {
                match memchr::memchr(0x1b, &data[i..]) {
                    Some(rel) => {
                        i += rel;
                        continue;
                    }
                    None => break,
                }
            }

            if byte != 0x1b {
                i += 1;
                continue;
            }

            if i + 1 >= data.len() {
                self.pending_esc = true;
                i += 1;
                continue;
            }
            if data[i + 1] == b']' {
                self.in_osc = true;
                self.pending_esc = false;
                self.payload.clear();
                i += 2;
            } else {
                i += 1;
            }
        }

        events
    }

    fn finish(&mut self, events: &mut Vec<Osc1337Event>) {
        if let Ok(payload) = std::str::from_utf8(&self.payload) {
            if let Some(cmd) = payload.strip_prefix("1337;CmdText;") {
                events.push(Osc1337Event::CmdText(cmd.to_string()));
            } else if payload == "1337;CmdStart" {
                events.push(Osc1337Event::CmdStart);
            } else if let Some(rest) = payload.strip_prefix("1337;CmdEnd;exit=") {
                if let Ok(code) = rest.parse::<i32>() {
                    events.push(Osc1337Event::CmdEnd(code));
                }
            }
        }
        self.in_osc = false;
        self.pending_esc = false;
        self.payload.clear();
    }
}

impl Default for Osc1337Parser {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse complete OSC 1337 sequences contained in one byte slice.
///
/// Kept as a convenience wrapper. PTY readers should use [`Osc1337Parser`]
/// because read boundaries are not message boundaries.
#[allow(dead_code)]
pub fn detect_osc1337(data: &[u8]) -> Vec<Osc1337Event> {
    Osc1337Parser::new().feed(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_complete_markers() {
        let events = detect_osc1337(
            b"\x1b]1337;CmdText;pi\x07\x1b]1337;CmdStart\x07\x1b]1337;CmdEnd;exit=0\x07",
        );
        assert_eq!(
            events,
            vec![
                Osc1337Event::CmdText("pi".to_string()),
                Osc1337Event::CmdStart,
                Osc1337Event::CmdEnd(0),
            ]
        );
    }

    #[test]
    fn parses_markers_split_across_reads() {
        let mut parser = Osc1337Parser::new();
        assert!(parser.feed(b"\x1b]1337;CmdText;p").is_empty());
        assert_eq!(
            parser.feed(b"i\x07\x1b]1337;CmdSt"),
            vec![Osc1337Event::CmdText("pi".to_string())]
        );
        assert_eq!(parser.feed(b"art\x07"), vec![Osc1337Event::CmdStart]);
    }

    #[test]
    fn parses_st_terminated_marker_split_at_escape() {
        let mut parser = Osc1337Parser::new();
        assert!(parser.feed(b"\x1b]1337;CmdStart\x1b").is_empty());
        assert_eq!(parser.feed(b"\\"), vec![Osc1337Event::CmdStart]);
    }

    #[test]
    fn ignores_other_osc_payloads() {
        let mut parser = Osc1337Parser::new();
        assert!(parser
            .feed(b"\x1b]0;pi\x07\x1b]7;file:///tmp\x07")
            .is_empty());
    }
}
