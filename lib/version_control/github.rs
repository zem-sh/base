use std::sync::OnceLock;

use crate::version_control::git;
use reqwest::blocking::{Client, Response};
use serde::Serialize;
use serde_json::{json, Value};
use zem_addon_sdk::AddonContext;

const API_BASE: &str = "https://api.github.com";
const USER_AGENT: &str = "zem-version-control/1.0";
const DEFAULT_PER_PAGE: usize = 50;

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct GithubRepoInfo {
    pub owner: String,
    pub name: String,
    pub url: String,
    pub description: Option<String>,
    pub default_branch: String,
    pub private: bool,
    pub stars: u64,
    pub forks: u64,
    pub open_issues: u64,
    pub pushed_at: Option<String>,
}

#[derive(Serialize)]
pub struct GithubUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub url: String,
}

#[derive(Serialize)]
pub struct GithubRateLimit {
    pub remaining: u64,
    pub limit: u64,
    pub reset_at: Option<String>,
}

#[derive(Serialize)]
pub struct GithubPullRequest {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub body: Option<String>,
    pub author: Option<String>,
    pub head: String,
    pub base: String,
    pub html_url: String,
    pub updated_at: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
}

#[derive(Serialize)]
pub struct GithubIssue {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub comments: u64,
    pub labels: Vec<String>,
    pub is_pull_request: bool,
    pub html_url: String,
}

#[derive(Serialize)]
pub struct GithubReview {
    pub user: Option<String>,
    pub state: String,
    pub submitted_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Token management (stored in addon settings, no pane scope)
// ---------------------------------------------------------------------------

const TOKEN_KEY: &str = "github_token";

pub async fn get_github_token(ctx: &AddonContext) -> Result<String, String> {
    let settings = ctx
        .get_settings()
        .await
        .map_err(|e| format!("failed to read settings: {}", e))?;
    settings
        .get(TOKEN_KEY)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "No GitHub token configured. Set a token in the GitHub tab.".to_string())
}

pub async fn save_github_token(ctx: &AddonContext, token: &str) -> Result<(), String> {
    let mut settings = ctx
        .get_settings()
        .await
        .map_err(|e| format!("failed to read settings: {}", e))?;
    settings[TOKEN_KEY] = json!(token);
    ctx.set_settings(&settings)
        .await
        .map_err(|e| format!("failed to save settings: {}", e))?;
    Ok(())
}

pub async fn clear_github_token(ctx: &AddonContext) -> Result<(), String> {
    let mut settings = ctx
        .get_settings()
        .await
        .map_err(|e| format!("failed to read settings: {}", e))?;
    if let Some(obj) = settings.as_object_mut() {
        obj.remove(TOKEN_KEY);
    }
    ctx.set_settings(&settings)
        .await
        .map_err(|e| format!("failed to save settings: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Repository resolution
// ---------------------------------------------------------------------------

/// Extract `(owner, repo)` from a git remote URL. Supports https, ssh
/// (`git@github.com:owner/repo.git`) and bare github.com URLs.
pub fn parse_repo_from_url(url: &str) -> Option<(String, String)> {
    let url = url.trim().strip_suffix(".git").unwrap_or(url.trim());
    let url = url
        .strip_prefix("git@")
        .or_else(|| url.strip_prefix("https://"))
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://"))
        .or_else(|| url.strip_prefix("git://"))
        .unwrap_or(url);
    if !url.starts_with("github.com") && !url.contains("github.com/") {
        return None;
    }
    let url = url.split("github.com").nth(1).unwrap_or("");
    let rest = url.trim_start_matches(':').trim_start_matches('/');
    let mut it = rest.split('/').filter(|s| !s.is_empty());
    let owner = it.next()?.to_string();
    let repo = it.next()?.to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

/// Resolve the GitHub `(owner, repo)` for the current working directory by
/// inspecting its remotes (preferring `origin`).
pub fn repo_from_remote(cwd: &str) -> Result<(String, String), String> {
    let remotes = git::git_get_remotes(cwd.to_string())?;
    let remote = remotes
        .iter()
        .find(|r| r.name == "origin")
        .or_else(|| remotes.first())
        .ok_or_else(|| "no git remotes configured".to_string())?;
    parse_repo_from_url(&remote.url).ok_or_else(|| {
        format!(
            "could not determine GitHub repository from remote URL: {}",
            remote.url
        )
    })
}

// ---------------------------------------------------------------------------
// HTTP client helpers
// ---------------------------------------------------------------------------

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(USER_AGENT)
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                if let Ok(v) = reqwest::header::HeaderValue::from_str("2022-11-28") {
                    headers.insert("X-GitHub-Api-Version", v);
                }
                headers
            })
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

fn auth_request(
    client: &Client,
    token: &str,
    method: reqwest::Method,
    url: String,
    body: Option<&Value>,
) -> Result<Response, String> {
    let mut req = client.request(method, &url).bearer_auth(token);
    if let Some(body) = body {
        req = req.json(body);
    }
    req.send()
        .map_err(|e| format!("GitHub API request to {} failed: {}", url, e))
}

fn handle_response(resp: Response) -> Result<Value, String> {
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if status.is_success() {
        return serde_json::from_str(&body)
            .map_err(|e| format!("failed to parse GitHub response: {}", e));
    }
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body);
    match status.as_u16() {
        401 => {
            Err("GitHub authentication failed. The token may be invalid or expired.".to_string())
        }
        403 if message.contains("rate limit") => {
            Err(format!("GitHub rate limit exceeded: {}", message))
        }
        404 => Err(format!("GitHub resource not found: {}", message)),
        code => Err(format!("GitHub API error {}: {}", code, message)),
    }
}

fn api_get(owner: &str, repo: &str, token: &str, path: &str) -> Result<Value, String> {
    let url = format!("{API_BASE}/repos/{owner}/{repo}{path}");
    let resp = auth_request(client(), token, reqwest::Method::GET, url, None)?;
    handle_response(resp)
}

fn api_post(
    owner: &str,
    repo: &str,
    token: &str,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    let url = format!("{API_BASE}/repos/{owner}/{repo}{path}");
    let resp = auth_request(client(), token, reqwest::Method::POST, url, Some(body))?;
    handle_response(resp)
}

fn api_patch(
    owner: &str,
    repo: &str,
    token: &str,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    let url = format!("{API_BASE}/repos/{owner}/{repo}{path}");
    let resp = auth_request(client(), token, reqwest::Method::PATCH, url, Some(body))?;
    handle_response(resp)
}

fn api_put(
    owner: &str,
    repo: &str,
    token: &str,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    let url = format!("{API_BASE}/repos/{owner}/{repo}{path}");
    let resp = auth_request(client(), token, reqwest::Method::PUT, url, Some(body))?;
    handle_response(resp)
}

// ---------------------------------------------------------------------------
// API operations
// ---------------------------------------------------------------------------

pub fn github_repo(owner: &str, repo: &str, token: &str) -> Result<GithubRepoInfo, String> {
    let v = api_get(owner, repo, token, "")?;
    Ok(GithubRepoInfo {
        owner: owner.to_string(),
        name: repo.to_string(),
        url: v
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        description: v
            .get("description")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        default_branch: v
            .get("default_branch")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        private: v.get("private").and_then(|x| x.as_bool()).unwrap_or(false),
        stars: v
            .get("stargazers_count")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        forks: v.get("forks_count").and_then(|x| x.as_u64()).unwrap_or(0),
        open_issues: v
            .get("open_issues_count")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        pushed_at: v
            .get("pushed_at")
            .and_then(|x| x.as_str())
            .map(str::to_string),
    })
}

pub fn github_user(token: &str) -> Result<GithubUser, String> {
    let url = format!("{API_BASE}/user");
    let resp = auth_request(client(), token, reqwest::Method::GET, url, None)?;
    let v = handle_response(resp)?;
    Ok(GithubUser {
        login: v
            .get("login")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        name: v.get("name").and_then(|x| x.as_str()).map(str::to_string),
        avatar_url: v
            .get("avatar_url")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        url: v
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

pub fn github_rate_limit(token: &str) -> Result<GithubRateLimit, String> {
    let url = format!("{API_BASE}/rate_limit");
    let resp = auth_request(client(), token, reqwest::Method::GET, url, None)?;
    let v = handle_response(resp)?;
    let core = v.get("resources").and_then(|r| r.get("core"));
    Ok(GithubRateLimit {
        remaining: core
            .and_then(|c| c.get("remaining"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        limit: core
            .and_then(|c| c.get("limit"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        reset_at: core
            .and_then(|c| c.get("reset"))
            .and_then(|x| x.as_i64())
            .map(|ts| ts.to_string()),
    })
}

pub fn github_pulls(
    owner: &str,
    repo: &str,
    token: &str,
    state: &str,
) -> Result<Vec<GithubPullRequest>, String> {
    let path = format!("/pulls?state={state}&per_page={DEFAULT_PER_PAGE}");
    let v = api_get(owner, repo, token, &path)?;
    let arr = v
        .as_array()
        .ok_or_else(|| "unexpected GitHub response".to_string())?;
    arr.iter()
        .map(|pr| pr_to_pull_request(pr))
        .collect::<Result<Vec<_>, _>>()
}

pub fn github_pull_details(
    owner: &str,
    repo: &str,
    token: &str,
    number: u64,
) -> Result<GithubPullRequest, String> {
    let path = format!("/pulls/{number}");
    let v = api_get(owner, repo, token, &path)?;
    pr_to_pull_request(&v)
}

pub fn github_issues(
    owner: &str,
    repo: &str,
    token: &str,
    state: &str,
) -> Result<Vec<GithubIssue>, String> {
    let path = format!("/issues?state={state}&per_page={DEFAULT_PER_PAGE}");
    let v = api_get(owner, repo, token, &path)?;
    let arr = v
        .as_array()
        .ok_or_else(|| "unexpected GitHub response".to_string())?;
    arr.iter()
        .map(|issue| {
            let pull_request = issue.get("pull_request").is_some();
            Ok(GithubIssue {
                number: issue.get("number").and_then(|x| x.as_u64()).unwrap_or(0),
                title: issue
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                state: issue
                    .get("state")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                author: issue
                    .get("user")
                    .and_then(|u| u.get("login"))
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                created_at: issue
                    .get("created_at")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                updated_at: issue
                    .get("updated_at")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                comments: issue.get("comments").and_then(|x| x.as_u64()).unwrap_or(0),
                labels: issue
                    .get("labels")
                    .and_then(|l| l.as_array())
                    .map(|labels| {
                        labels
                            .iter()
                            .filter_map(|l| {
                                l.get("name").and_then(|n| n.as_str()).map(str::to_string)
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                is_pull_request: pull_request,
                html_url: issue
                    .get("html_url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

pub fn github_create_pr(
    owner: &str,
    repo: &str,
    token: &str,
    title: &str,
    head: &str,
    base: &str,
    body: Option<&str>,
    draft: bool,
) -> Result<GithubPullRequest, String> {
    let mut payload = json!({
        "title": title,
        "head": head,
        "base": base,
        "draft": draft,
    });
    if let Some(body) = body {
        payload["body"] = json!(body);
    }
    let v = api_post(owner, repo, token, "/pulls", &payload)?;
    pr_to_pull_request(&v)
}

pub fn github_merge_pr(
    owner: &str,
    repo: &str,
    token: &str,
    number: u64,
    method: Option<&str>,
) -> Result<Value, String> {
    let mut payload = json!({});
    if let Some(method) = method {
        payload["merge_method"] = json!(method);
    }
    api_put(
        owner,
        repo,
        token,
        &format!("/pulls/{number}/merge"),
        &payload,
    )
}

pub fn github_update_pr(
    owner: &str,
    repo: &str,
    token: &str,
    number: u64,
    state: &str,
) -> Result<Value, String> {
    let payload = json!({ "state": state });
    api_patch(owner, repo, token, &format!("/pulls/{number}"), &payload)
}

pub fn github_pull_reviews(
    owner: &str,
    repo: &str,
    token: &str,
    number: u64,
) -> Result<Vec<GithubReview>, String> {
    let path = format!("/pulls/{number}/reviews");
    let v = api_get(owner, repo, token, &path)?;
    let arr = v
        .as_array()
        .ok_or_else(|| "unexpected GitHub response".to_string())?;
    arr.iter()
        .map(|r| {
            Ok(GithubReview {
                user: r
                    .get("user")
                    .and_then(|u| u.get("login"))
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                state: r
                    .get("state")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                submitted_at: r
                    .get("submitted_at")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
            })
        })
        .collect()
}

/// Fetch and checkout a pull request's head into a local branch. The branch
/// is named `pr-<number>` unless one already exists for it.
pub fn github_checkout_pr(
    cwd: &str,
    number: u64,
    branch_name: Option<&str>,
) -> Result<String, String> {
    use std::path::Path;
    let repo_dir = Path::new(cwd);
    let default_name = format!("pr-{number}");
    let local = branch_name.unwrap_or(&default_name);
    let head_ref = format!("pull/{number}/head:{local}");
    match git::execute_remote_git_command(
        repo_dir,
        &["fetch", "origin", head_ref.as_str()],
        "fetch-pr",
        None,
    ) {
        Ok(_) => {}
        Err(e) => {
            if !e.to_string().contains("already exists") {
                return Err(e.to_string());
            }
        }
    }
    git::execute_remote_git_command(repo_dir, &["checkout", local], "checkout-pr", None)
        .map_err(|e| format!("{:#}", e))?;
    Ok(format!("PR #{number} on branch '{local}'"))
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

fn pr_to_pull_request(pr: &Value) -> Result<GithubPullRequest, String> {
    Ok(GithubPullRequest {
        number: pr.get("number").and_then(|x| x.as_u64()).unwrap_or(0),
        title: pr
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        state: pr
            .get("state")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        draft: pr.get("draft").and_then(|x| x.as_bool()).unwrap_or(false),
        body: pr.get("body").and_then(|x| x.as_str()).map(str::to_string),
        author: pr
            .get("user")
            .and_then(|u| u.get("login"))
            .and_then(|x| x.as_str())
            .map(str::to_string),
        head: pr
            .get("head")
            .and_then(|h| h.get("ref"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        base: pr
            .get("base")
            .and_then(|b| b.get("ref"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        html_url: pr
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        updated_at: pr
            .get("updated_at")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        additions: pr.get("additions").and_then(|x| x.as_u64()),
        deletions: pr.get("deletions").and_then(|x| x.as_u64()),
        changed_files: pr.get("changed_files").and_then(|x| x.as_u64()),
    })
}
