import type { Command, Resource } from "../src/types.ts";
import { CONFIG } from "../src/config.ts";

/**
 * GitHub Issueのコメント（スマホでも打てる一行形式）を Command に変換する。
 *
 * 括弧・引用符・カンマを使わず、単語と数字をスペースで区切るだけの書式にしてある。
 * 「誰が」は書かない。Issueが1人1つの専用スレッドなので、どのIssueに書かれたかで決まる。
 *
 * 詳しい検証（相手が実在するか、距離が届くか等）はここではしない。
 * resolveTurn の中の各 do* 関数が実行時に確かめて、ダメなら理由をログに残す。
 * ここでやるのは「文として読める形になっているか」だけ。
 */

const TYPE_JA: Record<string, Command["type"]> = {
  建設: "build",
  開拓: "expand",
  待機: "pass",
  提案: "offer",
  承諾: "accept",
  破棄: "break",
  拒否: "reject",
  土地提案: "offerLand",
  土地承諾: "acceptLand",
  土地拒否: "rejectLand",
  奪う: "seize",
  回収: "harvest",
  橋: "bridge",
  援助: "aid",
  貢献: "contribute",
  輸出: "export",
  着工: "commence",
  掲示: "post",
  賭ける: "wager",
  妨害: "block",
  強襲: "raid",
};

const RESOURCE_JA_TO_EN: Record<string, Resource> = {
  食料: "food",
  資材: "material",
  知識: "knowledge",
};

export interface ParseResult {
  command: Command | null;
  error: string | null;
}

const USAGE: Record<string, string> = {
  提案:
    `提案 相手のID わたす 資源名 数 もらう 資源名 数 期間ターン（例: 提案 p05 わたす 資材 9 もらう 知識 9 10ターン）。` +
    `期間は${CONFIG.offerMinTurns}〜${CONFIG.offerMaxTurns}ターン`,
  承諾: "承諾 契約ID（例: 承諾 C5-p00-3）",
  破棄: "破棄 契約ID（例: 破棄 C5-p00-3）",
  拒否: "拒否 契約ID（例: 拒否 C5-p00-3）。自分宛ての、まだ返事をしていない提案だけ断れます",
  土地提案:
    "土地提案 相手のID x y もらう 資源名 数（例: 土地提案 p05 12 7 もらう 知識 30） / " +
    "土地提案 相手のID x y もらう 相手の土地のx y（例: 土地提案 p05 12 7 もらう 20 8、土地と土地の交換）",
  土地承諾: "土地承諾 提案ID（例: 土地承諾 L3-p05-1）",
  土地拒否: "土地拒否 提案ID（例: 土地拒否 L3-p05-1）。自分宛ての、まだ返事をしていない土地提案だけ断れます",
  奪う: "奪う x y（例: 奪う 12 7）。最後に資源名を書くと、それを優先して使う（例: 奪う 12 7 資材）",
  回収: "回収 資源名（例: 回収 資材）。自分がその資源のマスを持っている必要があります",
  橋: "橋 x y（例: 橋 12 7）。自分の土地に隣接する川のマスだけ指定できます。1シーズンに1回だけ",
  援助: "援助 相手のID 資源名 数（例: 援助 p05 資材 20）。数は5の倍数にしてください",
  貢献: `貢献 資源名 数（例: 貢献 資材 20）。世界の脅威が発生している間だけ使えます。数は${CONFIG.minTransferUnit}の倍数にしてください`,
  輸出: `輸出 資源名 数（例: 輸出 資材 20）。共同事業が進行している間だけ使えます。数は${CONFIG.minTransferUnit}の倍数にしてください`,
  着工: "着工（引数なし）。共同事業の資材が集まっていて、かつ自分がその隣接地を持っているときだけ使えます",
  掲示: `掲示 メッセージ（例: 掲示 灯台まであと少し、資材ください）。${CONFIG.postMaxLength}文字まで`,
  賭ける: `賭ける 資源名 数（例: 賭ける 資材 20）。陣営戦が発生している間だけ使えます。数は${CONFIG.minTransferUnit}の倍数にしてください`,
  開拓:
    "開拓（自動選択） / 開拓 資源名（その資源を優先） / 開拓 x y（マスを指定） / " +
    "開拓 x y 食料 数 資材 数 知識 数（マスと支払いを両方指定。例: 開拓 10 8 食料 2 資材 8 知識 10）",
  妨害:
    "妨害 x y（例: 妨害 12 7）。独走しているプレイヤーの領土に隣接する空き地だけを指定できます。" +
    "劣勢・危機的なプレイヤーだけが使えます",
  強襲:
    "強襲 x y（例: 強襲 12 7）。独走しているプレイヤーが持つマスなら、隣接していなくても指定できます。" +
    `劣勢・危機的なプレイヤーだけが、1ゲームにつき${CONFIG.raidUsesMax}回まで使えます`,
};

/**
 * 「食料 2 資材 8 知識 10」のような、資源名と数の並びを読み取る。
 * 順不同・一部だけの指定にも対応する（書かなかった資源は0扱い）。
 * 読み取れない部分があれば ok: false を返す。
 */
function parseResourcePairs(
  tokens: string[],
): { ok: true; payment: Partial<Record<Resource, number>> } | { ok: false } {
  if (tokens.length === 0 || tokens.length % 2 !== 0) return { ok: false };
  const payment: Partial<Record<Resource, number>> = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const res = RESOURCE_JA_TO_EN[tokens[i]];
    const amount = Number(tokens[i + 1]);
    if (!res || !Number.isInteger(amount) || amount < 0) return { ok: false };
    payment[res] = (payment[res] ?? 0) + amount;
  }
  return { ok: true, payment };
}

/**
 * 末尾の「Nターン」を読み取る。「8ターン」（くっつけ）でも「8 ターン」
 * （スペースあり）でも読めるようにして、細かい書き方の違いで
 * 失敗しないようにしている。
 */
function extractTurns(tokens: string[]): number {
  const last = tokens[tokens.length - 1] ?? "";
  const secondLast = tokens[tokens.length - 2] ?? "";
  if (/^\d+ターン$/.test(last)) {
    return Number(last.replace("ターン", ""));
  }
  if (last === "ターン" && /^\d+$/.test(secondLast)) {
    return Number(secondLast);
  }
  return NaN;
}

export function parseComment(player: string, rawText: string): ParseResult {
  // 全角スペースも区切りとして扱い、前後の空白は無視する。
  const tokens = rawText
    .trim()
    .split(/[\s　]+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return { command: null, error: "コメントが空です。" };
  }

  const word = tokens[0];
  const kind = TYPE_JA[word];
  if (!kind) {
    return {
      command: null,
      error: `「${word}」という命令はありません（建設/開拓/待機/提案/承諾/破棄/拒否/土地提案/土地承諾/土地拒否/奪う/回収/橋/援助/貢献/輸出/着工/掲示/賭ける/妨害/強襲 のどれかを先頭に書いてください）。`,
    };
  }

  if (kind === "build" || kind === "pass" || kind === "commence") {
    return { command: { type: kind, player }, error: null };
  }

  if (kind === "expand") {
    const usage = `書き方: ${USAGE[word]}`;

    // 「開拓」だけ（全自動）
    if (tokens.length === 1) {
      return { command: { type: "expand", player }, error: null };
    }

    // 「開拓 資材」（優先して使う資源だけ指定、マスは自動）
    if (tokens.length === 2 && RESOURCE_JA_TO_EN[tokens[1]]) {
      return {
        command: { type: "expand", player, preferResource: RESOURCE_JA_TO_EN[tokens[1]] },
        error: null,
      };
    }

    // 「開拓 x y ...」（マスを自分で指定）
    const x = Number(tokens[1]);
    const y = Number(tokens[2]);
    if (Number.isInteger(x) && Number.isInteger(y)) {
      const target = { x, y };
      const rest = tokens.slice(3);
      if (rest.length === 0) {
        // マスだけ指定、支払いは自動
        return { command: { type: "expand", player, target }, error: null };
      }
      // 「開拓 x y 食料 2 資材 8 知識 10」（マスと支払いを両方指定）
      const parsed = parseResourcePairs(rest);
      if (!parsed.ok) {
        return { command: null, error: `支払いの内訳が読み取れませんでした。${usage}` };
      }
      return { command: { type: "expand", player, target, payment: parsed.payment }, error: null };
    }

    return { command: null, error: usage };
  }

  if (kind === "accept" || kind === "break" || kind === "reject") {
    const contractId = tokens[1];
    if (!contractId) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return { command: { type: kind, player, contractId }, error: null };
  }

  if (kind === "acceptLand" || kind === "rejectLand") {
    const landOfferId = tokens[1];
    if (!landOfferId) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return { command: { type: kind, player, landOfferId }, error: null };
  }

  if (kind === "seize") {
    const x = Number(tokens[1]);
    const y = Number(tokens[2]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    // 「奪う 12 7 資材」のように、優先して使いたい資源を指定できる（省略可）。
    const preferResource = RESOURCE_JA_TO_EN[tokens[3]];
    return { command: { type: "seize", player, x, y, preferResource }, error: null };
  }

  if (kind === "harvest") {
    // 「回収 資材」のように、回収する資源は省略できない（自動選択はしない）。
    const resource = RESOURCE_JA_TO_EN[tokens[1]];
    if (!resource) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return { command: { type: "harvest", player, resource }, error: null };
  }

  if (kind === "bridge") {
    const x = Number(tokens[1]);
    const y = Number(tokens[2]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return { command: { type: "bridge", player, x, y }, error: null };
  }

  if (kind === "block" || kind === "raid") {
    const x = Number(tokens[1]);
    const y = Number(tokens[2]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { command: null, error: `書き方: ${USAGE[word]}` };
    }
    return { command: { type: kind, player, x, y }, error: null };
  }

  if (kind === "aid") {
    const usage = `書き方: ${USAGE[word]}`;
    const to = tokens[1];
    if (!to) {
      return { command: null, error: `援助する相手が書かれていません。${usage}` };
    }
    const resource = RESOURCE_JA_TO_EN[tokens[2]];
    if (!resource) {
      return { command: null, error: `相手の次には 食料・資材・知識 のどれかを書いてください。${usage}` };
    }
    const amount = Number(tokens[3]);
    if (!Number.isInteger(amount) || amount <= 0) {
      return { command: null, error: `一番最後に、渡す数を半角数字で書いてください。${usage}` };
    }
    if (amount % CONFIG.aidMinUnit !== 0) {
      return {
        command: null,
        error: `援助する数は${CONFIG.aidMinUnit}の倍数にしてください（例: ${CONFIG.aidMinUnit}、${CONFIG.aidMinUnit * 2}）。${usage}`,
      };
    }
    return { command: { type: "aid", player, to, resource, amount }, error: null };
  }

  if (kind === "contribute" || kind === "export" || kind === "wager") {
    const usage = `書き方: ${USAGE[word]}`;
    const resource = RESOURCE_JA_TO_EN[tokens[1]];
    if (!resource) {
      return { command: null, error: `「${word}」の次には 食料・資材・知識 のどれかを書いてください。${usage}` };
    }
    const amount = Number(tokens[2]);
    if (!Number.isInteger(amount) || amount <= 0) {
      return { command: null, error: `一番最後に、出す数を半角数字で書いてください。${usage}` };
    }
    if (amount % CONFIG.minTransferUnit !== 0) {
      return {
        command: null,
        error: `出す数は${CONFIG.minTransferUnit}の倍数にしてください（例: ${CONFIG.minTransferUnit}、${CONFIG.minTransferUnit * 2}）。${usage}`,
      };
    }
    return { command: { type: kind, player, resource, amount }, error: null };
  }

  if (kind === "post") {
    const message = rawText.trim().slice(word.length).trim();
    if (!message) {
      return { command: null, error: `掲示する内容が書かれていません。書き方: ${USAGE[word]}` };
    }
    if (message.length > CONFIG.postMaxLength) {
      return {
        command: null,
        error: `掲示は${CONFIG.postMaxLength}文字までです（今は${message.length}文字）。書き方: ${USAGE[word]}`,
      };
    }
    return { command: { type: "post", player, message }, error: null };
  }

  if (kind === "offer") {
    // どこが読み取れなかったかを具体的に伝える。「書き方」を丸ごと
    // 見せるだけだと、どこを直せばいいのか分かりにくいため。
    const usage = `書き方: ${USAGE[word]}`;

    const to = tokens[1];
    if (!to) {
      return { command: null, error: `提案の相手が書かれていません。${usage}` };
    }

    const giveIdx = tokens.indexOf("わたす");
    if (giveIdx < 0) {
      return { command: null, error: `「わたす」が見つかりません。${usage}` };
    }
    const takeIdx = tokens.indexOf("もらう");
    if (takeIdx < 0) {
      return { command: null, error: `「もらう」が見つかりません。${usage}` };
    }

    const give = RESOURCE_JA_TO_EN[tokens[giveIdx + 1]];
    if (!give) {
      return {
        command: null,
        error: `「わたす」の次には 食料・資材・知識 のどれかを書いてください。${usage}`,
      };
    }
    const giveAmount = Number(tokens[giveIdx + 2]);
    if (!Number.isInteger(giveAmount) || giveAmount <= 0) {
      return {
        command: null,
        error: `「わたす ${tokens[giveIdx + 1]}」の次に、渡す数を半角数字で書いてください。${usage}`,
      };
    }

    const take = RESOURCE_JA_TO_EN[tokens[takeIdx + 1]];
    if (!take) {
      return {
        command: null,
        error: `「もらう」の次には 食料・資材・知識 のどれかを書いてください。${usage}`,
      };
    }
    const takeAmount = Number(tokens[takeIdx + 2]);
    if (!Number.isInteger(takeAmount) || takeAmount <= 0) {
      return {
        command: null,
        error: `「もらう ${tokens[takeIdx + 1]}」の次に、もらう数を半角数字で書いてください。${usage}`,
      };
    }

    const turns = extractTurns(tokens);
    if (!Number.isInteger(turns) || turns <= 0) {
      return {
        command: null,
        error: `一番最後に、続ける期間を「8ターン」のように書いてください。${usage}`,
      };
    }
    if (turns < CONFIG.offerMinTurns || turns > CONFIG.offerMaxTurns) {
      return {
        command: null,
        error: `続ける期間は${CONFIG.offerMinTurns}〜${CONFIG.offerMaxTurns}ターンにしてください（今は${turns}ターン）。${usage}`,
      };
    }

    return {
      command: { type: "offer", player, to, give, giveAmount, take, takeAmount, turns },
      error: null,
    };
  }

  if (kind === "offerLand") {
    const usage = `書き方: ${USAGE[word]}`;
    const to = tokens[1];
    const x = Number(tokens[2]);
    const y = Number(tokens[3]);
    const takeIdx = tokens.indexOf("もらう");

    if (!to || !Number.isInteger(x) || !Number.isInteger(y) || takeIdx < 0) {
      return { command: null, error: usage };
    }

    // 「もらう」の次が資源名なら資源との交換、数字が2つ並んでいれば土地との交換。
    const wantResource = RESOURCE_JA_TO_EN[tokens[takeIdx + 1]];
    if (wantResource) {
      const wantAmount = Number(tokens[takeIdx + 2]);
      if (!Number.isInteger(wantAmount) || wantAmount <= 0) {
        return { command: null, error: usage };
      }
      return {
        command: { type: "offerLand", player, to, x, y, wantResource, wantAmount },
        error: null,
      };
    }

    const wantX = Number(tokens[takeIdx + 1]);
    const wantY = Number(tokens[takeIdx + 2]);
    if (!Number.isInteger(wantX) || !Number.isInteger(wantY)) {
      return { command: null, error: usage };
    }
    return {
      command: { type: "offerLand", player, to, x, y, wantX, wantY },
      error: null,
    };
  }

  return { command: null, error: `「${word}」に対応する処理が実装されていません。` };
}
