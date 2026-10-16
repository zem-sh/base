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
