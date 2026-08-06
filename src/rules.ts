import type {
  World,
  Command,
  Player,
  Contract,
  LandOffer,
  Resource,
  Stock,
} from "./types.ts";
import { RESOURCE_JA, RESOURCES } from "./types.ts";
import { Rng, turnSeed } from "./rng.ts";
import { CONFIG } from "./config.ts";
import { tileAt, neighbors } from "./worldgen.ts";

/**
 * ゲームの心臓部。1ターン分を処理する。
 *
 * 大事な性質:
 *  - 同じ world と同じ commands を渡せば、何度やっても必ず同じ結果になる。
 *  - GitHubのことを一切知らない。ただのデータ変換。
 *    だから手元で1秒に何十ターンも回して検証できる。
 *
 * 処理の順番（この順番自体がルール）:
 *   1. 生産    2. 維持費   3. 契約の自動執行   4. 命令の解決   5. 信用の回復
 */
export function resolveTurn(world: World, commands: Command[]): World {
  const w = structuredClone(world); // 元のデータは壊さない
  w.log = [];
  const rng = new Rng(turnSeed(CONFIG.simSeed, w.turn));

  produce(w);
  upkeep(w);
  executeContracts(w);
  applyCommands(w, commands, rng);
  recoverTrust(w);
  clampAllStocks(w);

  w.turn += 1;
  return w;
}

// ---------------------------------------------------------------- 1. 生産

function produce(w: World) {
  // 信用を失うと人が離れ、生産そのものが落ちる。
  // 「取引できない」だけだと、一度裏切って建ててしまえば逃げ切れる。
  // 生産に効かせることで、裏切りの代償が毎ターン続くようにする。
  const mult = (p: Player) =>
    p.trust < CONFIG.tradeBlockedBelow ? CONFIG.lowTrustYieldPenalty : 1;

  for (const tile of w.tiles) {
    if (!tile.owner || tile.kind === "waste") continue;
    const p = w.players[tile.owner];
    if (!p) continue;
    p.stock[tile.kind] += CONFIG.yieldPerTile * mult(p);
  }
  // 都市は食料のみ自給する。資材と知識は土地か交易でしか手に入らない。
  for (const p of Object.values(w.players)) {
    const totalLevel = p.cities.reduce((s, c) => s + c.level, 0);
    p.stock.food += CONFIG.cityFoodPerLevel * totalLevel * mult(p);
  }
}

// ------------------------------------------------------------- 2. 維持費

function upkeep(w: World) {
  for (const p of Object.values(w.players)) {
    const totalLevel = p.cities.reduce((s, c) => s + c.level, 0);
    const cost = CONFIG.upkeepPerCityLevel * totalLevel;
    p.stock.food -= cost;
    if (p.stock.food < 0) {
      // 食料が尽きたら都市が縮む（飢餓）
      p.stock.food = 0;
      const biggest = p.cities.slice().sort((a, b) => b.level - a.level)[0];
      if (biggest && biggest.level > 1) {
        biggest.level -= 1;
        w.log.push(`【飢餓】${p.id} は食料が尽き、都市が縮小した。`);
      }
    }
  }
}

// --------------------------------------------------- 3. 契約の自動執行

function executeContracts(w: World) {
  // 返事のない提案を失効させる。これがないと交渉が詰まる。
  for (const c of w.contracts) {
    if (c.status !== "proposed") continue;
    if (w.turn - c.proposedAt >= CONFIG.offerExpiryTurns) {
      c.status = "expired";
    }
  }
  for (const lo of w.landOffers) {
    if (lo.status !== "proposed") continue;
    if (w.turn - lo.proposedAt >= CONFIG.offerExpiryTurns) {
      lo.status = "expired";
    }
  }

  for (const c of w.contracts) {
    if (c.status !== "active") continue;

    const from = w.players[c.from];
    const to = w.players[c.to];
    if (!from || !to) continue;

    const fromCanPay = from.stock[c.give] >= c.giveAmount;
    const toCanPay = to.stock[c.take] >= c.takeAmount;

    if (!fromCanPay || !toCanPay) {
      // 払えなかった側が不履行。信用が下がる。
      const guilty = !fromCanPay ? from : to;
      c.status = "defaulted";
      guilty.trust += CONFIG.trustOnDefault;
      w.log.push(
        `【不履行】${guilty.id} は契約 ${c.id} の支払いができず、契約が失効した。`,
      );
      continue;
    }

    from.stock[c.give] -= c.giveAmount;
    to.stock[c.give] += c.giveAmount;
    to.stock[c.take] -= c.takeAmount;
    from.stock[c.take] += c.takeAmount;

    c.turnsLeft -= 1;
    if (c.turnsLeft <= 0) {
      c.status = "expired";
      w.log.push(`【満了】${c.from} と ${c.to} の契約 ${c.id} が正常に完了した。`);
    }
  }
}

// ------------------------------------------------------- 4. 命令の解決

/** 手番を消費する命令（経済行動）。1ターンに1つだけ。 */
const ECONOMIC = new Set(["expand", "build", "seize", "pass"]);

function applyCommands(w: World, commands: Command[], rng: Rng) {
  // 外交（提案・承諾・破棄）は手番を消費しない。何度でも行える。
  //
  // ここは重要な設計判断。交渉に手番を使わせると、
  // 「交渉するほど開発が遅れる」ことになり、
  // 交易型が孤立型に負ける。実測でそうなった。
  // 外交を無料にすることで、初めて「話し合う人が強い」ゲームになる。
  const diplomacy = commands.filter((c) => !ECONOMIC.has(c.type));

  // 経済行動はプレイヤーごとに最初の1つだけ採用する。
  const economic: Command[] = [];
  const used = new Set<string>();
  for (const c of commands) {
    if (!ECONOMIC.has(c.type)) continue;
    if (used.has(c.player)) continue;
    used.add(c.player);
    economic.push(c);
  }
  // 経済行動を出さなかった人は、常設命令で自動的に補う。
  for (const p of Object.values(w.players)) {
    if (used.has(p.id)) continue;
    economic.push({ type: p.standing, player: p.id } as Command);
  }

  // 外交を先に解決してから経済行動。順番の有利不利はシャッフルで消す。
  for (const cmd of [...rng.shuffle(diplomacy), ...rng.shuffle(economic)]) {
    const p = w.players[cmd.player];
    if (!p) continue;

    switch (cmd.type) {
      case "expand": doExpand(w, p, rng); break;
      case "build": doBuild(w, p); break;
      case "offer": doOffer(w, p, cmd); break;
      case "accept": doAccept(w, p, cmd.contractId); break;
      case "break": doBreak(w, p, cmd.contractId); break;
      case "offerLand": doOfferLand(w, p, cmd); break;
      case "acceptLand": doAcceptLand(w, p, cmd.landOfferId); break;
      case "seize": doSeize(w, p, cmd); break;
      case "pass": break;
    }
  }
}

function canAfford(stock: Stock, cost: Partial<Stock>): boolean {
  return RESOURCES.every((r) => stock[r] >= (cost[r] ?? 0));
}

function pay(stock: Stock, cost: Partial<Stock>) {
  for (const r of RESOURCES) stock[r] -= cost[r] ?? 0;
}

function doExpand(w: World, p: Player, rng: Rng) {
  const owned = w.tiles.filter((t) => t.owner === p.id).length;
  const cost = expandCostTotal(owned);
  if (totalStock(p.stock) < cost) {
    w.log.push(`${p.id} は資源が足りず開拓できなかった（要 合計${cost}）。`);
    return;
  }

  // 自分の領土に隣接している、誰のものでもないマスを集める
  const candidates = [];
  for (const t of w.tiles) {
    if (t.owner !== p.id) continue;
    for (const n of neighbors(t.x, t.y, w.width, w.height)) {
      const nt = tileAt(w.tiles, w.width, n.x, n.y);
      if (nt && nt.owner === null && nt.kind !== "waste" && nt.kind !== "river")
        candidates.push(nt);
    }
  }
  if (candidates.length === 0) {
    w.log.push(`${p.id} は開拓できる土地がなかった。`);
    return;
  }

  // 一番足りていない資源のマスを優先して取る
  const scarcest = scarcestResource(p.stock);
  const preferred = candidates.filter((t) => t.kind === scarcest);
  const target = rng.pick(preferred.length > 0 ? preferred : candidates);

  payAny(p.stock, cost);
  target.owner = p.id;
  w.log.push(
    `${p.id} が (${target.x},${target.y}) を開拓した [${RESOURCE_JA[target.kind as Resource]}]。`,
  );
}

function doBuild(w: World, p: Player) {
  const city = p.cities
    .slice()
    .sort((a, b) => a.level - b.level)
    .find((c) => c.level < CONFIG.maxCityLevel);
  if (!city) {
    w.log.push(`${p.id} の都市はすべて最大レベル。`);
    return;
  }
  const cost = buildCostFor(city.level + 1, p.trust);
  if (!canAfford(p.stock, cost)) {
    const lacking = RESOURCES.filter((r) => p.stock[r] < cost[r]).map(
      (r) => RESOURCE_JA[r],
    );
    w.log.push(`${p.id} は建設に失敗（${lacking.join("と")}が不足）。`);
    return;
  }
  pay(p.stock, cost);
  city.level += 1;
  w.log.push(`${p.id} が都市を Lv${city.level} に発展させた。`);
}

function doOffer(
  w: World,
  p: Player,
  cmd: Extract<Command, { type: "offer" }>,
) {
  if (!w.players[cmd.to] || cmd.to === p.id) return;

  // 信用を失った者は交渉のテーブルにつけない
  if (p.trust < CONFIG.tradeBlockedBelow) {
    w.log.push(`${p.id} は信用が低すぎて（${p.trust}）誰とも契約できない。`);
    return;
  }

  // 遠すぎる相手とは契約できない。人間関係を近所に閉じ込めるための制限。
  const d = capitalDistance(w, p.id, cmd.to);
  if (d === null || d > CONFIG.tradeRange) {
    w.log.push(`${p.id} は ${cmd.to} まで遠すぎて交渉できない（距離${d}）。`);
    return;
  }
  const id = `C${w.turn}-${p.id}-${w.contracts.length}`;
  const contract: Contract = {
    id,
    from: p.id,
    to: cmd.to,
    give: cmd.give,
    giveAmount: cmd.giveAmount,
    take: cmd.take,
    takeAmount: cmd.takeAmount,
    turnsLeft: cmd.turns,
    proposedAt: w.turn,
    status: "proposed",
  };
  w.contracts.push(contract);
  w.log.push(
    `${p.id} が ${cmd.to} に提案: ${RESOURCE_JA[cmd.give]}${cmd.giveAmount} ↔ ` +
      `${RESOURCE_JA[cmd.take]}${cmd.takeAmount}（${cmd.turns}ターン）`,
  );
}

function doAccept(w: World, p: Player, contractId: string) {
  const c = w.contracts.find((x) => x.id === contractId);
  if (!c || c.status !== "proposed") return;
  if (c.to !== p.id) return; // 自分宛て以外は承諾できない
  const proposer = w.players[c.from];
  if (p.trust < CONFIG.tradeBlockedBelow) return;
  if (proposer && proposer.trust < CONFIG.tradeBlockedBelow) {
    w.log.push(`${p.id} は信用のない ${c.from} との契約を拒否した。`);
    c.status = "broken";
    return;
  }
  c.status = "active";
  w.log.push(`${p.id} が契約 ${c.id} を承諾した。取引が始まる。`);
}

function doBreak(w: World, p: Player, contractId: string) {
  const c = w.contracts.find((x) => x.id === contractId);
  if (!c || c.status !== "active") return;
  if (c.from !== p.id && c.to !== p.id) return;
  c.status = "broken";
  p.trust += CONFIG.trustOnBreak;
  const otherId = c.from === p.id ? c.to : c.from;
  const other = w.players[otherId];

  // 違約金。破った側が、約束していた分を残り期間ぶん相手に払う。
  // 信用の低下は「将来の損」だが、これは「今すぐの損」。
  // 破棄が短期的にも割に合わないようにするための仕組み。
  if (other) {
    const turns = Math.min(c.turnsLeft, CONFIG.breachPenaltyMaxTurns);
    const owed = c.from === p.id ? c.give : c.take;
    const amount = Math.round(
      (c.from === p.id ? c.giveAmount : c.takeAmount) *
        turns *
        CONFIG.breachPenaltyRate,
    );
    const paid = Math.min(amount, p.stock[owed]);
    p.stock[owed] -= paid;
    other.stock[owed] += paid;
    w.log.push(
      `【破棄】${p.id} が ${otherId} との契約を一方的に破棄。違約金 ${RESOURCE_JA[owed]}${paid} を支払った。`,
    );
  }
}

/** そのマスに、誰かの都市が建っているか。 */
function hasCityAt(w: World, x: number, y: number): boolean {
  return Object.values(w.players).some((pl) =>
    pl.cities.some((c) => c.x === x && c.y === y),
  );
}

function doOfferLand(
  w: World,
  p: Player,
  cmd: Extract<Command, { type: "offerLand" }>,
) {
  if (!w.players[cmd.to] || cmd.to === p.id) return;

  const tile = tileAt(w.tiles, w.width, cmd.x, cmd.y);
  if (!tile || tile.owner !== p.id) {
    w.log.push(`${p.id} は (${cmd.x},${cmd.y}) を持っていないので提案できない。`);
    return;
  }
  if (hasCityAt(w, cmd.x, cmd.y)) {
    w.log.push(`${p.id} は自分の都市があるマスは譲れない。`);
    return;
  }
  // 信用を失った者は交渉のテーブルにつけない（資源の取引と同じ扱い）
  if (p.trust < CONFIG.tradeBlockedBelow) {
    w.log.push(`${p.id} は信用が低すぎて（${p.trust}）誰とも取引できない。`);
    return;
  }
  const d = capitalDistance(w, p.id, cmd.to);
  if (d === null || d > CONFIG.tradeRange) {
    w.log.push(`${p.id} は ${cmd.to} まで遠すぎて土地の話ができない（距離${d}）。`);
    return;
  }

  const id = `L${w.turn}-${p.id}-${w.landOffers.length}`;
  const offer: LandOffer = {
    id,
    from: p.id,
    to: cmd.to,
    x: cmd.x,
    y: cmd.y,
    wantResource: cmd.wantResource,
    wantAmount: cmd.wantAmount,
    proposedAt: w.turn,
    status: "proposed",
  };
  w.landOffers.push(offer);
  w.log.push(
    `${p.id} が ${cmd.to} に土地 (${cmd.x},${cmd.y}) を提案: 代わりに ${RESOURCE_JA[cmd.wantResource]}${cmd.wantAmount}。`,
  );
}

function doAcceptLand(w: World, p: Player, landOfferId: string) {
  const lo = w.landOffers.find((x) => x.id === landOfferId);
  if (!lo || lo.status !== "proposed") return;
  if (lo.to !== p.id) return; // 自分宛て以外は承諾できない

  const proposer = w.players[lo.from];
  const tile = tileAt(w.tiles, w.width, lo.x, lo.y);

  // 提案してから状況が変わっている（もう持っていない等）かもしれないので、承諾時に再確認する。
  if (!proposer || !tile || tile.owner !== lo.from) {
    lo.status = "invalid";
    w.log.push(
      `${p.id} が承諾しようとしたが、${lo.from} はもう (${lo.x},${lo.y}) を持っていなかった。`,
    );
    return;
  }
  if (p.stock[lo.wantResource] < lo.wantAmount) {
    lo.status = "invalid";
    w.log.push(`${p.id} は ${RESOURCE_JA[lo.wantResource]}が足りず、土地の取引を成立させられなかった。`);
    return;
  }

  p.stock[lo.wantResource] -= lo.wantAmount;
  proposer.stock[lo.wantResource] += lo.wantAmount;
  tile.owner = p.id;
  lo.status = "accepted";
  w.log.push(
    `${p.id} が ${lo.from} から土地 (${lo.x},${lo.y}) を受け取った（${RESOURCE_JA[lo.wantResource]}${lo.wantAmount}を支払い）。`,
  );
}

function doSeize(
  w: World,
  p: Player,
  cmd: Extract<Command, { type: "seize" }>,
) {
  const target = tileAt(w.tiles, w.width, cmd.x, cmd.y);
  if (!target || !target.owner || target.owner === p.id) {
    w.log.push(`${p.id} は (${cmd.x},${cmd.y}) を奪えなかった（相手の土地ではない）。`);
    return;
  }
  const victim = w.players[target.owner];
  if (!victim || victim.trust >= CONFIG.seizeBelowTrust) {
    w.log.push(`${p.id} は ${target.owner} の信用がまだ高く、土地を奪えなかった。`);
    return;
  }
  if (hasCityAt(w, cmd.x, cmd.y)) {
    w.log.push(`${p.id} は都市のあるマスは奪えない。`);
    return;
  }
  const adjacent = neighbors(cmd.x, cmd.y, w.width, w.height).some((n) => {
    const nt = tileAt(w.tiles, w.width, n.x, n.y);
    return nt && nt.owner === p.id;
  });
  if (!adjacent) {
    w.log.push(`${p.id} は自分の領土に隣接していない土地は奪えない。`);
    return;
  }

  const owned = w.tiles.filter((t) => t.owner === p.id).length;
  const cost = seizeCostFor(owned);
  if (totalStock(p.stock) < cost) {
    w.log.push(`${p.id} は資源が足りず土地を奪えなかった（要 合計${cost}）。`);
    return;
  }

  payAny(p.stock, cost);
  target.owner = p.id;
  w.log.push(
    `【奪取】${p.id} が信用の低い ${victim.id}（信用${victim.trust}）から (${cmd.x},${cmd.y}) を奪った。`,
  );
}

// --------------------------------------------------------- 5. 信用の回復

function recoverTrust(w: World) {
  for (const p of Object.values(w.players)) {
    // 時間が経てば少しずつ許される。ただし回復は遅いので、
    // 一度の破棄で数十ターン取引できなくなる。これが「前科」の重み。
    p.trust += CONFIG.trustRecoverPerTurn;
    p.trust = Math.round(
      Math.max(CONFIG.trustMin, Math.min(CONFIG.trustMax, p.trust)) * 10,
    ) / 10;
  }
}

// ------------------------------------------------------------ 補助

function clampAllStocks(w: World) {
  for (const p of Object.values(w.players)) {
    const totalLevel = p.cities.reduce((s, c) => s + c.level, 0);
    const cap = CONFIG.storageBase + CONFIG.storagePerCityLevel * totalLevel;
    for (const r of RESOURCES) {
      p.stock[r] = Math.max(0, Math.min(cap, Math.round(p.stock[r])));
    }
  }
}

/**
 * 都市を targetLevel にするのに必要な資源。
 * レベルが上がるほど高くなるので、自給自足ではいずれ必ず頭打ちになる。
 */
export function buildCostFor(targetLevel: number, trust = 100): Stock {
  const penalty =
    trust < CONFIG.tradeBlockedBelow ? CONFIG.lowTrustBuildCostRate : 1;
  const n = Math.round(CONFIG.buildCostBase * targetLevel * penalty);
  return { food: n, material: n, knowledge: n };
}

/** 領土が広いほど開拓は高くつく。無限拡張を防ぐ。 */
export function expandCostTotal(ownedTiles: number): number {
  return CONFIG.expandCostBase + CONFIG.expandCostPerTile * ownedTiles;
}

/** 強制的に奪う（seize）ときのコスト。開拓コストの割増し版。 */
export function seizeCostFor(ownedTiles: number): number {
  return Math.round(expandCostTotal(ownedTiles) * CONFIG.seizeCostMultiplier);
}

/** 手持ち資源の合計。 */
export function totalStock(s: Stock): number {
  return s.food + s.material + s.knowledge;
}

/** 余っている資源から順に、合計 amount ぶん差し引く。 */
function payAny(stock: Stock, amount: number) {
  let left = amount;
  const order = RESOURCES.slice().sort((a, b) => stock[b] - stock[a]);
  for (const r of order) {
    const take = Math.min(stock[r], left);
    stock[r] -= take;
    left -= take;
    if (left <= 0) break;
  }
}

/** 2人の首都どうしのマス距離。交易できるかの判定に使う。 */
export function capitalDistance(
  w: World,
  a: string,
  b: string,
): number | null {
  const pa = w.players[a]?.cities[0];
  const pb = w.players[b]?.cities[0];
  if (!pa || !pb) return null;
  return Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
}

/** 一番足りていない資源を返す。ボットの判断にも使う。 */
export function scarcestResource(stock: Stock): Resource {
  return RESOURCES.slice().sort((a, b) => stock[a] - stock[b])[0];
}

/** 一番余っている資源。 */
export function surplusResource(stock: Stock): Resource {
  return RESOURCES.slice().sort((a, b) => stock[b] - stock[a])[0];
}

/** 得点。都市レベルの合計を主軸に、領土を少し足す。 */
export function score(w: World, playerId: string): number {
  const p = w.players[playerId];
  if (!p) return 0;
  const levels = p.cities.reduce((s, c) => s + c.level, 0);
  const land = w.tiles.filter((t) => t.owner === playerId).length;
  return levels * 10 + land;
}
