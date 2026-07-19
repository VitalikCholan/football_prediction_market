pub mod activate_market;
pub mod buy;
pub mod close_leverage;
pub mod close_market;
pub mod create_market_config;
pub mod deposit_lp;
pub mod expire_position;
pub mod freeze_market;
pub mod init_leverage_pool;
pub mod init_market;
pub mod initialize_config;
pub mod mint_set;
pub mod open_leverage;
pub mod open_lp_account;
pub mod open_position;
pub mod post_mark;
pub mod redeem;
pub mod redeem_set;
pub mod request_withdraw;
pub mod resolve;
pub mod sell;
pub mod set_risk_valve;
pub mod update_leverage_params;
pub mod withdraw_lp;

// The `#[program]` macro needs each instruction module's generated
// `__client_accounts_*` / `__cpi_client_accounts_*` items reachable via glob, so
// we glob-re-export every module. Each module's `handler` is deliberately NOT
// pub-used here (kept module-private via `pub(crate)`), so no ambiguous re-export.
pub use activate_market::*;
pub use buy::*;
pub use close_leverage::*;
pub use close_market::*;
pub use create_market_config::*;
pub use deposit_lp::*;
pub use expire_position::*;
pub use freeze_market::*;
pub use init_leverage_pool::*;
pub use init_market::*;
pub use initialize_config::*;
pub use mint_set::*;
pub use open_leverage::*;
pub use open_lp_account::*;
pub use open_position::*;
pub use post_mark::*;
pub use redeem::*;
pub use redeem_set::*;
pub use request_withdraw::*;
pub use resolve::*;
pub use sell::*;
pub use set_risk_valve::*;
pub use update_leverage_params::*;
pub use withdraw_lp::*;
