//! Test harness: deploys the guard (and the test-only CIS-2 registry) into an in-memory chain.
#![allow(dead_code)]
use agent_spend_guard::*;
use concordium_smart_contract_testing::*;
use concordium_std::{Deserial, HashSha2256, Serial};

pub const OWNER: AccountAddress = AccountAddress([0u8; 32]);
pub const AGENT: AccountAddress = AccountAddress([1u8; 32]);
pub const PAYEE: AccountAddress = AccountAddress([2u8; 32]);
pub const STRANGER: AccountAddress = AccountAddress([3u8; 32]);
pub const COSIGNER: AccountAddress = AccountAddress([4u8; 32]);
/// The agent's 2-of-2 paying account (agent key + co-signer key).
pub const WALLET: AccountAddress = AccountAddress([5u8; 32]);
pub const START_MS: u64 = 1_800_000_000_000; // a fixed block time
pub const ENERGY: Energy = Energy { energy: 100_000 };

pub struct Env {
    pub chain:    Chain,
    pub guard:    ContractAddress,
    pub registry: Option<ContractAddress>,
}

fn deploy(chain: &mut Chain, name: &str) -> ModuleReference {
    let path = format!("{}/../build/{}", env!("CARGO_MANIFEST_DIR"), name);
    let module = module_load_v1_raw(&path).unwrap_or_else(|e| panic!("{path}: {e:?} — run scripts/build-wasm.sh first"));
    chain.module_deploy_v1(Signer::with_one_key(), OWNER, module).unwrap().module_reference
}

pub fn policy() -> SpendPolicy {
    SpendPolicy { asset: Asset::Ccd, per_tx_cap: 100, daily_cap: 250, approval_threshold: 50, auth_ttl_ms: 60_000 }
}

/// `with_registry`: bind the guard to a CIS-2 registry and mint agent badge #7 to `badge_holder`.
pub fn setup(with_registry: bool, badge_holder: AccountAddress) -> Env {
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(START_MS)).build().unwrap();
    for a in [OWNER, AGENT, PAYEE, STRANGER, COSIGNER, WALLET] {
        chain.create_account(Account::new(a, Amount::from_ccd(10_000)));
    }
    let registry = if with_registry {
        let m = deploy(&mut chain, "mock_registry.wasm");
        let r = chain
            .contract_init(Signer::with_one_key(), OWNER, ENERGY, InitContractPayload {
                amount:    Amount::zero(),
                mod_ref:   m,
                init_name: OwnedContractName::new_unchecked("init_mock_registry".into()),
                param:     OwnedParameter::empty(),
            })
            .unwrap()
            .contract_address;
        chain
            .contract_update(Signer::with_one_key(), OWNER, Address::Account(OWNER), ENERGY, UpdateContractPayload {
                amount:       Amount::zero(),
                address:      r,
                receive_name: OwnedReceiveName::new_unchecked("mock_registry.mint".into()),
                message:      OwnedParameter::from_serial(&(7u64, badge_holder)).unwrap(),
            })
            .unwrap();
        Some(r)
    } else {
        None
    };
    let m = deploy(&mut chain, "agent_spend_guard.wasm");
    let guard = chain
        .contract_init(Signer::with_one_key(), OWNER, ENERGY, InitContractPayload {
            amount:    Amount::from_ccd(1),
            mod_ref:   m,
            init_name: OwnedContractName::new_unchecked("init_agent_spend_guard".into()),
            param:     OwnedParameter::from_serial(&InitParams { registry, cosigner: Some(COSIGNER) }).unwrap(),
        })
        .unwrap()
        .contract_address;
    Env { chain, guard, registry }
}

impl Env {
    pub fn call<P: Serial>(
        &mut self,
        from: AccountAddress,
        entry: &str,
        p: &P,
        amount: Amount,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.chain.contract_update(Signer::with_one_key(), from, Address::Account(from), ENERGY, UpdateContractPayload {
            amount,
            address: self.guard,
            receive_name: OwnedReceiveName::new_unchecked(format!("agent_spend_guard.{entry}")),
            message: OwnedParameter::from_serial(p).unwrap(),
        })
    }

    pub fn ok<P: Serial>(&mut self, from: AccountAddress, entry: &str, p: &P) -> ContractInvokeSuccess {
        self.call(from, entry, p, Amount::zero()).unwrap_or_else(|e| panic!("{entry} failed: {:?}", err_of(&e)))
    }

    pub fn fails<P: Serial>(&mut self, from: AccountAddress, entry: &str, p: &P) -> Error {
        let e = self.call(from, entry, p, Amount::zero()).expect_err("expected a reject");
        err_of(&e).expect("contract error")
    }

    pub fn view<P: Serial, R: Deserial>(&self, entry: &str, p: &P) -> R {
        self.chain
            .contract_invoke(OWNER, Address::Account(OWNER), ENERGY, UpdateContractPayload {
                amount:       Amount::zero(),
                address:      self.guard,
                receive_name: OwnedReceiveName::new_unchecked(format!("agent_spend_guard.{entry}")),
                message:      OwnedParameter::from_serial(p).unwrap(),
            })
            .unwrap()
            .parse_return_value()
            .unwrap()
    }

    pub fn register(&mut self, badge: Option<BadgeRef>) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        let p = RegisterAgentParams { agent: AGENT, wallet: WALLET, badge, policy: policy(), allowlist: vec![PAYEE] };
        self.call(OWNER, "registerAgent", &p, Amount::zero())
    }

    pub fn deposit(&mut self, ccd: u64) {
        self.call(OWNER, "deposit", &(), Amount::from_micro_ccd(ccd)).unwrap();
    }

    pub fn auth(&mut self, amount: u64, mode: PayMode) -> Result<AuthorizeOutcome, Error> {
        let p = AuthorizeParams { payee: PAYEE, asset: Asset::Ccd, amount, mode, purpose_hash: HashSha2256([9u8; 32]) };
        match self.call(AGENT, "authorize", &p, Amount::zero()) {
            Ok(s) => Ok(s.parse_return_value().unwrap()),
            Err(e) => Err(err_of(&e).unwrap()),
        }
    }

    pub fn authorization(&self, id: u64) -> AuthorizationView {
        let v: Option<AuthorizationView> = self.view("authorization", &id);
        v.expect("authorization exists")
    }

    pub fn agent(&self) -> AgentView {
        let v: Option<AgentView> = self.view("agent", &AGENT);
        v.expect("agent exists")
    }

    /// Co-signer commits to a transfer digest, then the agent records the settlement tx hash.
    pub fn commit_and_settle(&mut self, id: u64, tx: u8) {
        self.ok(COSIGNER, "commitPayment", &CommitParams { id, digest: HashSha2256([tx; 32]) });
        self.ok(AGENT, "recordSettlement", &SettleParams { id, tx_hash: HashSha2256([tx; 32]) });
    }

    pub fn tick_ms(&mut self, ms: u64) { self.chain.tick_block_time(Duration::from_millis(ms)).unwrap(); }

    pub fn balance(&self, a: AccountAddress) -> Amount { self.chain.account_balance_available(a).unwrap() }
}

/// Approval parameters with a fixed stand-in for the Verification Audit Record anchor hash.
pub fn ap(id: u64) -> ApproveParams { ApproveParams { id, human_proof: HUMAN_PROOF } }
pub const HUMAN_PROOF: HashSha2256 = HashSha2256([0x4a; 32]);

pub fn err_of(e: &ContractInvokeError) -> Option<Error> { e.parse_return_value::<Error>().ok() }
