import type { World, Command, Resource } from "../src/types.ts";
import { RESOURCES } from "../src/types.ts";
import {
  scarcestResource,
  surplusResource,
  buildCostFor,
  expandCostTotal,
  seizeCostFor,
  totalStock,
  capitalDistance,
} from "../src/rules.ts";
import { neighbors, tileAt } from "../src/worldgen.ts";
import { CONFIG } from "../src/config.ts";
import type { Rng } from "../src/rng.ts";

/**
 * 検証用のボット。
 *
 * 本番では人間がIssueに命令を書くが、それを待っていたら
 * バランス調整に何ヶ月もかかる。だからまずボット同士で回して、
 * 「資源が余りすぎないか」「誰も交易しない状況にならないか」を確かめる。
 */
export type BotKind = "trader" | "loner" | "betrayer";

export function decide(
  w: World,
  me: string,
  kind: BotKind,
  rng: Rng,
): Command[] {
  const p = w.players[me];
  if (!p) return [{ type: "pass", player: me }];

  // --- 1. 自分宛ての提案が来ていたら判断する ---
  const out: Command[] = [];
  const nextLv = Math.min(...p.cities.map((c) => c.level)) + 1;
  const nextCost = buildCostFor(nextLv, p.trust);

  const offers = w.contracts.filter(
    (c) => c.status === "proposed" && c.to === me,
  );
  for (const c of offers) {
    const proposer = w.players[c.from];
    // 信用が低い相手とは組まない。ここで信用度が意味を持つ。
    if (!proposer || proposer.trust < CONFIG.tradeBlockedBelow) continue;

    // 「一番足りない資源かどうか」ではなく「建設に足りているか」で判断する。
    // 完全一致だけを待っていると、知識のような希少資源の持ち主が
    // どの提案も受けなくなり、市場全体が凍りつく。
    const lacks = p.stock[c.give] < nextCost[c.give];
    const canSpare =
      p.stock[c.take] >= c.takeAmount * 2 &&
      p.stock[c.take] >= nextCost[c.take];
    if (lacks && canSpare) {
      out.push({ type: "accept", player: me, contractId: c.id });
      break; // 一度に承諾するのは1件まで
    }
  }

  const buildable = canAfford(p.stock, nextCost);

  // --- 2. 裏切り型: 建設できる状態になったら契約を切る ---
  if (kind === "betrayer" && buildable) {
    const mine = w.contracts.find(
      (c) => c.status === "active" && (c.from === me || c.to === me),
    );
    if (mine && rng.next() < 0.9) {
      out.push({ type: "break", player: me, contractId: mine.id });
    }
  }

  // --- 4. 足りない資源があるなら取引を持ちかける（手番を使わない） ---
  if (kind !== "loner") {
    const need = scarcestResource(p.stock);
    const spare = surplusResource(p.stock);
    // 同じ資源についての交渉が進行中でなければ、新たに持ちかける。
    // 資源ごとに1本まで許すことで、3種そろえる動きが同時に進む。
    const alreadyTrading = w.contracts.some(
      (c) =>
        (c.status === "active" || c.status === "proposed") &&
        (c.from === me || c.to === me) &&
        (c.give === need || c.take === need),
    );

    // 建設に足りていない資源は、余剰が少なくても取りに行く。
    const lacking = p.stock[need] < nextCost[need];
    if (need !== spare && p.stock[spare] > (lacking ? 18 : 30) && !alreadyTrading) {
      const partner = findPartner(w, me, need, spare);
      if (partner) {
        out.push({
          type: "offer",
          player: me,
          to: partner,
          give: spare,
          giveAmount: 9,
          take: need,
          takeAmount: 9,
          turns: rng.int(5, 12),
        });
      }
    }
  }

  // --- 5. ここから手番を使う経済行動。1つだけ選ぶ ---
  if (buildable) {
    out.push({ type: "build", player: me });
    return out;
  }

  // 信用を失った隣人がいて、払えるなら土地を奪う。
  if (kind !== "loner") {
    const ownedForSeize = w.tiles.filter((t) => t.owner === me).length;
    const seizeCost = seizeCostFor(ownedForSeize);
    if (totalStock(p.stock) >= seizeCost) {
      const target = findSeizableTile(w, me, scarcestResource(p.stock));
      if (target) {
        out.push({ type: "seize", player: me, x: target.x, y: target.y });
        return out;
      }
    }
  }

  //
  // ただし「払えるから広げる」をやると、開拓が資源を吸い上げ続けて
  // 建設用の貯金が永久にできない。実際それで半数以上が
  // 都市レベル1のまま終わっていた。
  // 建設に必要な分を残せるときだけ広げる。
  const owned = w.tiles.filter((t) => t.owner === me).length;
  const expandCost = expandCostTotal(owned);
  const buildTotal = nextCost.food + nextCost.material + nextCost.knowledge;
  const canSpareForExpand =
    totalStock(p.stock) >= expandCost + buildTotal * 0.6;

  out.push(
    canSpareForExpand
      ? { type: "expand", player: me }
      : { type: "pass", player: me },
  );
  return out;
}

function canAfford(
  stock: { [k in Resource]: number },
  cost: { [k in Resource]: number },
): boolean {
  return RESOURCES.every((r) => stock[r] >= cost[r]);
}

/** 自分が欲しい資源を持っていて、自分が余らせている資源を欲しがっている相手を探す。 */
function findPartner(
  w: World,
  me: string,
  need: Resource,
  spare: Resource,
): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const other of Object.values(w.players)) {
    if (other.id === me) continue;
    if (other.trust < CONFIG.tradeBlockedBelow) continue; // 信用のない相手には持ちかけない
    const d = capitalDistance(w, me, other.id);
    if (d === null || d > CONFIG.tradeRange) continue; // 遠すぎる
    if (other.stock[need] <= 15) continue;

    // すでに手一杯の相手は避ける。
    // これがないと、条件の良い数人に提案が集中し、
    // あぶれた人が一度も契約できないまま終わる。
    const busy = w.contracts.filter(
      (c) =>
        (c.status === "active" || c.status === "proposed") &&
        (c.from === other.id || c.to === other.id),
    ).length;

    // 相手がneedを余らせていて、spareを欲しがっているほど良い。
    // 手一杯の相手は大きく減点する。
    const s = other.stock[need] - other.stock[spare] - busy * 10;
    if (s > bestScore) {
      bestScore = s;
      best = other.id;
    }
  }
  return best;
}

/** 自分の領土に隣接していて、信用が低い相手が持っている、奪えそうなマスを探す。 */
function findSeizableTile(
  w: World,
  me: string,
  scarcest: Resource,
): { x: number; y: number } | null {
  const mine = w.tiles.filter((t) => t.owner === me);
  const candidates: { x: number; y: number; kind: string }[] = [];
  for (const t of mine) {
    for (const n of neighbors(t.x, t.y, w.width, w.height)) {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      if (!nt || !nt.owner || nt.owner === me) continue;
      const owner = w.players[nt.owner];
      if (!owner || owner.trust >= CONFIG.seizeBelowTrust) continue;
      const isCity = Object.values(w.players).some((pl) =>
        pl.cities.some((c) => c.x === nt.x && c.y === nt.y),
      );
      if (isCity) continue;
      candidates.push({ x: nt.x, y: nt.y, kind: nt.kind });
    }
  }
  if (candidates.length === 0) return null;
  const preferred = candidates.filter((c) => c.kind === scarcest);
  return preferred[0] ?? candidates[0];
}
