#[cfg(test)]
mod tests {
    use crate::orchestrator::{injection_strategy_from_role, InjectionStrategy};

    #[test]
    fn defaults_to_send_on_start() {
        assert_eq!(
            injection_strategy_from_role("send_on_start"),
            InjectionStrategy::SendOnStart
        );
        assert_eq!(
            injection_strategy_from_role("unknown"),
            InjectionStrategy::SendOnStart
        );
    }

    #[test]
    fn attach_to_first_message() {
        assert_eq!(
            injection_strategy_from_role("attach_to_first_message"),
            InjectionStrategy::AttachToFirstMessage
        );
    }
}
