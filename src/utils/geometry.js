export const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
export const rand    = (a, b) => Math.random() * (b - a) + a;

// генерим фигуру
export function randomBlob(cx, cy, r, n, angJit = 0.25, radJit = 0.2) {
  const step = (Math.PI * 2) / n;
  const angs = Array.from({ length: n }, (_, i) => i * step + rand(-angJit, angJit) * step).sort((a,b) => a-b);
  return angs.map(a => {
    const rr = r * (1 + rand(-radJit, radJit));
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
  });
}

export const toPointsAttr = (pts) => pts.map(([x,y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

// превью для буферки
export function makePreviewPolygonData() {
  const n = randInt(3, 10);
  const pts = randomBlob(50, 35, 28, n, 0.2, 0.18);
  return { n, viewBox:'0 0 100 70', points: toPointsAttr(pts), fill:'#bf175aff', stroke:'#8b1747ff' };
}
