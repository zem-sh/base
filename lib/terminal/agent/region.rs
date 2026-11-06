//! Screen regions used by the status rules.
//!
//! Ported from herdr's detection engine (`src/detect/manifest.rs`): a status
//! rule must match *live* terminal chrome — the input box and the bottom lines
//! — and never arbitrary text that happens to be visible somewhere on the
//! screen. Herdr encodes this by giving every rule a `region`; the helpers here
//! are the subset our profile rules need.
//!
//! Scoping matters because agents keep their whole conversation on screen:
//! an answered permission dialog, a compile error the agent already fixed, or
//! the agent quoting a question inside its own output would otherwise pin the
//! pane's status forever.

/// The last non-empty line, or `""` when the text is blank.
pub fn last_non_empty_line(content: &str) -> &str {
    content
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
}

/// The bottom `count` non-empty lines (trailing blanks trimmed by `lines()`).
pub fn bottom_non_empty_lines(content: &str, count: usize) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    let Some(start_index) = lines
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, line)| !line.trim().is_empty())
        .take(count)
        .last()
        .map(|(index, _)| index)
    else {
        return "";
    };
    slice_from_line_index(content, &lines, start_index)
}

/// The body of the agent's input box — the text between its two horizontal
/// borders. `None` when the screen has no box (plain line-oriented output).
///
/// Herdr's `prompt_box_body` region: the box is bounded by the two bottom-most
/// rules, and the body runs to the next rule below it. The box is the one
/// place a prompt glyph means "waiting for the user" — the same glyph appears
/// mid-screen while the agent is still working.
pub fn prompt_box_body(content: &str) -> Option<&str> {
    let lines: Vec<&str> = content.lines().collect();
    let top = prompt_box_top_border_index(&lines)?;
    let start = line_start_offset(content, &lines, top + 1);
    let end_index = lines[top + 1..]
        .iter()
        .position(|line| is_horizontal_rule(line))
        .map(|relative| top + 1 + relative)
        .unwrap_or(lines.len());
    let end = line_start_offset(content, &lines, end_index);
    Some(&content[start.min(content.len())..end.min(content.len())])
}

/// Everything above the input box (the conversation area).
pub fn above_prompt_box(content: &str) -> &str {
    let lines: Vec<&str> = content.lines().collect();
    let Some(top) = prompt_box_top_border_index(&lines) else {
        return content;
    };
    let end = line_start_offset(content, &lines, top);
    &content[..end.min(content.len())]
}

fn prompt_box_top_border_index(lines: &[&str]) -> Option<usize> {
    let mut border_count = 0;
    for index in (0..lines.len()).rev() {
        if is_horizontal_rule(lines[index]) {
            border_count += 1;
            if border_count == 2 {
                return Some(index);
            }
        }
    }
    None
}

/// A box border line: a run of `─` (with optional short label suffix).
pub fn is_horizontal_rule(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    let rule_chars = trimmed.chars().take_while(|&ch| ch == '─').count();
    if rule_chars == 0 {
        return false;
    }

    let rule_bytes = trimmed
        .char_indices()
        .nth(rule_chars)
        .map(|(index, _)| index)
        .unwrap_or(trimmed.len());
    let suffix = trimmed[rule_bytes..].trim_start();

    suffix.is_empty() || rule_chars >= 3
}

fn slice_from_line_index<'a>(content: &'a str, lines: &[&str], index: usize) -> &'a str {
    let byte_offset = line_start_offset(content, lines, index);
    &content[byte_offset.min(content.len())..]
}

fn line_start_offset(content: &str, lines: &[&str], index: usize) -> usize {
    lines[..index.min(lines.len())]
        .iter()
        .map(|line| line.len() + 1)
        .sum::<usize>()
        .min(content.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOXED_SCREEN: &str = "\
╭──────────────╮
│  previous    │
╰──────────────╯
working on the parser
──────────────────
❯ fix the bug
──────────────────
  ? for shortcuts";

    #[test]
    fn prompt_box_body_is_the_text_between_the_lowest_borders() {
        let body = prompt_box_body(BOXED_SCREEN).expect("prompt box");
        assert!(body.contains("fix the bug"), "got: {body:?}");
        assert!(!body.contains("previous"), "got: {body:?}");
    }

    #[test]
    fn above_prompt_box_excludes_the_box() {
        let above = above_prompt_box(BOXED_SCREEN);
        assert!(above.contains("working on the parser"));
        assert!(!above.contains("fix the bug"), "got: {above:?}");
    }

    #[test]
    fn no_box_screen_yields_no_body() {
        assert_eq!(prompt_box_body("plain output\n❯ hi"), None);
        assert_eq!(above_prompt_box("plain output"), "plain output");
    }

    #[test]
    fn bottom_non_empty_lines_ignores_blank_runs() {
        let content = "a\n\nb\n\n\nc\n\n";
        assert_eq!(bottom_non_empty_lines(content, 2), "b\n\n\nc\n\n");
        assert_eq!(last_non_empty_line(content), "c");
        assert_eq!(last_non_empty_line("\n\n"), "");
    }

    #[test]
    fn horizontal_rule_requires_a_real_run() {
        assert!(is_horizontal_rule("──────────"));
        assert!(is_horizontal_rule("  ──── tab to amend"));
        assert!(!is_horizontal_rule("plain"));
    }
}
