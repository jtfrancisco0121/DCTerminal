mod injection;
#[cfg(test)]
mod injection_tests;

pub use injection::{injection_strategy_from_role, InjectionStrategy};
