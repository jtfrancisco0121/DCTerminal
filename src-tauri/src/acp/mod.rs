mod client;
pub(crate) mod connection;
mod handshake;
#[cfg(test)]
mod history_probe;
mod ndjson;
mod probe;
pub(crate) mod request_handler;
pub(crate) mod session_connect;
mod session_update;
pub(crate) mod text_extract;

pub use client::{AcpClient, ModelVia, PromptResult};
pub use probe::{probe_acp, probe_acp_handshake};
pub(crate) use session_update::{map_session_update, SessionUpdateEvent, SESSION_UPDATE_EVENT};
