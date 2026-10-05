/// How a merged role prompt is delivered to the agent (blueprint §16.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectionStrategy {
    SendOnStart,
    AttachToFirstMessage,
}

pub fn injection_strategy_from_role(injection: &str) -> InjectionStrategy {
    match injection {
        "attach_to_first_message" => InjectionStrategy::AttachToFirstMessage,
        _ => InjectionStrategy::SendOnStart,
    }
}
