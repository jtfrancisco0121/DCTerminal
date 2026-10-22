//! One HTTPS call to ClickUp with a deadline, behind [`Transport`] so tests
//! feed recorded replies and never use the network: a GET, or (C3) a POST or
//! PUT with a JSON body. Every call has the same rules: https only, no
//! redirects, the same reply size cap.
//!
//! Blocking on purpose: the app has no async runtime of its own, and every
//! caller is already on a worker thread (`spawn_blocking`).

use super::{ClickUpToken, API_BASE};
use std::time::Duration;

/// One call may take this long, like one `gh` call (`github/runner.rs`).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
/// Replies past this size are refused. A page of 100 tasks is well under it.
const MAX_BODY_BYTES: u64 = 16 * 1024 * 1024;

/// The only write methods there are (C3, plan decision E4): a POST adds a
/// comment, a PUT sets a status. There is no DELETE or PATCH to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMethod {
    Post,
    Put,
}

impl WriteMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Post => "POST",
            Self::Put => "PUT",
        }
    }
}

/// What the client needs from HTTP.
pub trait Transport: Sync {
    /// GET `API_BASE` + `path` (which starts with `/` and may carry a query)
    /// with `Authorization: <token>`. `Err` means no HTTP reply came back.
    fn get(&self, path: &str, token: &ClickUpToken) -> Result<Reply, NoReply>;

    /// `method` `API_BASE` + `path` with `body` as JSON, and the same
    /// header (C3). `Err` means no HTTP reply came back.
    fn send(
        &self,
        method: WriteMethod,
        path: &str,
        body: &str,
        token: &ClickUpToken,
    ) -> Result<Reply, NoReply>;
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Reply {
    pub status: u16,
    /// `X-RateLimit-Remaining`: calls left in this window.
    pub rate_remaining: Option<u32>,
    /// `X-RateLimit-Reset`: unix seconds when the window refills.
    pub rate_reset: Option<i64>,
    /// `Retry-After`, in seconds, when a 429 sends one.
    pub retry_after: Option<u64>,
    pub body: String,
}

/// Why no reply came back. Kinds only: a transport's own error text is never
/// passed on, so nothing it echoes can leak.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoReply {
    Timeout,
    /// Nothing was sent: the name did not resolve or the connection was
    /// never made.
    Offline,
    /// The call broke after it started (a reset, a broken read), TLS, a
    /// reply too large to read, or anything else. A write may have landed.
    Failed,
}

/// The real transport: `ureq` with rustls and its bundled root certificates.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_TIMEOUT))
            // 4xx and 5xx are replies to read, not transport errors.
            .http_status_as_error(false)
            .https_only(true)
            // A redirect could carry the header to another host.
            .max_redirects(0)
            .user_agent(concat!("DCTerminal/", env!("CARGO_PKG_VERSION")))
            .build();
        Self {
            agent: config.into(),
        }
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

/// A header's value, parsed. ClickUp sends `X-Ratelimit-Remaining` in mixed
/// case; header names match case-insensitively.
fn header<T: std::str::FromStr>(headers: &ureq::http::HeaderMap, name: &str) -> Option<T> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

/// A reply with the rate-limit headers read and no body yet.
fn reply_head(status: u16, headers: &ureq::http::HeaderMap) -> Reply {
    Reply {
        status,
        rate_remaining: header(headers, "x-ratelimit-remaining"),
        rate_reset: header(headers, "x-ratelimit-reset"),
        retry_after: header(headers, "retry-after"),
        body: String::new(),
    }
}

/// Why no reply came back. `Offline` is only for errors before anything was
/// sent (the name did not resolve, the connection was never made), so a
/// write that is `Offline` was certainly not received. Any error mid-call (a
/// reset, a broken read) is `Failed`: ClickUp may have acted on it (C3).
fn no_reply(err: &ureq::Error) -> NoReply {
    match err {
        ureq::Error::Timeout(_) => NoReply::Timeout,
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed => NoReply::Offline,
        _ => NoReply::Failed,
    }
}

/// A reply from its status line and the body read. A write whose 2xx status
/// line arrived is done, even when its body then failed to read: ClickUp
/// accepted it, and a write's body is never used.
fn finish(mut head: Reply, body: Result<String, ureq::Error>, write: bool) -> Result<Reply, NoReply> {
    match body {
        Ok(body) => head.body = body,
        Err(_) if write && (200..300).contains(&head.status) => {}
        Err(err) => return Err(no_reply(&err)),
    }
    Ok(head)
}

/// The reply's status, rate-limit headers and body, read up to the cap.
fn read_reply(
    response: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    write: bool,
) -> Result<Reply, NoReply> {
    let mut response = response.map_err(|err| no_reply(&err))?;
    let head = reply_head(response.status().as_u16(), response.headers());
    let body = response.body_mut().with_config().limit(MAX_BODY_BYTES).read_to_string();
    finish(head, body, write)
}

impl Transport for UreqTransport {
    fn get(&self, path: &str, token: &ClickUpToken) -> Result<Reply, NoReply> {
        read_reply(
            self.agent
                .get(format!("{API_BASE}{path}"))
                .header("Authorization", token.expose())
                .header("Accept", "application/json")
                .call(),
            false,
        )
    }

    fn send(
        &self,
        method: WriteMethod,
        path: &str,
        body: &str,
        token: &ClickUpToken,
    ) -> Result<Reply, NoReply> {
        let url = format!("{API_BASE}{path}");
        let request = match method {
            WriteMethod::Post => self.agent.post(url),
            WriteMethod::Put => self.agent.put(url),
        };
        read_reply(
            request
                .header("Authorization", token.expose())
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .send(body),
            true,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ureq::http::{HeaderMap, HeaderName, HeaderValue};

    #[test]
    fn rate_limit_headers_are_read_in_any_case() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("X-Ratelimit-Limit", "100"),
            ("X-Ratelimit-Remaining", "37"),
            ("X-Ratelimit-Reset", "1790000060"),
            ("Retry-After", " 12 "),
        ] {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_static(value),
            );
        }
        let reply = reply_head(200, &headers);
        assert_eq!(reply.rate_remaining, Some(37));
        assert_eq!(reply.rate_reset, Some(1_790_000_060));
        assert_eq!(reply.retry_after, Some(12));
        assert_eq!(reply_head(200, &HeaderMap::new()).rate_remaining, None);
    }

    #[test]
    fn only_errors_before_anything_was_sent_count_as_offline() {
        assert_eq!(no_reply(&ureq::Error::HostNotFound), NoReply::Offline);
        assert_eq!(no_reply(&ureq::Error::ConnectionFailed), NoReply::Offline);
        assert_eq!(no_reply(&ureq::Error::Timeout(ureq::Timeout::Global)), NoReply::Timeout);
        // A reset or a broken read mid-call: the request may have landed.
        for kind in [
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::BrokenPipe,
            std::io::ErrorKind::UnexpectedEof,
        ] {
            assert_eq!(no_reply(&ureq::Error::Io(std::io::Error::from(kind))), NoReply::Failed, "{kind:?}");
        }
        assert_eq!(no_reply(&ureq::Error::BodyExceedsLimit(1)), NoReply::Failed);
    }

    #[test]
    fn a_write_whose_2xx_arrived_is_done_even_if_its_body_breaks() {
        let head = |status| Reply { status, ..Reply::default() };
        let reset = || Err(ureq::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionReset)));
        assert_eq!(finish(head(200), reset(), true), Ok(head(200)), "ClickUp accepted the write");
        assert_eq!(finish(head(200), reset(), false), Err(NoReply::Failed), "a read needs its body");
        assert_eq!(finish(head(502), reset(), true), Err(NoReply::Failed), "not a 2xx: may have landed");
        let read = finish(head(200), Ok("{}".into()), false).unwrap();
        assert_eq!(read.body, "{}");
    }

    #[test]
    fn post_and_put_are_the_only_write_methods() {
        // An exhaustive match: a new variant fails to build here first.
        for method in [WriteMethod::Post, WriteMethod::Put] {
            let name = match method {
                WriteMethod::Post => "POST",
                WriteMethod::Put => "PUT",
            };
            assert_eq!(method.as_str(), name);
        }
    }

    #[test]
    fn the_transport_refuses_plain_http_and_redirects() {
        // No network: these settings keep the header from going anywhere
        // but ClickUp.
        let transport = UreqTransport::new();
        let config = transport.agent.config();
        assert!(config.https_only());
        assert_eq!(config.max_redirects(), 0);
        assert!(!config.http_status_as_error());
        assert!(API_BASE.starts_with("https://api.clickup.com/"));
    }
}
