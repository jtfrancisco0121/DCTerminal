mod fsm;
#[cfg(test)]
mod fsm_tests;
mod injection;
#[cfg(test)]
mod injection_tests;

pub use fsm::TabPhase;
pub use injection::{injection_strategy_from_role, InjectionStrategy};
