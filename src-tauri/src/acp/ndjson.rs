//! NDJSON framing for ACP stdout. One JSON value per line.
//! Partial lines stay in the reader until a newline. Oversized lines are dropped
//! so a huge tool result cannot grow memory without a bound.

use serde_json::Value;
use std::io::{BufRead, Error, Result};

/// Incoming ACP lines larger than this are discarded (the rest of the line too).
pub const MAX_ACP_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub enum ParsedLine {
    Empty,
    Value(Value),
    Malformed(String),
}

pub fn parse_acp_line(line: &str) -> ParsedLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ParsedLine::Empty;
    }
    // `len` is bytes for str, which matches the reader cap.
    if trimmed.len() > MAX_ACP_LINE_BYTES {
        return ParsedLine::Malformed(format!(
            "ACP line is {} bytes (limit {MAX_ACP_LINE_BYTES})",
            trimmed.len()
        ));
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => ParsedLine::Value(value),
        Err(err) => ParsedLine::Malformed(err.to_string()),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CappedRead {
    Line(Vec<u8>),
    TooLarge,
    Eof,
    /// Stream ended without a newline. Caller decides whether to parse the fragment.
    EofPartial(Vec<u8>),
}

/// Read one line, including a trailing newline that is not returned.
/// A line longer than `max` bytes is discarded through the next newline.
pub fn read_capped_line<R: BufRead>(reader: &mut R, max: usize) -> Result<CappedRead> {
    let mut out = Vec::new();
    loop {
        let (newline_at, available) = {
            let buf = reader.fill_buf().map_err(|e| Error::new(e.kind(), e.to_string()))?;
            if buf.is_empty() {
                break;
            }
            (buf.iter().position(|b| *b == b'\n'), buf.len())
        };
        if let Some(pos) = newline_at {
            let take = pos + 1;
            if out.len().saturating_add(pos) > max {
                reader.consume(take);
                return Ok(CappedRead::TooLarge);
            }
            {
                let buf = reader.fill_buf()?;
                out.extend_from_slice(&buf[..pos]);
            }
            reader.consume(take);
            if out.last() == Some(&b'\r') {
                out.pop();
            }
            return Ok(CappedRead::Line(out));
        }
        if out.len().saturating_add(available) > max {
            reader.consume(available);
            discard_until_newline(reader)?;
            return Ok(CappedRead::TooLarge);
        }
        {
            let buf = reader.fill_buf()?;
            out.extend_from_slice(buf);
        }
        reader.consume(available);
    }
    if out.is_empty() {
        Ok(CappedRead::Eof)
    } else {
        Ok(CappedRead::EofPartial(out))
    }
}

fn discard_until_newline<R: BufRead>(reader: &mut R) -> Result<()> {
    loop {
        let (newline_at, available) = {
            let buf = reader.fill_buf()?;
            if buf.is_empty() {
                return Ok(());
            }
            (buf.iter().position(|b| *b == b'\n'), buf.len())
        };
        if let Some(pos) = newline_at {
            reader.consume(pos + 1);
            return Ok(());
        }
        reader.consume(available);
    }
}

pub fn consecutive_malformed_limit() -> u32 {
    50
}

/// Prompt text travels in the JSON-RPC body, never in the process argv.
pub fn acp_launch_args() -> &'static [&'static str] {
    &["acp"]
}

pub fn session_prompt_params(session_id: &str, text: &str) -> Value {
    serde_json::json!({
        "sessionId": session_id,
        "prompt": [{ "type": "text", "text": text }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_a_json_line_and_skips_blank() {
        match parse_acp_line("  {\"jsonrpc\":\"2.0\",\"method\":\"session/update\"}\n") {
            ParsedLine::Value(v) => assert_eq!(v["method"], "session/update"),
            other => panic!("expected value, got {other:?}"),
        }
        assert!(matches!(parse_acp_line(" \n"), ParsedLine::Empty));
    }

    #[test]
    fn malformed_and_partial_json_are_not_values() {
        assert!(matches!(
            parse_acp_line("{{\"nope\":"),
            ParsedLine::Malformed(_)
        ));
        assert!(matches!(
            parse_acp_line("{\"jsonrpc\": \"2.0\""),
            ParsedLine::Malformed(_)
        ));
    }

    #[test]
    fn capped_reader_returns_lines_and_drops_oversize() {
        let raw = b"{\"a\":1}\n{\"b\":2}\nTOO-BIG-LINE\n{\"c\":3}\n";
        let mut cur = Cursor::new(&raw[..]);
        assert_eq!(
            read_capped_line(&mut cur, 64).unwrap(),
            CappedRead::Line(br#"{"a":1}"#.to_vec())
        );
        assert_eq!(
            read_capped_line(&mut cur, 64).unwrap(),
            CappedRead::Line(br#"{"b":2}"#.to_vec())
        );
        assert_eq!(
            read_capped_line(&mut cur, 4).unwrap(),
            CappedRead::TooLarge
        );
        assert_eq!(
            read_capped_line(&mut cur, 64).unwrap(),
            CappedRead::Line(br#"{"c":3}"#.to_vec())
        );
        assert_eq!(read_capped_line(&mut cur, 64).unwrap(), CappedRead::Eof);
    }

    #[test]
    fn partial_line_at_eof_is_reported() {
        let mut cur = Cursor::new(&b"{\"partial\":true}"[..]);
        match read_capped_line(&mut cur, 64).unwrap() {
            CappedRead::EofPartial(bytes) => {
                assert!(matches!(
                    parse_acp_line(&String::from_utf8(bytes).unwrap()),
                    ParsedLine::Value(_)
                ));
            }
            other => panic!("expected partial, got {other:?}"),
        }
    }

    #[test]
    fn launch_args_never_carry_the_prompt() {
        let prompt = "x".repeat(100_000);
        let args = acp_launch_args();
        assert_eq!(args, &["acp"]);
        assert!(args.iter().all(|a| !a.contains(&prompt[..32])));
        let params = session_prompt_params("sess", &prompt);
        let encoded = params.to_string();
        assert!(encoded.contains(&prompt));
        assert!(!args.join(" ").contains("sess"));
    }

    #[test]
    fn oversize_declared_line_is_malformed() {
        let huge = format!("x{}", "y".repeat(MAX_ACP_LINE_BYTES));
        assert!(matches!(parse_acp_line(&huge), ParsedLine::Malformed(_)));
    }
}
