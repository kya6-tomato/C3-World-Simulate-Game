/**
 * Misskeyに投稿するための最小限の部品。外部ライブラリは使わず、
 * Node組み込みの fetch だけで呼ぶ（sim/github.ts と同じ考え方）。
 */

const HOST = "misskey.saku.cool";
const API = `https://${HOST}/api`;

function token(): string {
  const t = process.env.MISSKEY_TOKEN;
  if (!t) {
    throw new Error(
      "MISSKEY_TOKEN が見つかりません。.env に MISSKEY_TOKEN=... を書いたか確認してください。",
    );
  }
  return t;
}

/**
 * ノート（投稿）を1件作る。公開範囲は指定しなければ「公開」になる。
 * 失敗したら例外を投げる（呼び出し側で、本体のターン処理を止めないように
 * try/catchするのが前提）。
 */
export async function postNote(text: string): Promise<void> {
  const res = await fetch(`${API}/notes/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ i: token(), text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Misskey APIエラー ${res.status}: ${body}`);
  }
}
