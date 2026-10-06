mod client;
pub(crate) mod connection;
mod ndjson;
pub(crate) mod text_extract;
mod session_update;
mod handshake;
mod probe;
pub(crate) mod request_handler;
#[cfg(test)]
mod history_probe;
pub(crate) mod session_connect;

pub use client::{AcpClient, PromptResult};
pub(crate) use session_update::{map_session_update, SessionUpdateEvent, SESSION_UPDATE_EVENT};
pub use probe::{probe_acp, probe_acp_handshake};
