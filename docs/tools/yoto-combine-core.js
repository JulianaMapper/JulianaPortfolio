/*
 * yoto-combine-core.js: the parts of the Combine Tracks tool that don't touch
 * the page or Yoto, so they can be tested in node.
 *
 *   parseMp3(bytes)        -> where the audio frames are, how long, what format
 *   planCards(items, lim)  -> which files become which track on which card
 *   cleanTitle / naturalCompare / defaultCardTitle
 *
 * Plain script, no build step. Exposes window.YotoCombine (or module.exports).
 */
(function (root) {
  'use strict';

  // Yoto's Make Your Own limits (support.yotoplay.com, "How much audio fits on
  // a Make Your Own card", July 2026): 100 tracks, 100 MB or 60 minutes per
  // track, 500 MB or 5 hours per card. We stay a little under each one.
  const LIMITS = {
    maxTracks: 100,
    maxTrackSec: 59.5 * 60,
    maxTrackBytes: 95 * 1000 * 1000,
    maxCardSec: 4 * 3600 + 58 * 60
  };

  // ───────── MP3 frames ─────────
  const BR = {
    '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  };
  BR['2-3'] = BR['2-2'];
  const SR = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

  // The 4-byte MPEG audio frame header at i, or null.
  function frameAt(u8, i) {
    if (i + 4 > u8.length) return null;
    const b1 = u8[i + 1], b2 = u8[i + 2], b3 = u8[i + 3];
    if (u8[i] !== 0xFF || (b1 & 0xE0) !== 0xE0) return null;
    const vBits = (b1 >> 3) & 3, lBits = (b1 >> 1) & 3;
    if (vBits === 1 || lBits === 0) return null;
    const ver = vBits === 3 ? 1 : (vBits === 2 ? 2 : 25);
    const layer = 4 - lBits;
    const bi = b2 >> 4, si = (b2 >> 2) & 3, pad = (b2 >> 1) & 1;
    if (bi === 0 || bi === 15 || si === 3) return null;
    const kbps = BR[(ver === 1 ? 1 : 2) + '-' + layer][bi];
    const sr = SR[ver][si];
    let len, spf;
    if (layer === 1) { len = (Math.floor(12000 * kbps / sr) + pad) * 4; spf = 384; }
    else if (layer === 2 || ver === 1) { len = Math.floor(144000 * kbps / sr) + pad; spf = 1152; }
    else { len = Math.floor(72000 * kbps / sr) + pad; spf = 576; }
    if (layer === 2) spf = 1152;
    const mono = (b3 >> 6) === 3;
    return { len, sr, spf, ver, layer, ch: mono ? 1 : 2, mono, kbps };
  }
  const sameStream = (a, b) => a && b && a.ver === b.ver && a.layer === b.layer && a.sr === b.sr;

  // A frame we trust: a header here AND a matching one right after it (or the file ends cleanly).
  function goodFrameAt(u8, i, like) {
    const f = frameAt(u8, i);
    if (!f || (like && !sameStream(f, like))) return null;
    if (i + f.len > u8.length) return null;
    if (i + f.len === u8.length) return f;
    const g = frameAt(u8, i + f.len);
    return sameStream(f, g) ? f : null;
  }

  // The first frame of an encoder's file often holds a Xing / Info / VBRI table
  // (length and seek points for THIS file). Joined, it would lie about the
  // whole, so we drop it. It carries no audio.
  function isInfoFrame(u8, i, f) {
    const side = f.ver === 1 ? (f.mono ? 17 : 32) : (f.mono ? 9 : 17);
    const tag = (o) => String.fromCharCode(u8[i + o], u8[i + o + 1], u8[i + o + 2], u8[i + o + 3]);
    if (i + 40 > u8.length) return false;
    const t = tag(4 + side);
    return t === 'Xing' || t === 'Info' || tag(36) === 'VBRI';
  }

  function skipId3v2(u8, i) {
    while (i + 10 <= u8.length && u8[i] === 0x49 && u8[i + 1] === 0x44 && u8[i + 2] === 0x33) {
      const size = ((u8[i + 6] & 0x7f) << 21) | ((u8[i + 7] & 0x7f) << 14) | ((u8[i + 8] & 0x7f) << 7) | (u8[i + 9] & 0x7f);
      i += 10 + size + ((u8[i + 5] & 0x10) ? 10 : 0);
    }
    return i;
  }

  // Where the audio is in an MP3 file. Tags (ID3v1/v2, APE, Lyrics3), the
  // Xing/Info frame and any junk between frames are left out, so the ranges
  // from several files can be laid end to end into one valid MP3.
  // -> { ok, ranges: [[start, end)], bytes, frames, duration, sr, ch, ver, layer, kbps }
  function parseMp3(u8) {
    const n = u8.length;
    let i = skipId3v2(u8, 0);
    let like = null, frames = 0, samples = 0, bytes = 0, kbpsSum = 0, chMax = 1;
    const ranges = [];
    let first = true;
    while (i < n) {
      // Find the next frame we trust.
      let f = goodFrameAt(u8, i, like);
      if (!f) {
        let j = i + 1;
        while (j < n && !(f = goodFrameAt(u8, j, like))) j++;
        if (!f) break;
        i = j;
      }
      if (!like) like = f;
      if (first) {
        first = false;
        if (isInfoFrame(u8, i, f)) { i += f.len; continue; }
      }
      // Take every frame from here that follows on cleanly.
      const start = i;
      while (i < n) {
        const g = frameAt(u8, i);
        if (!g || !sameStream(g, like) || i + g.len > n) break;
        frames++; samples += g.spf; kbpsSum += g.kbps; if (g.ch > chMax) chMax = g.ch;
        i += g.len;
      }
      if (i > start) { ranges.push([start, i]); bytes += i - start; }
      else i++;
    }
    if (!frames) return { ok: false };
    return {
      ok: bytes > n * 0.5, ranges, bytes, frames,
      duration: samples / like.sr, sr: like.sr, ch: chMax, ver: like.ver, layer: like.layer,
      kbps: Math.round(kbpsSum / frames)
    };
  }

  // ───────── Names ─────────
  const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
  const naturalCompare = (a, b) => collator ? collator.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0);

  function cleanTitle(fileName) {
    let t = String(fileName || '').split('/').pop().replace(/\.[a-z0-9]{2,5}$/i, '');
    t = t.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const stripped = t.replace(/^\d{1,4}\s*[-.)\]:]\s*/, '').replace(/^\d{1,4}\s+(?=\D)/, '').trim();
    return stripped || t || 'Track';
  }

  // Folder name if the files came from a folder, else what all the titles start with.
  function defaultCardTitle(paths) {
    const firstDir = (p) => { const s = String(p || '').split('/'); return s.length > 1 ? s[0] : ''; };
    const dirs = Array.from(new Set(paths.map(firstDir)));
    if (dirs.length === 1 && dirs[0]) return dirs[0];
    const names = paths.map(cleanTitle);
    if (!names.length) return '';
    let pre = names[0];
    for (const nm of names) { let k = 0; while (k < pre.length && k < nm.length && pre[k].toLowerCase() === nm[k].toLowerCase()) k++; pre = pre.slice(0, k); }
    pre = pre.replace(/[\s\-_.:,(]*(chapter|part|track|ch|pt|disc|cd)?\s*\d*\s*$/i, '').trim();
    return pre.length >= 3 ? pre : '';
  }

  const clip = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
  function trackTitle(titles) {
    if (titles.length === 1) return clip(titles[0], 100);
    if (titles.length === 2) return clip(titles[0] + ' / ' + titles[1], 100);
    return clip(titles[0], 48) + ' … ' + clip(titles[titles.length - 1], 48);
  }

  // ───────── Planning ─────────
  // items: [{ title, duration (s), bytes, mp3: parseMp3 result or null }] in play order.
  // -> { cards: [{ tracks: [{ items:[index], title, duration, bytes, mode, kbps, ch }] }], tooLong: [index] }
  // mode: 'as-is' (upload the file untouched), 'join' (lay MP3 frames end to end),
  //       'encode' (decode and re-encode, at a lower quality when it has to fit 100 MB).
  function planCards(items, lim) {
    lim = Object.assign({}, LIMITS, lim || {});
    const tooLong = [];
    items.forEach((it, i) => { if (!(it.duration > 0) || it.duration > lim.maxTrackSec) tooLong.push(i); });
    if (tooLong.length || !items.length) return { cards: [], tooLong };

    const total = items.reduce((a, it) => a + it.duration, 0);
    for (let C = Math.max(1, Math.ceil(total / lim.maxCardSec)); C <= items.length; C++) {
      const chunks = splitBalanced(items, C, total);
      if (chunks.some((ch) => sumDur(items, ch) > lim.maxCardSec)) continue;
      const cards = [];
      let ok = true;
      for (const ch of chunks) {
        const tracks = mergeToFit(items, ch, lim);
        if (!tracks) { ok = false; break; }
        cards.push({ tracks: tracks.map((ix) => describe(items, ix, lim)) });
      }
      if (ok) return { cards, tooLong };
    }
    return { cards: [], tooLong };
  }

  const sumDur = (items, ix) => ix.reduce((a, i) => a + items[i].duration, 0);

  // C runs of consecutive files, cut where the running length crosses each k/C of the total.
  function splitBalanced(items, C, total) {
    const chunks = [];
    let cur = [], acc = 0, k = 1;
    items.forEach((it, i) => {
      const left = items.length - i;
      const cardsLeft = C - chunks.length;
      if (cur.length && chunks.length < C - 1 && (acc + it.duration / 2 > (total * k) / C || left < cardsLeft)) {
        chunks.push(cur); cur = []; k++;
      }
      cur.push(i); acc += it.duration;
    });
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  // Group the files into exactly min(files, 100) tracks, in order, so track
  // lengths come out as even as possible (least sum of squared lengths). Long
  // files stay alone and short ones pair up. Ties (equal files) are broken by
  // keeping each cut near where an even split would put it, so 150 equal
  // chapters become pair, single, pair, single… rather than 50 pairs then 50 singles.
  function mergeToFit(items, chunk, lim) {
    const N = chunk.length, K = Math.min(N, lim.maxTracks);
    if (K === N) return chunk.map((i) => [i]);
    const S = new Float64Array(N + 1);
    let longest = 0;
    for (let j = 0; j < N; j++) { const d = items[chunk[j]].duration; S[j + 1] = S[j] + d; if (d > longest) longest = d; }
    const T = S[N], avg = T / K;
    // A track far longer than average is never the even answer; capping it keeps this fast.
    const cap = Math.min(lim.maxTrackSec, Math.max(3 * avg, longest + avg));
    const TIE = 1e-3;
    let prev = new Float64Array(N + 1).fill(Infinity); prev[0] = 0;
    const back = [];
    for (let g = 1; g <= K; g++) {
      const cur = new Float64Array(N + 1).fill(Infinity);
      const from = new Int32Array(N + 1).fill(-1);
      const ideal = (T * g) / K;
      // Group g ends at file j: room for g-1 groups before it, K-g after it.
      for (let j = g; j <= N - (K - g); j++) {
        const dev = (S[j] - ideal) * (S[j] - ideal) * TIE;
        let best = Infinity, arg = -1;
        for (let i = j - 1; i >= g - 1; i--) {
          const d = S[j] - S[i];
          if (d > cap && i < j - 1) break;
          if (d > lim.maxTrackSec) break;
          if (prev[i] === Infinity) continue;
          const c = prev[i] + d * d + dev;
          if (c < best) { best = c; arg = i; }
        }
        cur[j] = best; from[j] = arg;
      }
      back.push(from); prev = cur;
    }
    if (prev[N] === Infinity) return null;
    const tracks = [];
    for (let g = K, j = N; g >= 1; g--) {
      const i = back[g - 1][j];
      tracks.unshift(chunk.slice(i, j));
      j = i;
    }
    return tracks;
  }

  const KBPS = [128, 112, 96, 80, 64, 56, 48, 40, 32];
  function describe(items, ix, lim) {
    const its = ix.map((i) => items[i]);
    const duration = sumDur(items, ix);
    const ch = its.reduce((m, it) => Math.max(m, (it.mp3 && it.mp3.ch) || 2), 1);
    const title = trackTitle(its.map((it) => it.title));
    const allMp3 = its.every((it) => it.mp3 && it.mp3.ok);
    const sameFmt = allMp3 && its.every((it) => it.mp3.sr === its[0].mp3.sr && it.mp3.ch === its[0].mp3.ch && it.mp3.layer === its[0].mp3.layer);
    let mode, bytes, kbps = 0;
    if (ix.length === 1 && its[0].bytes <= lim.maxTrackBytes) { mode = 'as-is'; bytes = its[0].bytes; }
    else if (ix.length > 1 && sameFmt && its.reduce((a, it) => a + it.mp3.bytes, 0) <= lim.maxTrackBytes) {
      mode = 'join'; bytes = its.reduce((a, it) => a + it.mp3.bytes, 0);
    } else {
      // Yoto turns every upload into mono (Opus, ~40-70 kbps), so a mono MP3 at
      // 96 kbps loses nothing a listener would get anyway, at half the size.
      mode = 'encode';
      kbps = KBPS.find((k) => k <= 96 && duration * k * 125 <= lim.maxTrackBytes) || 32;
      bytes = Math.round(duration * kbps * 125);
    }
    return { items: ix, title, duration, bytes, mode, kbps, ch: mode === 'encode' ? 1 : ch };
  }

  const api = { LIMITS, parseMp3, planCards, cleanTitle, naturalCompare, defaultCardTitle, trackTitle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YotoCombine = api;
})(typeof window !== 'undefined' ? window : globalThis);
