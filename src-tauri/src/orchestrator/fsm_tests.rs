#[cfg(test)]
mod tests {
    use crate::orchestrator::TabPhase;

    #[test]
    fn startup_only_from_awaiting_input() {
        assert!(TabPhase::AwaitingInput.can_submit_startup_form());
        assert!(!TabPhase::Running.can_submit_startup_form());
    }

    #[test]
    fn transitions_to_running_then_back() {
        assert_eq!(
            TabPhase::AwaitingInput.after_session_started().unwrap(),
            TabPhase::Running
        );
        assert!(TabPhase::Running.after_session_started().is_err());
        assert_eq!(
            TabPhase::Running.after_session_stopped(),
            TabPhase::AwaitingInput
        );
    }
}
