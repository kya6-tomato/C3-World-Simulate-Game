import { existsSync as fileExists } from "node:fs";
if (fileExists(".env")) process.loadEnvFile(".env");
import { postNote } from "./misskey.ts";

/**
 * 次のターン更新（9/13/17/21時JST＝UTC0/4/8/12時）の1時間前・約20分前に、
 * Misskeyへリマインダーを投稿する。
 *
 * 「1時間前か20分前か」は、実行された時刻そのものではなく、
 * 実際に次のターン更新まで何分残っているかを毎回計算して決める。
 * GitHub Actionsのスケジュール実行は数十分ずれることがあるため、
 * 「起動した時刻の分が◯分台か」で判定すると、遅延が大きいときに
 * 誤判定してしまう（例: 1時間前用のジョブが30分遅れて発火すると、
 * 20分前だと勘違いしてしまう）。実際の残り時間から逆算すれば、
 * 多少遅延しても正しい表示になる。
 *
 * さらに、遅延がひどく今回の枠（1時間前 or 20分前）を丸ごと逃して、
 * 計算結果が次の次のターンを指してしまった場合（＝残り時間が
 * どちらの想定枠からも大きく外れている場合）は、紛らわしいので
 * 投稿自体を取りやめる（skipReminderThresholdMinutes を参照）。
 */

const skipReminderThresholdMinutes = 90;

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

/** 残り分数を「48分」「1時間20分」のように、実際の値がそのまま伝わる形にする。 */
function formatRemaining(minutes: number): string {
  if (minutes < 60) return `${minutes}分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

async function main() {
  const remaining = minutesUntilNextTurn();

  // 遅延で今回の枠（1時間前 or 20分前）を丸ごと逃し、次の次のターンを
  // 指してしまっている場合は、誤解を招く投稿になるのでやめておく。
  if (remaining > skipReminderThresholdMinutes) {
    console.log(
      `残り${remaining}分と想定より大きく離れているため、今回は投稿をやめました` +
        `（遅延で今回のリマインダー枠を逃したとみられます）。`,
    );
    return;
  }

  const label = formatRemaining(remaining);
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
