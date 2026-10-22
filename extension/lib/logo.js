// Company logos are stored inside the job as a small image (data: URL, 64 px).
// The board then never loads anything from the internet, and the logo cannot
// expire the way signed CDN links do.

const SIZE = 64;

export function isLogo(value) {
  return typeof value === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(value) && value.length < 200000;
}

function draw(source, crop) {
  const w = crop ? crop.w : source.width || source.naturalWidth;
  const h = crop ? crop.h : source.height || source.naturalHeight;
  if (!w || !h) return '';
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const k = Math.min(SIZE / w, SIZE / h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, crop ? crop.x : 0, crop ? crop.y : 0, w, h, (SIZE - w * k) / 2, (SIZE - h * k) / 2, w * k, h * k);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  let opaque = 0;
  let lo = 765;
  let hi = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 16) continue;
    opaque += 1;
    const v = px[i] + px[i + 1] + px[i + 2];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (opaque < 40 || (opaque === SIZE * SIZE && hi - lo < 24)) return '';
  return canvas.toDataURL('image/png');
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

// File, clipboard image or downloaded blob -> stored logo ('' if it is not an image)
export async function imageToLogo(blob) {
  if (!blob || blob.size < 40 || blob.size > 8000000) return '';
  try {
    let source;
    try { source = await createImageBitmap(blob); } catch { source = await loadImage(blob); }
    return draw(source);
  } catch {
    return '';
  }
}

// From an extension page. Works for sites the extension may access, and for
// image servers that allow it.
export async function fetchLogo(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) return '';
    return await imageToLogo(await res.blob());
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// Last resort: cut the logo out of a screenshot of the visible tab. Needs the
// permission you give by clicking the toolbar icon on that tab.
export async function captureLogo(windowId, rect) {
  if (!rect || !chrome.tabs || !chrome.tabs.captureVisibleTab) return '';
  try {
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const img = await loadImage(await (await fetch(shot)).blob());
    const k = img.naturalWidth / rect.vw;
    const pad = 1;
    return draw(img, { x: (rect.x + pad) * k, y: (rect.y + pad) * k, w: (rect.w - 2 * pad) * k, h: (rect.h - 2 * pad) * k });
  } catch {
    return '';
  }
}
