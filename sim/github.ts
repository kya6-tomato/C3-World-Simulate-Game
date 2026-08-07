/**
 * GitHubのIssue・コメントを読み書きする最小限の部品。
 * 外部ライブラリは使わず、Node組み込みの fetch だけで呼ぶ。
 */

const OWNER = "kya6-tomato";
const REPO = "C3-mini-world-game";
const API = "https://api.github.com";

function token(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) {
    throw new Error(
      "GITHUB_TOKEN が見つかりません。.env に GITHUB_TOKEN=... を書いたか確認してください。",
    );
  }
  return t;
}

async function gh(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub APIエラー ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface GhIssue {
  number: number;
  title: string;
}

export interface GhComment {
  id: number;
  body: string;
  created_at: string;
  user: { login: string } | null;
}

/** リポジトリの開いているIssueを一覧する。 */
export async function listIssues(): Promise<GhIssue[]> {
  return (await gh(`/repos/${OWNER}/${REPO}/issues?state=open&per_page=100`)) as GhIssue[];
}

/** そのIssueのコメントを一覧する。since を指定すると、それ以降のものだけ返る。 */
export async function listComments(
  issueNumber: number,
  since?: string,
): Promise<GhComment[]> {
  const q = since ? `?since=${encodeURIComponent(since)}&per_page=100` : "?per_page=100";
  return (await gh(
    `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments${q}`,
  )) as GhComment[];
}

/** そのIssueに返信コメントを投稿する。 */
export async function postComment(issueNumber: number, body: string): Promise<void> {
  await gh(`/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}
