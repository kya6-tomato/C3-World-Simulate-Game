import type { World, Tile, TileKind } from "./types.ts";

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

// 各資源を少し濃くした色。グラデーションの下端・境界線・アイコンに使う。
const DEEP: Record<TileKind, string> = {
  food: "#93B96A",
  material: "#D9A24E",
  knowledge: "#A79FDB",
  waste: "#C7C3B8",
  river: "#5E90BE",
};

// 人数分に近いほど見分けやすくなるので、できるだけ多くの色を用意する。
const PLAYER_COLORS = [
  "#D85A30", "#185FA5", "#0F6E56", "#993556", "#854F0B", "#534AB7",
  "#B0473C", "#2E7D8C", "#6B8E23", "#C2185B", "#5D4037", "#7B1FA2",
  "#E07B39", "#37474F", "#9C7C38",
];

/** (x, y) から 0〜1 の疑似乱数を作る。毎回同じ入力なら必ず同じ値になる（世界を再描画しても地図がちらつかない）。 */
function hash(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2654435761) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

export function renderMapSvg(w: World): string {
  const mapW = w.width * TILE;
  const mapH = w.height * TILE;
  const legendW = 230;
  const svgW = PAD * 2 + mapW + legendW;
  const svgH = PAD * 2 + mapH + 30;
  const top = PAD + 30;

  const ids = Object.keys(w.players);
  const colorOf = (id: string) =>
    PLAYER_COLORS[ids.indexOf(id) % PLAYER_COLORS.length];

  const grid: (Tile | undefined)[][] = Array.from({ length: w.height }, () => []);
  for (const t of w.tiles) grid[t.y][t.x] = t;
  const kindAt = (x: number, y: number): TileKind | null => {
    if (x < 0 || y < 0 || x >= w.width || y >= w.height) return null;
    return grid[y][x]?.kind ?? null;
  };
  const cityTileAt = new Set<string>();
  for (const p of Object.values(w.players)) {
    for (const c of p.cities) cityTileAt.add(`${c.x},${c.y}`);
  }

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" font-family="Hiragino Sans, Noto Sans JP, Yu Gothic, Meiryo, sans-serif">`,
  );

  // ------------------------------------------------------- 定義（グラデーション・影）
  parts.push("<defs>");
  parts.push(
    `<radialGradient id="bg" cx="50%" cy="40%" r="75%">` +
      `<stop offset="0%" stop-color="#FFFFFF"/>` +
      `<stop offset="100%" stop-color="#EDEAE0"/>` +
      `</radialGradient>`,
  );
  for (const kind of Object.keys(FILL) as TileKind[]) {
    parts.push(
      `<linearGradient id="fill-${kind}" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0%" stop-color="${FILL[kind]}"/>` +
        `<stop offset="100%" stop-color="${DEEP[kind]}"/>` +
        `</linearGradient>`,
    );
  }
  parts.push(
    `<filter id="cityShadow" x="-60%" y="-60%" width="220%" height="220%">` +
      `<feDropShadow dx="0" dy="1.2" stdDeviation="1.1" flood-color="#000000" flood-opacity="0.35"/>` +
      `</filter>`,
  );
  parts.push("</defs>");

  parts.push(
    `<rect width="${svgW}" height="${svgH}" fill="url(#bg)"/>`,
    `<text x="${PAD}" y="${PAD + 14}" font-size="15" font-weight="500" fill="#3D3D3A">Turn ${w.turn}</text>`,
  );

  // ------------------------------------------------------------- マス目
  for (const t of w.tiles) {
    const x = PAD + t.x * TILE;
    const y = top + t.y * TILE;
    // 同じ資源のマス同士は継ぎ目が見えないよう少しだけ重ねて塗る。
    // 隣が違う資源のときだけ、あとで自然な境界線を引く。
    parts.push(
      `<rect x="${x - 0.4}" y="${y - 0.4}" width="${TILE + 0.8}" height="${TILE + 0.8}" ` +
        `rx="1.5" fill="url(#fill-${t.kind})"/>`,
    );

    // まばらに資源のアイコンを置く（都市が建つマスは避ける）。
    if (t.kind !== "waste" && !cityTileAt.has(`${t.x},${t.y}`)) {
      const cx = x + TILE / 2;
      const cy = y + TILE / 2;
      const r = hash(t.x, t.y, 7);
      if (t.kind === "river") {
        if (r < 0.55) {
          const dx = (hash(t.x, t.y, 8) - 0.5) * 6;
          parts.push(
            `<path d="M ${cx - 5 + dx} ${cy} Q ${cx + dx} ${cy - 3} ${cx + 5 + dx} ${cy}" ` +
              `stroke="#FFFFFF" stroke-width="1" fill="none" opacity="0.55" stroke-linecap="round"/>`,
          );
        }
      } else if (r < 0.22) {
        const jx = cx + (hash(t.x, t.y, 9) - 0.5) * 8;
        const jy = cy + (hash(t.x, t.y, 10) - 0.5) * 8;
        if (t.kind === "food") {
          parts.push(`<circle cx="${jx}" cy="${jy}" r="1.3" fill="${DEEP.food}" opacity="0.6"/>`);
        } else if (t.kind === "material") {
          parts.push(
            `<rect x="${jx - 1.4}" y="${jy - 1.4}" width="2.8" height="2.8" fill="${DEEP.material}" ` +
              `opacity="0.6" transform="rotate(45 ${jx} ${jy})"/>`,
          );
        } else if (t.kind === "knowledge") {
          parts.push(
            `<line x1="${jx - 1.6}" y1="${jy}" x2="${jx + 1.6}" y2="${jy}" ` +
              `stroke="${DEEP.knowledge}" stroke-width="1.2" opacity="0.6" stroke-linecap="round"/>`,
          );
        }
      }
    }

    // 自然な境界線: 右隣・下隣が違う資源のときだけ、少し揺らした線を引く。
    const rightKind = kindAt(t.x + 1, t.y);
    if (rightKind !== null && rightKind !== t.kind) {
      const ex = x + TILE;
      const jitter = (hash(t.x, t.y, 1) - 0.5) * 5;
      parts.push(
        `<path d="M ${ex} ${y} Q ${ex + jitter} ${y + TILE / 2} ${ex} ${y + TILE}" ` +
          `stroke="#3D3D3A" stroke-width="0.6" fill="none" opacity="0.18"/>`,
      );
    }
    const downKind = kindAt(t.x, t.y + 1);
    if (downKind !== null && downKind !== t.kind) {
      const ey = y + TILE;
      const jitter = (hash(t.x, t.y, 2) - 0.5) * 5;
      parts.push(
        `<path d="M ${x} ${ey} Q ${x + TILE / 2} ${ey + jitter} ${x + TILE} ${ey}" ` +
          `stroke="#3D3D3A" stroke-width="0.6" fill="none" opacity="0.18"/>`,
      );
    }

    if (t.owner) {
      // 所有者の色で細い枠を描く
      parts.push(
        `<rect x="${x + 1.5}" y="${y + 1.5}" width="${TILE - 3}" height="${TILE - 3}" rx="1" ` +
          `fill="none" stroke="${colorOf(t.owner)}" stroke-width="1.5" opacity="0.85"/>`,
      );
    }
  }

  // 地図全体のふちを軽く落とす（ページの中に収まっている感じを出す）
  parts.push(
    `<rect x="${PAD}" y="${top}" width="${mapW}" height="${mapH}" fill="none" ` +
      `stroke="#3D3D3A" stroke-width="1" opacity="0.12" rx="2"/>`,
  );

  // ------------------------------------------------ 契約の線（都市どうしを結ぶ）
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

  // -------------------------------------------------------------- 都市
  // ピン（旗）のような形にして、地図上の目印らしくする。色だけでは
  // 人数分の見分けがつかないので、IDも小さく添える。
  for (const p of Object.values(w.players)) {
    for (const c of p.cities) {
      const cx = PAD + c.x * TILE + TILE / 2;
      const cy = top + c.y * TILE + TILE / 2;
      const headY = cy - 6;
      const color = colorOf(p.id);
      parts.push(`<g filter="url(#cityShadow)">`);
      parts.push(
        `<path d="M ${cx - 5} ${headY} L ${cx + 5} ${headY} L ${cx} ${cy} Z" fill="${color}"/>`,
        `<circle cx="${cx}" cy="${headY}" r="7" fill="${color}" stroke="#FBFAF7" stroke-width="1.6"/>`,
      );
      parts.push(`</g>`);
      parts.push(
        `<text x="${cx}" y="${headY + 3}" font-size="9" font-weight="500" fill="#FFFFFF" text-anchor="middle">${c.level}</text>`,
        `<rect x="${cx - 12}" y="${cy + 2}" width="24" height="10" fill="#FBFAF7" opacity="0.9" rx="2"/>`,
        `<text x="${cx}" y="${cy + 10}" font-size="7.5" font-weight="700" fill="${color}" text-anchor="middle">${p.id}</text>`,
      );
    }
  }

  // ------------------------------------------------------------ 凡例
  const lx = PAD + mapW + 24;
  let ly = top + 14;
  const legend: [TileKind, string][] = [
    ["food", "食料"],
    ["material", "資材"],
    ["knowledge", "知識"],
    ["waste", "荒地"],
    ["river", "川"],
  ];
  for (const [kind, label] of legend) {
    parts.push(
      `<rect x="${lx}" y="${ly - 11}" width="14" height="14" fill="url(#fill-${kind})" rx="3"/>`,
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
