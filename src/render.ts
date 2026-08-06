import type { World, TileKind } from "./types.ts";

/**
 * 世界をSVG画像（文字列）にする。
 * 出来上がったファイルをREADMEに貼れば、リポジトリのトップに地図が出る。
 */

const TILE = 18;
const PAD = 20;

const FILL: Record<TileKind, string> = {
  food: "#C0DD97",
  material: "#FAC775",
  knowledge: "#CECBF6",
  waste: "#E2E0D8",
  river: "#8FB8D9",
};

// 人数分に近いほど見分けやすくなるので、できるだけ多くの色を用意する。
const PLAYER_COLORS = [
  "#D85A30", "#185FA5", "#0F6E56", "#993556", "#854F0B", "#534AB7",
  "#B0473C", "#2E7D8C", "#6B8E23", "#C2185B", "#5D4037", "#7B1FA2",
  "#E07B39", "#37474F", "#9C7C38",
];

export function renderMapSvg(w: World): string {
  const mapW = w.width * TILE;
  const mapH = w.height * TILE;
  const legendW = 230;
  const svgW = PAD * 2 + mapW + legendW;
  const svgH = PAD * 2 + mapH + 30;

  const ids = Object.keys(w.players);
  const colorOf = (id: string) =>
    PLAYER_COLORS[ids.indexOf(id) % PLAYER_COLORS.length];

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" font-family="Hiragino Sans, Noto Sans JP, Yu Gothic, Meiryo, sans-serif">`,
    `<rect width="${svgW}" height="${svgH}" fill="#FBFAF7"/>`,
    `<text x="${PAD}" y="${PAD + 14}" font-size="15" font-weight="500" fill="#3D3D3A">Turn ${w.turn}</text>`,
  );

  const top = PAD + 30;

  // マス目
  for (const t of w.tiles) {
    const x = PAD + t.x * TILE;
    const y = top + t.y * TILE;
    parts.push(
      `<rect x="${x}" y="${y}" width="${TILE}" height="${TILE}" fill="${FILL[t.kind]}" stroke="#FBFAF7" stroke-width="0.8"/>`,
    );
    if (t.owner) {
      // 所有者の色で細い枠を描く
      parts.push(
        `<rect x="${x + 1.5}" y="${y + 1.5}" width="${TILE - 3}" height="${TILE - 3}" fill="none" stroke="${colorOf(t.owner)}" stroke-width="1.5" opacity="0.85"/>`,
      );
    }
  }

  // 契約の線（都市どうしを結ぶ）
  const cityPos = (id: string) => {
    const p = w.players[id];
    if (!p || p.cities.length === 0) return null;
    const c = p.cities[0];
    return { x: PAD + c.x * TILE + TILE / 2, y: top + c.y * TILE + TILE / 2 };
  };

  for (const c of w.contracts) {
    if (c.status !== "active" && c.status !== "broken") continue;
    const a = cityPos(c.from);
    const b = cityPos(c.to);
    if (!a || !b) continue;
    const style =
      c.status === "active"
        ? `stroke="#1D9E75" stroke-width="1.8"`
        : `stroke="#E24B4A" stroke-width="1.4" stroke-dasharray="4 3"`;
    parts.push(
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${style} stroke-linecap="round" opacity="0.9"/>`,
    );
  }

  // 都市。色だけだと人数分見分けがつかないので、IDも小さく添える。
  for (const p of Object.values(w.players)) {
    for (const c of p.cities) {
      const cx = PAD + c.x * TILE + TILE / 2;
      const cy = top + c.y * TILE + TILE / 2;
      parts.push(
        `<circle cx="${cx}" cy="${cy}" r="7" fill="${colorOf(p.id)}" stroke="#FBFAF7" stroke-width="2"/>`,
        `<text x="${cx}" y="${cy + 3}" font-size="9" font-weight="500" fill="#FFFFFF" text-anchor="middle">${c.level}</text>`,
        `<rect x="${cx - 12}" y="${cy + 9}" width="24" height="10" fill="#FBFAF7" opacity="0.9" rx="2"/>`,
        `<text x="${cx}" y="${cy + 17}" font-size="7.5" font-weight="700" fill="${colorOf(p.id)}" text-anchor="middle">${p.id}</text>`,
      );
    }
  }

  // 凡例
  const lx = PAD + mapW + 24;
  let ly = top + 14;
  const legend: [string, string][] = [
    [FILL.food, "食料"],
    [FILL.material, "資材"],
    [FILL.knowledge, "知識"],
    [FILL.waste, "荒地"],
    [FILL.river, "川"],
  ];
  for (const [color, label] of legend) {
    parts.push(
      `<rect x="${lx}" y="${ly - 11}" width="14" height="14" fill="${color}" rx="3"/>`,
      `<text x="${lx + 22}" y="${ly}" font-size="13" fill="#3D3D3A">${label}</text>`,
    );
    ly += 24;
  }
  ly += 12;

  // 人数が多いので上位のみ表示する
  const ranked = ids
    .map((id) => ({
      id,
      land: w.tiles.filter((t) => t.owner === id).length,
      lv: w.players[id].cities.reduce((s, c) => s + c.level, 0),
      trust: w.players[id].trust,
    }))
    .sort((a, b) => b.lv * 10 + b.land - (a.lv * 10 + a.land))
    .slice(0, 8);
  parts.push(
    `<text x="${lx}" y="${ly}" font-size="13" font-weight="500" fill="#3D3D3A">上位プレイヤー</text>`,
  );
  ly += 22;
  for (const r of ranked) {
    parts.push(
      `<circle cx="${lx + 6}" cy="${ly - 4}" r="6" fill="${colorOf(r.id)}"/>`,
      `<text x="${lx + 20}" y="${ly}" font-size="12" fill="#3D3D3A">${r.id} · Lv${r.lv} · 領土${r.land} · 信用${r.trust}</text>`,
    );
    ly += 20;
  }

  parts.push("</svg>");
  return parts.join("\n");
}
