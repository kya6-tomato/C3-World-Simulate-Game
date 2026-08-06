// 世界の状態をあらわす型（データの形）の定義。
// ここには「処理」は一切書かない。データがどんな形をしているかだけ。

/** 資源は3種類。食料・資材・知識。 */
export type Resource = "food" | "material" | "knowledge";

/** マス目の種類。資源3種 + 荒地（何も採れない） + 川（何も採れず、越えて開拓もできない）。 */
export type TileKind = Resource | "waste" | "river";

/** 地図の1マス。 */
export interface Tile {
  x: number;
  y: number;
  kind: TileKind;
  /** そのマスを所有しているプレイヤーID。誰のものでもなければ null。 */
  owner: string | null;
}

/** 手持ちの資源。 */
export interface Stock {
  food: number;
  material: number;
  knowledge: number;
}

/** 都市。levelが高いほど生産も消費も増える。 */
export interface City {
  x: number;
  y: number;
  level: number;
}

export interface Player {
  id: string;
  cities: City[];
  stock: Stock;
  /** 信用度。契約を破ると下がる。0〜100。 */
  trust: number;
  /**
   * 常設命令。命令を出さなかったターンは自動的にこれが実行される。
   * 1日4ターンあるので、毎回人間が入力するのは現実的でない。
   * 「放っておいても最低限は進む」ようにするための仕組み。
   */
  standing: "expand" | "build" | "pass";
}

/** 契約の状態。 */
export type ContractStatus =
  | "proposed"   // 提示したがまだ相手が承諾していない
  | "active"     // 発効中。毎ターン自動で資源が動く
  | "broken"     // 意図的に破棄された
  | "defaulted"  // 資源不足で払えなかった
  | "expired";   // 期間満了で正常終了

/**
 * 契約。「fromがgiveを渡し、見返りにtakeを受け取る」を turnsLeft ターン続ける。
 */
export interface Contract {
  id: string;
  from: string;
  to: string;
  give: Resource;
  giveAmount: number;
  take: Resource;
  takeAmount: number;
  turnsLeft: number;
  /** 提案が出されたターン。期限切れ判定に使う。 */
  proposedAt: number;
  status: ContractStatus;
}

/** 土地のやり取りの状態。 */
export type LandOfferStatus =
  | "proposed"  // 提示したがまだ相手が承諾していない
  | "accepted"  // 承諾されて、土地が実際に移動した
  | "expired"   // 返事のないまま期限切れ
  | "invalid";  // 承諾はされたが、その時点で条件が崩れていて不成立だった

/**
 * 土地のやり取り。「from が (x,y) のマスを渡し、代わりに資源をもらう」という一回きりの提案。
 * 資源の契約と違って毎ターン続くものではなく、承諾された瞬間に1回だけ処理される。
 */
export interface LandOffer {
  id: string;
  from: string;
  to: string;
  x: number;
  y: number;
  wantResource: Resource;
  wantAmount: number;
  proposedAt: number;
  status: LandOfferStatus;
}

/** 世界まるごと。このオブジェクトがそのまま state.json になる。 */
export interface World {
  turn: number;
  width: number;
  height: number;
  tiles: Tile[];
  players: Record<string, Player>;
  contracts: Contract[];
  landOffers: LandOffer[];
  /** そのターンに起きたことの記録。 */
  log: string[];
}

/** プレイヤーが1ターンに1つだけ出せる命令。 */
export type Command =
  | { type: "expand"; player: string }
  | { type: "build"; player: string }
  | {
      type: "offer";
      player: string;
      to: string;
      give: Resource;
      giveAmount: number;
      take: Resource;
      takeAmount: number;
      turns: number;
    }
  | { type: "accept"; player: string; contractId: string }
  | { type: "break"; player: string; contractId: string }
  | {
      /** 自分が持つ (x,y) のマスを、相手に資源と引き換えに譲る提案。手番は消費しない。 */
      type: "offerLand";
      player: string;
      to: string;
      x: number;
      y: number;
      wantResource: Resource;
      wantAmount: number;
    }
  | { type: "acceptLand"; player: string; landOfferId: string }
  | {
      /** 信用が著しく低い隣人から、隣接するマスを1つ強制的に奪う。手番を消費する。 */
      type: "seize";
      player: string;
      x: number;
      y: number;
    }
  | { type: "pass"; player: string };

export const RESOURCES: Resource[] = ["food", "material", "knowledge"];

/** 資源名を日本語にする。表示用。 */
export const RESOURCE_JA: Record<Resource, string> = {
  food: "食料",
  material: "資材",
  knowledge: "知識",
};
