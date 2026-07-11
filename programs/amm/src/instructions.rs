pub mod activate_market;
pub mod activate_market_1x2;
pub mod buy;
pub mod buy_1x2;
pub mod close_market;
pub mod close_market_1x2;
pub mod create_market_config;
pub mod create_market_config_1x2;
pub mod freeze_market;
pub mod freeze_market_1x2;
pub mod init_market;
pub mod init_market_1x2;
pub mod initialize_config;
pub mod mint_set_1x2;
pub mod open_position;
pub mod open_position_1x2;
pub mod redeem;
pub mod redeem_1x2;
pub mod redeem_set_1x2;
pub mod resolve;
pub mod resolve_1x2;
pub mod sell;
pub mod sell_1x2;

// The `#[program]` macro needs each instruction module's generated
// `__client_accounts_*` / `__cpi_client_accounts_*` items reachable via glob, so
// we glob-re-export every module. Each module's `handler` is deliberately NOT
// pub-used here (kept module-private via `pub(crate)`), so no ambiguous re-export.
pub use activate_market::*;
pub use activate_market_1x2::*;
pub use buy::*;
pub use buy_1x2::*;
pub use close_market::*;
pub use close_market_1x2::*;
pub use create_market_config::*;
pub use create_market_config_1x2::*;
pub use freeze_market::*;
pub use freeze_market_1x2::*;
pub use init_market::*;
pub use init_market_1x2::*;
pub use initialize_config::*;
pub use mint_set_1x2::*;
pub use open_position::*;
pub use open_position_1x2::*;
pub use redeem::*;
pub use redeem_1x2::*;
pub use redeem_set_1x2::*;
pub use resolve::*;
pub use resolve_1x2::*;
pub use sell::*;
pub use sell_1x2::*;
