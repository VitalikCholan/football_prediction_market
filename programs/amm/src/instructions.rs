pub mod buy;
pub mod create_market_config;
pub mod init_market;
pub mod initialize_config;
pub mod open_position;
pub mod sell;

// The `#[program]` macro needs each instruction module's generated
// `__client_accounts_*` / `__cpi_client_accounts_*` items reachable via glob, so
// we glob-re-export every module. Each module's `handler` is deliberately NOT
// pub-used here (kept module-private via `pub(crate)`), so no ambiguous re-export.
pub use buy::*;
pub use create_market_config::*;
pub use init_market::*;
pub use initialize_config::*;
pub use open_position::*;
pub use sell::*;
