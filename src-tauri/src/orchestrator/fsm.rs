/// Tab lifecycle phases (blueprint §10.B). Expanded as multi-tab lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TabPhase {
    AwaitingInput,
    Running,
}

impl TabPhase {
    pub fn can_submit_startup_form(self) -> bool {
        matches!(self, TabPhase::AwaitingInput)
    }

    pub fn after_session_started(self) -> Result<TabPhase, &'static str> {
        if self.can_submit_startup_form() {
            Ok(TabPhase::Running)
        } else {
            Err("session already running")
        }
    }

    pub fn after_session_stopped(self) -> TabPhase {
        TabPhase::AwaitingInput
    }

    pub fn as_store_str(self) -> &'static str {
        match self {
            TabPhase::AwaitingInput => "awaitingInput",
            TabPhase::Running => "running",
        }
    }
}
