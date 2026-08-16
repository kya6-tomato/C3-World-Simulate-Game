import type { World, Player, Resource, Tile } from "../src/types.ts";
import { RESOURCE_JA, RESOURCES } from "../src/types.ts";
import { CONFIG } from "../src/config.ts";
import {
  buildCostFor,
  expandCostTotal,
  seizeCostFor,
  totalStock,
} from "../src/rules.ts";
import { tileAt, neighbors } from "../src/worldgen.ts";

/** そのマスに、誰かの都市が建っているか（rules.tsの同名関数と同じ判定）。 */
function hasCityAt(w: World, x: number, y: number): boolean {
  return Object.values(w.players).some((pl) =>
    pl.cities.some((c) => c.x === x && c.y === y),
  );
}

/** 自分の領土に隣接している、まだ誰のものでもない土地（重複なし）。 */
function adjacentUnowned(w: World, playerId: string): Tile[] {
  const found = new Map<string, Tile>();
  for (const t of w.tiles) {
    if (t.owner !== playerId) continue;
    for (const n of neighbors(t.x, t.y, w.width, w.height)) {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      if (nt && nt.owner === null && nt.kind !== "waste" && nt.kind !== "river") {
        found.set(`${nt.x},${nt.y}`, nt);
      }
    }
  }
  return [...found.values()];
}

/** 自分の領土に隣接していて、信用が低いために奪える他人の土地（都市マスは除く）。 */
function seizableNeighbors(w: World, playerId: string): Tile[] {
  const found = new Map<string, Tile>();
  for (const t of w.tiles) {
    if (t.owner !== playerId) continue;
    for (const n of neighbors(t.x, t.y, w.width, w.height)) {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      if (!nt || !nt.owner || nt.owner === playerId) continue;
      const victim = w.players[nt.owner];
      if (!victim || victim.trust >= CONFIG.seizeBelowTrust) continue;
      if (hasCityAt(w, nt.x, nt.y)) continue;
      found.set(`${nt.x},${nt.y}`, nt);
    }
  }
  return [...found.values()];
}

/**
 * 「今どうすると次どうなるか」の目安を、プレイヤーへの返信に添えるための行を作る。
 * ゲームの結果には影響しない、参考情報だけの関数。
 */
export function statusHint(w: World, playerId: string): string[] {
  const p = w.players[playerId];
  if (!p) return [];

  const lines: string[] = [];
  const pointless: string[] = [];

  // 建設まで、あと何が足りないか
  const city = p.cities
    .slice()
    .sort((a, b) => a.level - b.level)
    .find((c) => c.level < CONFIG.maxCityLevel);
  if (!city) {
    lines.push("すべての都市が最大レベルです。");
    pointless.push("建設（すべての都市が最大レベルのため）");
  } else {
    const cost = buildCostFor(city.level + 1, p.trust);
    const missing = RESOURCES.filter((r) => p.stock[r] < cost[r]).map(
      (r) => `${RESOURCE_JA[r]}${cost[r] - p.stock[r]}`,
    );
    if (missing.length === 0) {
      lines.push(`建設すれば都市が Lv${city.level + 1} になります。`);
    } else {
      lines.push(
        `都市を Lv${city.level + 1} にするには、あと${missing.join("、")}が必要です。`,
      );
      pointless.push("建設（資源が足りないため）");
    }
  }

  // 開拓まで、あと合計いくつ足りないか
  const owned = w.tiles.filter((t) => t.owner === playerId).length;
  const expandCost = expandCostTotal(owned);
  const have = totalStock(p.stock);
  const expandCandidates = adjacentUnowned(w, playerId);
  if (expandCandidates.length === 0) {
    lines.push("隣接する開拓できる土地が今はありません。");
    pointless.push("開拓（隣接する未開拓地がないため）");
  } else if (have >= expandCost) {
    lines.push(`開拓できます（必要は資源の合計${expandCost}、今は合計${have}）。`);
  } else {
    lines.push(
      `開拓するには、あと合計${expandCost - have}の資源が必要です（必要 合計${expandCost}）。`,
    );
    pointless.push("開拓（資源が足りないため）");
  }

  // 隣接している、まだ誰のものでもない土地には何があるか
  if (expandCandidates.length > 0) {
    const ownedKinds = new Set<Resource>();
    for (const t of w.tiles) {
      if (t.owner === playerId && t.kind !== "waste" && t.kind !== "river") {
        ownedKinds.add(t.kind as Resource);
      }
    }
    const counts = new Map<Resource, number>();
    for (const t of expandCandidates) {
      const k = t.kind as Resource;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([kind, n]) => {
      const isNew = !ownedKinds.has(kind);
      return `${RESOURCE_JA[kind]}${n}マス${isNew ? "（今は持っていない資源）" : ""}`;
    });
    lines.push(`隣接する開拓候補: ${parts.join("、")}。`);
  }

  // 提案は、信用が低いと誰にもできない
  if (p.trust < CONFIG.tradeBlockedBelow) {
    pointless.push(`提案（信用が低く誰とも契約できないため。今の信用${p.trust}）`);
  }

  // 奪う：対象がいるか、いても資源が足りるか
  const seizeTargets = seizableNeighbors(w, playerId);
  if (seizeTargets.length === 0) {
    pointless.push("奪う（隣接して信用の低い相手がいないため）");
  } else {
    const seizeCost = seizeCostFor(owned);
    if (have < seizeCost) {
      pointless.push(`奪う（資源が足りないため。必要 合計${seizeCost}）`);
    }
  }

  if (pointless.length > 0) {
    lines.push(`今やっても効果がない行動: ${pointless.join("、")}。`);
  }

  // 今の常時行動（コメントしなかった時に自動で続く行動）が、その「効果がない行動」に
  // 当てはまっている場合は、特に見落としやすいので念押しする。
  const standingLabel: Record<Player["standing"], string> = {
    build: "建設",
    expand: "開拓",
    pass: "待機",
  };
  if (
    p.standing !== "pass" &&
    pointless.some((x) => x.startsWith(standingLabel[p.standing]))
  ) {
    lines.push(
      `※ 今の常時行動は「${standingLabel[p.standing]}」ですが、上の理由でこのままでは何も起きません。`,
    );
  }

  return lines;
}
