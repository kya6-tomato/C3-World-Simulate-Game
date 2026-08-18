import { existsSync as fileExists } from "node:fs";
if (fileExists(".env")) process.loadEnvFile(".env");
import { postNote } from "./misskey.ts";

/**
 * 次のターン更新（9/13/17/21時JST＝UTC0/4/8/12時）の1時間前・10分前に、
 * Misskeyへリマインダーを投稿する。
 *
 * 「1時間前か10分前か」は、実行された時刻そのものではなく、
 * 実際に次のターン更新まで何分残っているかを毎回計算して決める。
 * GitHub Actionsのスケジュール実行は数十分ずれることがあるため、
 * 「起動した時刻の分が0分台/50分台か」で判定すると、遅延が大きい
 * ときに誤判定してしまう（例: 1時間前用のジョブが30分遅れて発火すると、
 * 10分前だと勘違いしてしまう）。実際の残り時間から逆算すれば、
 * 多少遅延しても正しい表示になる。
 */

function minutesUntilNextTurn(): number {
  const turnHoursUtc = [0, 4, 8, 12]; // JST 9/13/17/21時
  const now = new Date();
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let best = Infinity;
  for (const h of turnHoursUtc) {
    let diff = h * 60 - nowMinutes;
    if (diff <= 0) diff += 24 * 60;
    if (diff < best) best = diff;
  }
  return best;
}

async function main() {
  const remaining = minutesUntilNextTurn();
  const label = remaining >= 30 ? "約1時間" : `${remaining}分`;
  const body =
    `C3-World-Simulate-Game参加者の皆さん！\n\n` +
    `⏰ **もうすぐ更新です（あと${label}）**\n\n` +
    `コマンドの入力はお済みですか？`;
  await postNote(body);
  console.log(`投稿しました（残り${remaining}分・表示「${label}」）。`);
}

main().catch((e) => {
  console.error("Misskeyへの投稿に失敗しました:", e);
  process.exit(1);
});
