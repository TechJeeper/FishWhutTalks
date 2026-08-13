(() => {
  const els = {
    url: document.getElementById("ytUrl"),
    loadBtn: document.getElementById("loadBtn"),
    redBtn: document.getElementById("redBtn"),
    plaqueWrap: document.getElementById("plaqueWrap"),
    billyFrame: document.getElementById("billyFrame"),
    speech: document.getElementById("speech"),
    speechText: document.getElementById("speechText"),
    status: document.getElementById("status"),
    meta: document.getElementById("meta"),
    capStatus: document.getElementById("capStatus"),
    wordCount: document.getElementById("wordCount"),
    playerHint: document.getElementById("playerHint"),
  };

  let player = null;
  let videoId = null;
  let cues = []; // { start, end, text, words: [{ start, end, text }] }
  let words = [];
  let animFrame = null;
  let ytReady = false;
  let pendingVideoId = null;

  /** GIF flipbook — frames extracted from a real Billy Bass animation */
  const billy = {
    manifest: null,
    cache: new Map(),
    phase: "rest", // rest | turningOut | talking | turningIn
    seq: [],
    seqIdx: 0,
    lastStep: 0,
    chatter: 0,
  };

  function frameUrl(i) {
    return `assets/anim/f${String(i).padStart(3, "0")}.png`;
  }

  function showFrame(i) {
    els.billyFrame.src = frameUrl(i);
  }

  function preloadFrames(indices) {
    for (const i of indices) {
      if (billy.cache.has(i)) continue;
      const img = new Image();
      img.src = frameUrl(i);
      billy.cache.set(i, img);
    }
  }

  async function initBilly() {
    try {
      const res = await fetch("assets/anim/manifest.json");
      billy.manifest = await res.json();
      const m = billy.manifest;
      const all = new Set([
        m.rest,
        m.talkClosed,
        ...(m.turnOut || []),
        ...(m.turnIn || []),
        ...(m.talkCycle || []),
      ]);
      preloadFrames([...all]);
      showFrame(m.rest);
    } catch (err) {
      console.warn("Billy flipbook failed to load", err);
    }
  }

  function startTurnOut() {
    if (!billy.manifest) return;
    billy.phase = "turningOut";
    billy.seq = billy.manifest.turnOut.slice();
    billy.seqIdx = 0;
    billy.lastStep = 0;
    showFrame(billy.seq[0]);
  }

  function startTurnIn() {
    if (!billy.manifest) return;
    billy.phase = "turningIn";
    billy.seq = billy.manifest.turnIn.slice();
    billy.seqIdx = 0;
    billy.lastStep = 0;
    showFrame(billy.seq[0]);
  }

  function goRest() {
    billy.phase = "rest";
    billy.seq = [];
    if (billy.manifest) showFrame(billy.manifest.rest);
  }

  function goTalking() {
    billy.phase = "talking";
    billy.chatter = 0;
    if (billy.manifest) showFrame(billy.manifest.talkClosed);
  }

  function setStatus(msg) {
    els.status.textContent = msg;
  }

  function extractVideoId(input) {
    if (!input) return null;
    const trimmed = input.trim();
    if (/^[\w-]{11}$/.test(trimmed)) return trimmed;

    try {
      const url = new URL(trimmed);
      if (url.hostname.includes("youtu.be")) {
        return url.pathname.slice(1).split("/")[0] || null;
      }
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const shorts = url.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (shorts) return shorts[1];
    } catch {
      /* not a URL */
    }
    const loose = trimmed.match(/(?:v=|\/)([\w-]{11})(?:[&?/]|$)/);
    return loose ? loose[1] : null;
  }

  function decodeXml(text) {
    return text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function stripTags(html) {
    return decodeXml(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }

  function parseVttTime(t) {
    const parts = t.trim().split(":");
    let h = 0;
    let m = 0;
    let s = 0;
    if (parts.length === 3) {
      h = Number(parts[0]);
      m = Number(parts[1]);
      s = Number(parts[2]);
    } else {
      m = Number(parts[0]);
      s = Number(parts[1]);
    }
    return h * 3600 + m * 60 + s;
  }

  function parseVtt(vtt) {
    const blocks = vtt.replace(/\r/g, "").split(/\n\n+/);
    const out = [];
    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      if (!lines.length || lines[0].startsWith("WEBVTT")) continue;
      const timeLine = lines.find((l) => l.includes("-->"));
      if (!timeLine) continue;
      const [startRaw, endRaw] = timeLine.split("-->").map((x) => x.trim().split(" ")[0]);
      const start = parseVttTime(startRaw);
      const end = parseVttTime(endRaw);
      const text = stripTags(lines.filter((l) => l !== timeLine && !/^\d+$/.test(l)).join(" "));
      if (text) out.push({ start, end, text });
    }
    return out;
  }

  function parseSrv3(xml) {
    const out = [];
    const re = /<p[^>]*\bt="(\d+)"[^>]*(?:\bd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(xml))) {
      const start = Number(m[1]) / 1000;
      const dur = m[2] ? Number(m[2]) / 1000 : 2;
      const text = stripTags(m[3]);
      if (text) out.push({ start, end: start + dur, text });
    }
    return out;
  }

  function parseJson3(jsonText) {
    try {
      const data = JSON.parse(jsonText);
      const events = data.events || [];
      const out = [];
      for (const ev of events) {
        if (!ev.segs) continue;
        const start = (ev.tStartMs || 0) / 1000;
        const dur = (ev.dDurationMs || 2000) / 1000;
        const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim();
        if (text && text !== "\n") out.push({ start, end: start + dur, text });
      }
      return out;
    } catch {
      return [];
    }
  }

  function expandToWords(segments) {
    const result = [];
    for (const seg of segments) {
      const cleaned = cleanCaptionText(seg.text);
      const tokens = cleaned.split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const span = Math.max(seg.end - seg.start, 0.05);
      const weights = tokens.map((t) => Math.max(t.replace(/[^\w']/g, "").length, 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let t = seg.start;
      const wordsInSeg = [];
      tokens.forEach((token, i) => {
        const dur = (weights[i] / total) * span;
        const w = { start: t, end: t + dur, text: token };
        wordsInSeg.push(w);
        result.push(w);
        t += dur;
      });
      cues.push({ start: seg.start, end: seg.end, text: cleaned, words: wordsInSeg });
    }
    return result;
  }

  function parseClock(ts) {
    const parts = ts.split(":").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  }

  /** Parse youtube-transcript.ai markdown: [m:ss] / [h:mm:ss] paragraphs */
  function parseMarkdownTranscript(md) {
    const body = md.split(/^##\s*Transcript\s*$/im)[1] || md;
    const re = /\[(\d{1,2}:(?:\d{1,2}:)?\d{2})\]\s*([\s\S]*?)(?=\n\s*\[(?:\d{1,2}:(?:\d{1,2}:)?\d{2})\]|\n---|\n#|$)/g;
    const raw = [];
    let m;
    while ((m = re.exec(body))) {
      const start = parseClock(m[1]);
      if (start == null) continue;
      let text = m[2]
        .replace(/\n+/g, " ")
        .replace(/[♪\[\]]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      // Drop pure music markers
      if (!text || /^(\(ooh[^)]*\)|music|\[music\])$/i.test(text)) continue;
      raw.push({ start, text });
    }
    if (!raw.length) {
      // Fallback: line-based
      for (const line of body.split("\n")) {
        const lm = line.match(/^\[(\d{1,2}:(?:\d{1,2}:)?\d{2})\]\s*(.+)$/);
        if (!lm) continue;
        const start = parseClock(lm[1]);
        const text = lm[2].replace(/[♪]+/g, " ").replace(/\s+/g, " ").trim();
        if (start != null && text) raw.push({ start, text });
      }
    }
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const start = raw[i].start;
      const next = raw[i + 1]?.start;
      const wordsN = raw[i].text.split(/\s+/).length;
      const guessed = start + Math.max(1.2, wordsN * 0.38);
      const end = next != null ? Math.max(start + 0.4, Math.min(next, guessed + 8)) : guessed;
      out.push({ start, end, text: raw[i].text });
    }
    return out;
  }

  function metaFromMarkdown(md) {
    const lang = (md.match(/Language:\s*([^\s·]+)/i) || [])[1] || "en";
    const auto = /\[auto\]/i.test(md);
    return { lang, auto };
  }

  async function fetchTranscriptAi(id) {
    const urls = [
      `https://youtube-transcript.ai/transcript/${id}.txt?lang=en`,
      `https://youtube-transcript.ai/transcript/${id}.txt`,
    ];
    let lastErr;
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const md = await res.text();
        if (!md || md.length < 40) throw new Error("Empty transcript");
        if (/transcript unavailable|no captions|not found/i.test(md) && !/\[(\d{1,2}:)/.test(md)) {
          throw new Error("No captions in response");
        }
        const segs = parseMarkdownTranscript(md);
        if (!segs.length) throw new Error("Could not parse transcript");
        const meta = metaFromMarkdown(md);
        return { segs, meta, source: "youtube-transcript.ai" };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("transcript.ai failed");
  }

  async function fetchViaProxy(url) {
    const attempts = [
      async (u) => {
        // JSON wrapper usually sends CORS headers; /raw often does not on Pages
        const res = await fetch(
          `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
          { signal: AbortSignal.timeout(20000) }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const text = data.contents || "";
        if (!text || text.length < 5) throw new Error("Empty proxy body");
        if (/^\s*<!DOCTYPE html/i.test(text)) throw new Error("Proxy returned HTML");
        return text;
      },
      async (u) => {
        const res = await fetch(
          `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
          { signal: AbortSignal.timeout(20000) }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text || text.length < 5) throw new Error("Empty proxy body");
        if (/^\s*<!DOCTYPE html/i.test(text)) throw new Error("Proxy returned HTML");
        return text;
      },
    ];
    let lastErr;
    for (const run of attempts) {
      try {
        return await run(url);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Proxy fetch failed");
  }

  async function listCaptionTracks(id) {
    const xml = await fetchViaProxy(
      `https://www.youtube.com/api/timedtext?type=list&v=${id}`
    );
    const tracks = [];
    const re = /<track\b([^>]+)>/gi;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const get = (name) => {
        const a = attrs.match(new RegExp(`${name}="([^"]*)"`, "i"));
        return a ? a[1] : "";
      };
      tracks.push({
        lang: get("lang_code"),
        name: get("name"),
        kind: get("kind"),
      });
    }
    return tracks;
  }

  async function fetchCaptionBody(id, track) {
    const params = new URLSearchParams({ v: id, lang: track.lang || "en", fmt: "json3", c: "WEB" });
    if (track.name) params.set("name", decodeXml(track.name));
    if (track.kind === "asr") params.set("kind", "asr");

    const attempts = [
      { fmt: "json3", parse: parseJson3 },
      { fmt: "vtt", parse: parseVtt },
      { fmt: "srv3", parse: parseSrv3 },
    ];

    for (const attempt of attempts) {
      params.set("fmt", attempt.fmt);
      try {
        const body = await fetchViaProxy(
          `https://www.youtube.com/api/timedtext?${params.toString()}`
        );
        if (!body || body.length < 10) continue;
        const parsed = attempt.parse(body);
        if (parsed.length) return parsed;
      } catch {
        /* try next format */
      }
    }
    return [];
  }

  async function fetchTimedTextFallback(id) {
    let tracks = [];
    try {
      tracks = await listCaptionTracks(id);
    } catch {
      tracks = [];
    }
    if (!tracks.length) {
      tracks = [
        { lang: "en", name: "", kind: "asr" },
        { lang: "en", name: "", kind: "" },
      ];
    }
    const preferred = [
      ...tracks.filter((t) => (t.lang || "").startsWith("en") && t.kind !== "asr"),
      ...tracks.filter((t) => (t.lang || "").startsWith("en")),
      ...tracks,
    ];
    const seen = new Set();
    for (const track of preferred) {
      const key = `${track.lang}|${track.name}|${track.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const segs = await fetchCaptionBody(id, track);
      if (segs.length) {
        return {
          segs,
          meta: { lang: track.lang || "en", auto: track.kind === "asr" },
          source: "timedtext",
        };
      }
    }
    return null;
  }

  async function loadCaptions(id) {
    cues = [];
    words = [];
    setStatus("Fetching captions so Billy can mouth the words…");

    // 1) Public transcript API (CORS-friendly) — YouTube timedtext is often empty now
    try {
      const result = await fetchTranscriptAi(id);
      words = expandToWords(result.segs);
      return {
        ok: true,
        track: {
          lang: result.meta.lang,
          kind: result.meta.auto ? "asr" : "",
        },
        count: words.length,
        source: result.source,
      };
    } catch (err) {
      console.warn("transcript.ai failed", err);
    }

    // 2) Legacy timedtext via proxies
    try {
      const result = await fetchTimedTextFallback(id);
      if (result) {
        words = expandToWords(result.segs);
        return {
          ok: true,
          track: {
            lang: result.meta.lang,
            kind: result.meta.auto ? "asr" : "",
          },
          count: words.length,
          source: result.source,
        };
      }
    } catch (err) {
      console.warn("timedtext failed", err);
    }

    return { ok: false };
  }

  function applyEmbedReferrer() {
    try {
      const iframe = player && player.getIframe && player.getIframe();
      if (iframe) {
        iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
        iframe.referrerPolicy = "strict-origin-when-cross-origin";
      }
    } catch {
      /* ignore */
    }
  }

  function mountEmbedFrame(id) {
    const box = document.querySelector(".player-box");
    const old = document.getElementById("player");
    if (old) old.remove();

    const iframe = document.createElement("iframe");
    iframe.id = "player";
    iframe.src =
      `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` +
      `?enablejsapi=1&playsinline=1&rel=0&modestbranding=1`;
    iframe.title = "YouTube player";
    iframe.allow =
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.style.border = "0";
    iframe.width = "100%";
    iframe.height = "100%";
    box.insertBefore(iframe, els.playerHint);
    return iframe;
  }

  function createPlayer(id) {
    els.playerHint.classList.add("hidden");

    // Rebuild iframe with referrerpolicy before YouTube loads (fixes Error 153)
    if (player && typeof player.destroy === "function") {
      try {
        player.destroy();
      } catch {
        /* ignore */
      }
      player = null;
    }

    mountEmbedFrame(id);
    player = new YT.Player("player", {
      events: {
        onReady: () => {
          applyEmbedReferrer();
          player.pauseVideo();
        },
        onStateChange: onPlayerState,
        onError: (e) => {
          setStatus(`YouTube player error ${e.data}. Try another public video with captions.`);
        },
      },
    });
  }

  function onPlayerState(e) {
    if (e.data === YT.PlayerState.PLAYING) {
      els.plaqueWrap.classList.add("singing");
      startTurnOut();
      startAnimLoop();
      setStatus("Billy is singing along…");
    } else if (
      e.data === YT.PlayerState.PAUSED ||
      e.data === YT.PlayerState.ENDED ||
      e.data === YT.PlayerState.CUED
    ) {
      stopAnimLoop(e.data === YT.PlayerState.ENDED);
      if (e.data === YT.PlayerState.ENDED) setStatus("Song finished. Press the red button again!");
      else if (e.data === YT.PlayerState.PAUSED) setStatus("Paused. Press the red button to resume.");
    }
  }

  function findActive(time) {
    let lo = 0;
    let hi = words.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const w = words[mid];
      if (time < w.start) hi = mid - 1;
      else if (time > w.end) lo = mid + 1;
      else {
        found = w;
        break;
      }
    }
    return found;
  }

  function findCue(time) {
    return cues.find((c) => time >= c.start && time <= c.end) || null;
  }

  function renderSpeech(time) {
    const cue = findCue(time);
    if (!cue) {
      els.speech.hidden = true;
      els.speechText.textContent = "";
      return;
    }
    els.speech.hidden = false;
    const active = findActive(time);
    const all = cue.words;
    let startIdx = 0;
    let endIdx = all.length;
    if (active) {
      const idx = all.findIndex((w) => w.start === active.start && w.text === active.text);
      if (idx >= 0) {
        startIdx = Math.max(0, idx - 6);
        endIdx = Math.min(all.length, idx + 8);
      }
    }
    els.speechText.innerHTML = all
      .slice(startIdx, endIdx)
      .map((w) => {
        const safe = escapeHtml(w.text);
        if (active && w.start === active.start && w.text === active.text) {
          return `<span class="word-current">${safe}</span>`;
        }
        return safe;
      })
      .join(" ");
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function cleanCaptionText(s) {
    return s
      .replace(/&gt;/gi, ">")
      .replace(/&lt;/gi, "<")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/>>+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tick() {
    if (!player || typeof player.getCurrentTime !== "function") {
      animFrame = requestAnimationFrame(tick);
      return;
    }
    const time = player.getCurrentTime();
    const now = performance.now();
    const m = billy.manifest;

    if (m) {
      if (billy.phase === "turningOut" || billy.phase === "turningIn") {
        if (now - billy.lastStep > 55) {
          billy.lastStep = now;
          billy.seqIdx += 1;
          if (billy.seqIdx >= billy.seq.length) {
            if (billy.phase === "turningOut") goTalking();
            else goRest();
          } else {
            showFrame(billy.seq[billy.seqIdx]);
          }
        }
      } else if (billy.phase === "talking") {
        const cue = words.length ? findCue(time) : null;
        const active = words.length ? findActive(time) : null;
        const speaking = !!(cue || active) || !words.length;
        if (speaking) {
          if (now - billy.lastStep > 70) {
            billy.lastStep = now;
            const cycle = m.talkCycle || [m.talkClosed, m.talkOpen];
            billy.chatter = (billy.chatter + 1) % cycle.length;
            showFrame(cycle[billy.chatter]);
          }
        } else {
          showFrame(m.talkClosed);
        }
      }
    }

    renderSpeech(time);
    animFrame = requestAnimationFrame(tick);
  }

  function startAnimLoop() {
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = requestAnimationFrame(tick);
  }

  function stopAnimLoop(hideSpeech) {
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = null;
    els.plaqueWrap.classList.remove("singing", "mouth-closed");
    startTurnIn();
    // Finish turn-in even after loop stops
    const finish = () => {
      if (billy.phase !== "turningIn") {
        goRest();
        return;
      }
      const now = performance.now();
      if (now - billy.lastStep > 55) {
        billy.lastStep = now;
        billy.seqIdx += 1;
        if (billy.seqIdx >= billy.seq.length) {
          goRest();
          return;
        }
        showFrame(billy.seq[billy.seqIdx]);
      }
      requestAnimationFrame(finish);
    };
    billy.lastStep = 0;
    requestAnimationFrame(finish);

    if (hideSpeech) {
      els.speech.hidden = true;
      els.speechText.textContent = "";
    }
  }

  async function loadVideo() {
    const id = extractVideoId(els.url.value);
    if (!id) {
      setStatus("That doesn’t look like a YouTube link. Try again.");
      return;
    }
    videoId = id;
    cues = [];
    words = [];
    els.meta.hidden = false;
    els.capStatus.textContent = "Loading…";
    els.wordCount.textContent = "—";
    els.speech.hidden = true;
    stopAnimLoop(true);

    if (!ytReady) {
      pendingVideoId = id;
      setStatus("Loading YouTube player…");
    } else {
      createPlayer(id);
    }

    const result = await loadCaptions(id);
    if (videoId !== id) return; // stale

    if (result.ok) {
      els.capStatus.textContent = `${result.track.lang}${result.track.kind === "asr" ? " (auto)" : ""}`;
      els.wordCount.textContent = String(result.count);
      setStatus("Ready! Press the red button — Billy will mouth the words.");
    } else {
      els.capStatus.textContent = "None found";
      els.wordCount.textContent = "0";
      setStatus("Couldn’t pull captions (even though YouTube may show them). Try reloading, or another public video.");
    }
  }

  function togglePlay() {
    els.redBtn.classList.add("pressed");
    setTimeout(() => els.redBtn.classList.remove("pressed"), 120);

    if (!player || !videoId) {
      if (els.url.value.trim()) loadVideo().then(() => {
        // wait a beat for player
        setTimeout(() => {
          if (player && typeof player.playVideo === "function") player.playVideo();
        }, 600);
      });
      else setStatus("Paste a YouTube link and hit Load first.");
      return;
    }

    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) player.pauseVideo();
    else player.playVideo();
  }

  // YouTube API global callback
  window.onYouTubeIframeAPIReady = () => {
    ytReady = true;
    if (pendingVideoId) {
      createPlayer(pendingVideoId);
      pendingVideoId = null;
    }
  };

  // In case API loaded before our script finished
  if (window.YT && window.YT.Player) {
    ytReady = true;
  }

  const DEFAULT_CHANNEL = {
    handle: "@HotMakesLive",
    // Baked-in recent uploads — avoids CORS proxies on GitHub Pages
    videoIds: [
      "N-eFoXRFbo4",
      "sE5z7ifB_aw",
      "n3H5GcRNRm8",
      "iESKB7Kdgog",
      "CR4T0QrJT9k",
      "knEGIT5tcTU",
      "GxfUwdS3lJU",
      "HoZ-cwAQqdI",
      "-GGCOc_x-PA",
      "kL0CTC1y2iw",
      "6ZridA-UFsI",
      "1zsXQ_XbG4U",
      "hLZ6ecn2utI",
      "qxgSgGikQWA",
      "W-8SCtzhG2w",
      "Evh2B3dGxAY",
      "N7nAINMrBdk",
    ],
  };

  function pickRandom(ids) {
    return ids[Math.floor(Math.random() * ids.length)];
  }

  async function bootDefaultVideo() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("v");
    if (fromQuery && extractVideoId(fromQuery)) {
      els.url.value = `https://www.youtube.com/watch?v=${extractVideoId(fromQuery)}`;
      setStatus("Loading your video…");
      await loadVideo();
      return;
    }

    setStatus(`Picking a random ${DEFAULT_CHANNEL.handle} video…`);
    const id = pickRandom(DEFAULT_CHANNEL.videoIds);
    els.url.value = `https://www.youtube.com/watch?v=${id}`;
    await loadVideo();
  }

  els.loadBtn.addEventListener("click", () => loadVideo());
  els.url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadVideo();
  });
  els.redBtn.addEventListener("click", togglePlay);

  initBilly();
  bootDefaultVideo();
})();
