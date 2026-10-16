use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

/// Deserialize a JSON Value payload into a typed struct.
pub fn parse_payload<T: DeserializeOwned>(payload: &Value) -> Result<T, String> {
    serde_json::from_value(payload.clone()).map_err(|e| format!("invalid payload: {}", e))
}

#[derive(Deserialize)]
pub struct FilePayload {
    pub file: String,
}

#[derive(Deserialize)]
pub struct CommitPayload {
    pub message: String,
}

#[derive(Deserialize)]
pub struct DiffPayload {
    pub file: String,
    #[serde(default)]
    pub staged: bool,
}

#[derive(Deserialize)]
pub struct ResolveConflictPayload {
    pub file: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct BranchPayload {
    pub branch: String,
}

#[derive(Deserialize)]
pub struct CreateBranchPayload {
    pub name: String,
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Deserialize)]
pub struct RemotePayload {
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub ssh_passphrase: Option<String>,
}

#[derive(Deserialize)]
pub struct StashPayload {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub include_untracked: bool,
    #[serde(default)]
    pub files: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct StashIndexPayload {
    pub index: usize,
}

#[derive(Deserialize)]
pub struct LogPayload {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub skip: Option<u32>,
}

#[derive(Deserialize)]
pub struct GithubTokenPayload {
    pub token: String,
}

#[derive(Deserialize)]
pub struct GithubListPayload {
    #[serde(default)]
    pub state: Option<String>,
}

#[derive(Deserialize)]
pub struct GithubPrNumberPayload {
    pub number: u64,
}

#[derive(Deserialize)]
pub struct GithubCreatePrPayload {
    pub title: String,
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Deserialize)]
pub struct GithubPrStatePayload {
    pub number: u64,
    pub state: String,
}

#[derive(Deserialize)]
pub struct GithubMergePayload {
    pub number: u64,
    #[serde(default)]
    pub method: Option<String>,
}
