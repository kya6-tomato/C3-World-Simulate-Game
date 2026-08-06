import type { World, Tile, TileKind, Player, Resource } from "./types.ts";
import { RESOURCES } from "./types.ts";
import { Rng } from "./rng.ts";
import { CONFIG } from "./config.ts";

/**
 * 世界をゼロから作る。
 *
 * 設計の要点:
 * 資源を「かたまり」で配置している。均等にばらまくと全員が自給自足できてしまい、
 * 誰も交渉しなくなってゲームが成立しない。わざと偏らせるのが目的。
 */
export function createWorld(playerIds: string[], seed: number): World {
  const rng = new Rng(seed);
  const { mapWidth: W, mapHeight: H } = CONFIG;

  // --- 1. 資源の「大陸」の中心点を置く（資源ごとの偏りの本体） ---
  const mainSeeds: { x: number; y: number; kind: Resource }[] = [];
  for (const res of RESOURCES) {
    for (let i = 0; i < CONFIG.clustersPerResource; i++) {
      mainSeeds.push({ x: rng.int(0, W - 1), y: rng.int(0, H - 1), kind: res });
    }
  }

  // --- 2. 大陸の中に、同じ資源の小さな飛び地を追加する（見た目を自然にするだけ） ---
  // 「一番近い本拠地」が自分と同じ資源になる場所だけを選ぶので、
  // 違う資源の領域を侵食することはない = バランスには影響しない。
  const seeds = mainSeeds.slice();
  for (const res of RESOURCES) {
    for (let i = 0; i < CONFIG.subClustersPerResource; i++) {
      let placed = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const x = rng.int(0, W - 1);
        const y = rng.int(0, H - 1);
        let nearest = mainSeeds[0];
        let nearestDist = Infinity;
        for (const s of mainSeeds) {
          const d = (s.x - x) ** 2 + (s.y - y) ** 2;
          if (d < nearestDist) {
            nearestDist = d;
            nearest = s;
          }
        }
        if (nearest.kind === res) {
          seeds.push({ x, y, kind: res });
          placed = true;
          break;
        }
      }
      if (!placed) {
        // 60回試しても場所がなければ諦める（小さい地図では起こりうる）。
        continue;
      }
    }
  }

  // --- 3. 各マスを「一番近い中心点」の資源にする（ボロノイ図） ---
  // 違う資源の領域が接する境界だけ、川（越えられないマス）を引く。
  const tiles: Tile[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let best = seeds[0];
      let bestDist = Infinity;
      let second = seeds[0];
      let secondDist = Infinity;
      for (const s of seeds) {
        const d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d < bestDist) {
          second = best;
          secondDist = bestDist;
          best = s;
          bestDist = d;
        } else if (d < secondDist) {
          second = s;
          secondDist = d;
        }
      }

      let kind: TileKind = best.kind;
      const isBorder =
        best.kind !== second.kind &&
        Math.sqrt(secondDist) - Math.sqrt(bestDist) < CONFIG.riverWidth;
      if (isBorder) {
        kind = "river";
      } else if (rng.next() < CONFIG.wasteRatio) {
        kind = "waste";
      } else if (rng.next() < CONFIG.offResourceRatio) {
        // まれに、自分の大陸の資源ではない、他の2種類のどちらかが混じる。
        const others = RESOURCES.filter((r) => r !== best.kind);
        kind = rng.pick(others);
      }
      tiles.push({ x, y, kind, owner: null });
    }
  }

  // --- 3. プレイヤーの初期都市を、なるべく離して配置する ---
  const players: Record<string, Player> = {};
  const taken: { x: number; y: number }[] = [];

  for (const id of playerIds) {
    // 開始位置の条件は2つ。
    //
    //  (1) 領土が届く範囲は1種類の資源しかない
    //      → 広げるだけでは3資源そろわない = 交易が必須
    //  (2) 交渉できる範囲には3種類そろっている
    //      → 交渉相手が確実にいる = 生まれた場所のせいで詰まない
    //
    // つまり「資源地帯の内側だが、国境からそう遠くない場所」に全員を生む。
    //
    // 条件を満たす場所は限られるので、見つからなければ段階的に緩める。
    // 逃げ道がないと、全員が同じ場所に積み上がって全滅する。
    const tiers = [
      { nearMax: 1, farMin: 2 }, // 理想: 自領は単一資源、交渉圏に別資源
      { nearMax: 1, farMin: 1 },
      { nearMax: 2, farMin: 2 },
      { nearMax: 3, farMin: 1 }, // 最後の手段
    ];

    let bestSpot: { x: number; y: number } | null = null;

    for (const tier of tiers) {
      let bestScore = -Infinity;
      for (let attempt = 0; attempt < 400; attempt++) {
        const x = rng.int(0, W - 1);
        const y = rng.int(0, H - 1);
        const t = tileAt(tiles, W, x, y);
        if (!t || t.owner !== null || t.kind === "waste" || t.kind === "river")
          continue;

        const near = resourceVarietyNear(tiles, W, H, x, y, 5);
        const far = resourceVarietyNear(tiles, W, H, x, y, CONFIG.tradeRange);
        if (near > tier.nearMax || far < tier.farMin) continue;

        // 既存プレイヤーと近すぎないこと
        const minDist = taken.length === 0
          ? 999
          : Math.min(...taken.map((p) => Math.abs(p.x - x) + Math.abs(p.y - y)));
        if (minDist < 3) continue;

        const sc = Math.min(minDist, 10) * 10 + far;
        if (sc > bestScore) {
          bestScore = sc;
          bestSpot = { x, y };
        }
      }
      if (bestSpot) break;
    }

    // それでも見つからなければ、空いているマスならどこでもよい
    if (!bestSpot) {
      const free = tiles.filter(
        (t) => t.owner === null && t.kind !== "waste" && t.kind !== "river",
      );
      if (free.length === 0) break;
      const t = rng.pick(free);
      bestSpot = { x: t.x, y: t.y };
    }

    taken.push(bestSpot);
    const home = tileAt(tiles, W, bestSpot.x, bestSpot.y)!;
    home.owner = id;
    // 都市が建つマスは必ず何か採れるようにする（初手で詰まないように）
    if (home.kind === "waste" || home.kind === "river")
      home.kind = rng.pick(RESOURCES);

    players[id] = {
      id,
      cities: [{ x: bestSpot.x, y: bestSpot.y, level: 1 }],
      stock: { food: 20, material: 20, knowledge: 10 },
      trust: CONFIG.trustStart,
      standing: "build",
    };

    // 初期領土として隣接1マスも与える
    for (const n of neighbors(bestSpot.x, bestSpot.y, W, H)) {
      const nt = tileAt(tiles, W, n.x, n.y);
      if (nt && nt.owner === null && nt.kind !== "waste" && nt.kind !== "river") {
        nt.owner = id;
        break;
      }
    }
  }

  return {
    turn: 0,
    width: W,
    height: H,
    tiles,
    players,
    contracts: [],
    landOffers: [],
    log: ["世界が生成された。"],
  };
}

/** ある地点の周囲に、何種類の資源があるか数える。 */
export function resourceVarietyNear(
  tiles: Tile[],
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
): number {
  const kinds = new Set<string>();
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      if (Math.abs(x - cx) + Math.abs(y - cy) > radius) continue;
      const t = tileAt(tiles, w, x, y);
      if (t && t.kind !== "waste" && t.kind !== "river") kinds.add(t.kind);
    }
  }
  return kinds.size;
}

/** 座標からマスを取り出す小さな道具。 */
export function tileAt(
  tiles: Tile[],
  width: number,
  x: number,
  y: number,
): Tile | undefined {
  if (x < 0 || y < 0 || x >= width) return undefined;
  return tiles[y * width + x];
}

/** 上下左右の座標を返す。 */
export function neighbors(x: number, y: number, w: number, h: number) {
  return [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ].filter((p) => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h);
}
