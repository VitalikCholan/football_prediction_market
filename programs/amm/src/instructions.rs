pub mod activate_market;
pub mod buy;
pub mod close_market;
pub mod create_market_config;
pub mod freeze_market;
pub mod init_market;
pub mod initialize_config;
pub mod mint_set;
pub mod open_position;
pub mod redeem;
pub mod redeem_set;
pub mod resolve;
pub mod sell;

// The `#[program]` macro needs each instruction module's generated
// `__client_accounts_*` / `__cpi_client_accounts_*` items reachable via glob, so
// we glob-re-export every module. Each module's `handler` is deliberately NOT
// pub-used here (kept module-private via `pub(crate)`), so no ambiguous re-export.
pub use activate_market::*;
pub use buy::*;
pub use close_market::*;
pub use create_market_config::*;
pub use freeze_market::*;
pub use init_market::*;
pub use initialize_config::*;
pub use mint_set::*;
pub use open_position::*;
pub use redeem::*;
pub use redeem_set::*;
pub use resolve::*;
pub use sell::*;
