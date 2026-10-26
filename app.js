(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MODELS = ["base", "gsam", "ours"];
  let API = (localStorage.getItem("api") || window.API_BASE || "").replace(/\/$/, "");
  let live = false, demos = [], cur = null, custom = null, running = false;
  let chain = null; // per-model latest result for follow-up turns: {source, turn, base, gsam, ours}

  // ---- backend status
  const setStatus = (kind, text) => {
    const p = $("#status"); p.classList.remove("live", "cached"); if (kind) p.classList.add(kind);
    $("#status-text").textContent = text;
  };
  // The backend's current public address is published to backend.json in the
  // GitHub repo by start_backend.sh, so a new tunnel never needs a redeploy.
  async function discoverBackend() {
    if (localStorage.getItem("api")) return;
    // Read the address from the site's own domain (redeployed on every push) and from
    // GitHub; some networks block one of the two. Take whichever was updated last.
    const get = u => fetch(u + "?t=" + Date.now(), { cache: "no-store" }).then(r => r.json()).catch(() => null);
    const found = (await Promise.all([get("backend.json"), get("https://raw.githubusercontent.com/Amritha902/localize-web/main/backend.json")]))
      .filter(j => j && j.url).sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    if (found.length) API = found[0].url.replace(/\/$/, "");
  }
  async function checkBackend() {
    if (!API) { live = false; setStatus("cached", "Gallery mode"); updateMode(); return; }
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 5000);
      const r = await fetch(API + "/api/health", { signal: c.signal }); clearTimeout(t);
      const j = await r.json(); live = !!j.ok;
      setStatus("live", "Live · " + (j.device === "mps" ? "Apple GPU" : j.device.toUpperCase()));
    } catch { live = false; setStatus("cached", "Gallery mode"); }
    updateMode();
  }

  // ---- gallery
  async function loadDemos() {
    demos = await (await fetch("demos/index.json")).json();
    const g = $("#gallery");
    demos.forEach((d, i) => {
      const b = document.createElement("button");
      b.className = "thumb"; b.setAttribute("role", "option");
      b.innerHTML = `<img src="${d.input}" alt="" loading="lazy"><div><b>${d.kind}${d.gt ? " · scored" : ""}</b>${d.instruction}</div>`;
      b.onclick = () => pick(i); g.appendChild(b);
    });
    pick(0);
  }
  function pick(i) {
    cur = demos[i]; custom = null; $("#truth").hidden = !cur.gt_overlay; $("#truth").classList.remove("on");
    $$(".thumb").forEach((t, k) => t.classList.toggle("on", k === i));
    setPreview(cur.input); $("#instruction").value = cur.instruction; resetCards(); updateMode();
  }
  function setPreview(src) { $("#preview").src = src; $("#drop").classList.add("has"); $("#run").disabled = false; }

  // ---- upload
  const drop = $("#drop"), file = $("#file");
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") file.click(); });
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) useFile(f); });
  file.addEventListener("change", () => { if (file.files[0]) useFile(file.files[0]); });
  function useFile(f) {
    if (!f.type.startsWith("image/")) return;
    $("#truth").hidden = true;
    custom = f; cur = null; $$(".thumb").forEach(t => t.classList.remove("on"));
    setPreview(URL.createObjectURL(f)); $("#instruction").value = ""; $("#instruction").focus(); resetCards(); updateMode();
  }
  $("#instruction").addEventListener("input", updateMode);
  $("#instruction").addEventListener("keydown", e => { if (e.key === "Enter" && !$("#run").disabled) run(); });

  function cachedOK() { return cur && !custom && $("#instruction").value.trim() === cur.instruction; }
  function updateMode() {
    const m = $("#mode");
    if (live) m.textContent = "Runs live on the GPU · regions and scores in seconds, edited photos over the next 1–2 minutes";
    else if (cachedOK()) m.textContent = "Backend offline · showing this pipeline's recorded output";
    else m.textContent = "Custom photos and instructions need the live backend";
    $("#run").disabled = running || !(cur || custom) || !$("#instruction").value.trim() || (!live && !cachedOK());
  }

  $("#truth").onclick = e => { e.preventDefault(); e.stopPropagation(); if (!cur || !cur.gt_overlay) return;
    const on = $("#truth").classList.toggle("on"); $("#preview").src = on ? cur.gt_overlay : cur.input;
    $("#truth").textContent = on ? "Hide true edit region" : "Show true edit region"; };

  // ---- cards
  function resetCards() {
    $$(".card").forEach(c => {
      const f = $(".frame", c); f.className = "frame show-result";
      $$("img", f).forEach(i => { i.classList.remove("ready"); i.removeAttribute("src"); });
      $(".placeholder", c).textContent = "Waiting"; $(".metrics", c).innerHTML = "";
      $$(".seg button", c).forEach(b => b.classList.toggle("on", b.dataset.v === "result"));
      c.dataset.iou = ""; $$(".best", c).forEach(b => b.remove());
    });
    $("#acc-note").hidden = true;
    $("#compare").hidden = true; $("#followup").hidden = true;
  }
  $$(".card").forEach(c => $$(".seg button", c).forEach(b => b.onclick = () => {
    $$(".seg button", c).forEach(x => x.classList.toggle("on", x === b));
    const f = $(".frame", c); f.classList.toggle("show-result", b.dataset.v === "result"); f.classList.toggle("show-region", b.dataset.v === "region");
  }));
  function loading(m, on, text) {
    const c = $(`.card[data-model="${m}"]`); $(".frame", c).classList.toggle("loading", on);
    if (text) $(".placeholder", c).textContent = text;
  }
  const loadImg = (img, src) => new Promise(res => { img.onload = () => { img.classList.add("ready"); res(); }; img.src = src; });
  async function fill(m, region, result, d) {
    const c = $(`.card[data-model="${m}"]`), f = $(".frame", c);
    await Promise.all([loadImg($(".r-region", c), region), loadImg($(".r-result", c), result)]);
    f.classList.remove("loading"); f.classList.add("done");
    c.dataset.iou = d.iou == null ? "" : d.iou;
    const rows = [];
    if (d.iou != null) rows.push(["Accuracy (IoU vs true region)", d.iou.toFixed(3), "iou"]);
    rows.push(["Changed outside region", d.outside_changed.toFixed(2) + "%", "good"]);
    if (m !== "base" && d.query) rows.push(["Searched for", "“" + d.query + "”"]);
    rows.push(["Area of photo", d.coverage.toFixed(1) + "%"], ["Region found in", fmtMs(d.region_ms)],
              [d.recolour ? "Recoloured in" : "Edited in", d.edit_s.toFixed(1) + " s"]);
    $(".metrics", c).innerHTML = rows.map(([k, v, cl]) => `<dt>${k}</dt><dd class="${cl || ""}">${v}</dd>`).join("");
  }
  // Stage 1: the region and its score, a few seconds after Run.
  function metricRows(m, d, edit) {
    const rows = [];
    if (d.iou != null) rows.push(["Accuracy (IoU vs true region)", d.iou.toFixed(3), "iou"]);
    if (edit) rows.push(["Changed outside region", edit.outside_changed.toFixed(2) + "%", "good"]);
    if (m !== "base" && d.query) rows.push(["Searched for", "“" + d.query + "”"]);
    rows.push(["Area of photo", d.coverage.toFixed(1) + "%"], ["Region found in", fmtMs(d.region_ms)]);
    rows.push(edit ? [edit.recolour ? "Recoloured in" : "Edited in", edit.edit_s.toFixed(1) + " s"] : ["Edit", "<span class='wait'>waiting…</span>"]);
    return rows.map(([k, v, cl]) => `<dt>${k}</dt><dd class="${cl || ""}">${v}</dd>`).join("");
  }
  async function fillRegion(m, d) {
    const c = $(`.card[data-model="${m}"]`), f = $(".frame", c);
    await loadImg($(".r-region", c), d.region);
    f.classList.remove("loading"); f.className = "frame show-region done";
    $$(".seg button", c).forEach(b => b.classList.toggle("on", b.dataset.v === "region"));
    c.dataset.iou = d.iou == null ? "" : d.iou; c._region = d;
    $(".metrics", c).innerHTML = metricRows(m, d, null);
  }
  // Stage 2: the edited photo, one predictor at a time, with a live timer.
  function painting(m, on) {
    const c = $(`.card[data-model="${m}"]`), f = $(".frame", c);
    let tag = $(".painting", f);
    if (!on) { if (tag) { clearInterval(tag._t); tag.remove(); } return; }
    if (!tag) { tag = document.createElement("div"); tag.className = "painting"; f.appendChild(tag); }
    const t0 = Date.now(); const tick = () => { tag.textContent = "Painting the edit… " + Math.round((Date.now() - t0) / 1000) + " s"; };
    tick(); tag._t = setInterval(tick, 1000);
    const w = $(".metrics .wait", c); if (w) w.textContent = "painting…";
  }
  async function fillEdit(m, j) {
    const c = $(`.card[data-model="${m}"]`), f = $(".frame", c);
    await loadImg($(".r-result", c), j.result); painting(m, false);
    f.className = "frame show-result done";
    $$(".seg button", c).forEach(b => b.classList.toggle("on", b.dataset.v === "result"));
    const d = c._region || j; $(".metrics", c).innerHTML = metricRows(m, d, j);
  }
  function markBest() {
    const cs = $$(".card").filter(c => c.dataset.iou !== "");
    $$(".card .best").forEach(b => b.remove());
    if (cs.length < 3) { $("#acc-note").hidden = true; return; }
    const best = cs.reduce((a, b) => (+b.dataset.iou > +a.dataset.iou ? b : a));
    const tag = document.createElement("span"); tag.className = "best"; tag.textContent = "Most accurate";
    $("header div h3", best).appendChild(tag); $("#acc-note").hidden = false;
  }
  const fmtMs = ms => ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms";
  const sleep = t => new Promise(r => setTimeout(r, t));
  // The free tunnel occasionally drops a connection; retry a run before giving up.
  async function post(fd, path = "/api/run") {
    for (let k = 0; k < 3; k++) {
      try { const r = await fetch(API + path, { method: "POST", body: fd }); if (r.ok) return r.json(); if (r.status < 500) throw new Error(await r.text()); }
      catch (e) { if (k === 2) throw e; }
      await sleep(2000 * (k + 1)); await discoverBackend();
    }
  }

  // ---- run
  $("#run").onclick = run;
  async function run() {
    if (running) return; running = true; chain = null; $("#run").classList.add("busy"); updateMode(); resetCards();
    const ins = $("#instruction").value.trim(); let source = null;
    try {
      if (live) {
        const blob = custom || await (await fetch(cur.input)).blob();
        const gtBlob = cachedOK() && cur.gt ? await (await fetch(cur.gt)).blob() : null;
        MODELS.forEach(m => loading(m, true, "Finding the region…"));
        const rf = new FormData(); rf.append("image", blob, "photo.jpg"); rf.append("instruction", ins);
        if (gtBlob) rf.append("gt", gtBlob, "gt.png");
        const R = await post(rf, "/api/regions"); source = R.source;
        await Promise.all(MODELS.map(m => fillRegion(m, R.models[m]))); markBest();
        for (const m of MODELS) {
          painting(m, true);
          const fd = new FormData(); fd.append("image", blob, "photo.jpg"); fd.append("instruction", ins); fd.append("model", m);
          if (gtBlob) fd.append("gt", gtBlob, "gt.png");
          await fillEdit(m, await post(fd));
        }
      } else {
        MODELS.forEach(m => loading(m, true, "Loading recorded output…")); await sleep(400);
        await Promise.all(MODELS.map(m => fillRegion(m, Object.assign({ region: `demos/${cur.slug}/${m}_region.jpg` }, cur.models[m]))));
        markBest();
        for (const m of MODELS) {
          painting(m, true); await sleep(500);
          await fillEdit(m, Object.assign({ result: `demos/${cur.slug}/${m}_result.jpg` }, cur.models[m]));
        }
        source = cur.input;
      }
      markBest();
      const after = $(`.card[data-model="ours"] .r-result`).src;
      showCompare(source, after);
      chain = { source, turn: 1, ins: [ins] }; MODELS.forEach(m => chain[m] = $(`.card[data-model="${m}"] .r-result`).src);
      $("#history").innerHTML = ""; await addHistory(ins); showFollowup();
    } catch (e) {
      MODELS.forEach(m => { painting(m, false); loading(m, false, "Could not reach the backend"); });
      live = false; checkBackend();
    } finally { running = false; $("#run").classList.remove("busy"); updateMode(); }
  }

  // ---- follow-up turns: each predictor keeps editing its own last result
  function showFollowup() {
    $("#followup").hidden = !live; $("#turn").textContent = "Turn " + (chain.turn + 1);
    $("#fu-input").value = ""; $("#fu-run").disabled = false;
  }
  // Share of the photograph that now differs from the original (any channel off by > 24/255).
  const pixels = src => new Promise(res => { const im = new Image(); im.onload = () => {
    const c = document.createElement("canvas"); c.width = c.height = 256; const x = c.getContext("2d");
    x.drawImage(im, 0, 0, 256, 256); res(x.getImageData(0, 0, 256, 256).data); }; im.src = src; });
  async function drift(src, now) {
    const [a, b] = await Promise.all([pixels(src), pixels(now)]); let n = 0;
    for (let i = 0; i < a.length; i += 4)
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 24) n++;
    return n / (a.length / 4) * 100;
  }
  async function addHistory(ins) {
    const d = await Promise.all(MODELS.map(m => drift(chain.source, chain[m])));
    const li = document.createElement("li");
    li.innerHTML = `<div><b>Turn ${chain.turn}</b>${ins}</div>` + MODELS.map((m, k) =>
      `<div><img src="${chain[m]}" alt=""><div class="cap">${["Base paper", "G-SAM2", "Ours v2"][k]} · ${d[k].toFixed(1)}% of photo changed</div></div>`).join("");
    $("#history").appendChild(li);
  }
  $("#fu-input").addEventListener("keydown", e => { if (e.key === "Enter") followUp(); });
  $("#fu-run").onclick = followUp;
  $("#fu-reset").onclick = () => { chain = null; $("#followup").hidden = true; resetCards(); };
  async function followUp() {
    const ins = $("#fu-input").value.trim(); if (!ins || running || !chain || !live) return;
    running = true; $("#fu-run").disabled = true; $("#run").classList.add("busy"); updateMode();
    try {
      for (const m of MODELS) {
        loading(m, true, "Turn " + (chain.turn + 1) + " · predicting region…");
        const blob = await (await fetch(chain[m])).blob();
        const fd = new FormData(); fd.append("image", blob, "turn.jpg"); fd.append("instruction", ins); fd.append("model", m);
        const j = await post(fd); await fill(m, j.region, j.result, j); chain[m] = j.result;
      }
      chain.turn++; chain.ins.push(ins); await addHistory(ins);
      showCompare(chain.source, chain.ours); showFollowup();
    } catch (e) {
      MODELS.forEach(m => loading(m, false, "Could not reach the backend")); live = false; checkBackend();
    } finally { running = false; $("#run").classList.remove("busy"); $("#fu-run").disabled = false; updateMode(); }
  }

  // ---- before / after
  function showCompare(before, after) {
    $("#ba-before").src = before; $("#ba-after").src = after; $("#compare").hidden = false;
    const ba = $("#ba"), wrap = $("#ba-before-wrap"), h = $("#ba-handle"), bi = $("#ba-before");
    const size = () => { bi.style.width = ba.clientWidth + "px"; bi.style.height = ba.clientHeight + "px"; };
    $("#ba-after").onload = size; window.addEventListener("resize", size); size();
    const set = x => { const r = ba.getBoundingClientRect(); const p = Math.min(1, Math.max(0, (x - r.left) / r.width));
      wrap.style.width = p * 100 + "%"; h.style.left = p * 100 + "%"; };
    let drag = false;
    ba.onpointerdown = e => { drag = true; ba.setPointerCapture(e.pointerId); set(e.clientX); };
    ba.onpointermove = e => drag && set(e.clientX);
    ba.onpointerup = () => drag = false;
  }

  // ---- results bars
  const BARS = [["CLIPSeg", "150.7 M · CVPR 2022", .1849, "#8e8e93"], ["Human annotation", "shipped with the dataset", .1511, "#636366"],
                ["Our first model", "4.69 M", .2055, "#5e5ce6"], ["Grounding DINO + SAM 2.1", "211 M", .2721, "#30D158"],
                ["Localize (ours v2)", "cross-validated", .2771, "#0A84FF"]];
  $("#bars").innerHTML = BARS.map(([l, s, v, c]) =>
    `<div class="bar"><div class="lab">${l}<small>${s}</small></div><div class="track"><div class="fill" style="background:${c}" data-w="${v / .3 * 100}"></div></div><div class="val">${v.toFixed(4)}</div></div>`).join("");

  // ---- scroll reveals
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; e.target.classList.add("in");
    $$(".fill", e.target).forEach(f => f.style.width = f.dataset.w + "%"); io.unobserve(e.target);
  }), { threshold: .15 });
  $$(".section-head, .steps li, .bars, .kinds, .tile, .hero > *").forEach(el => { el.classList.add("reveal"); io.observe(el); });

  // ---- backend dialog
  $("#api-btn").onclick = () => { $("#api-input").value = localStorage.getItem("api") || ""; $("#api-dialog").showModal(); };
  $("#api-save").onclick = () => { const v = $("#api-input").value.trim();
    v ? localStorage.setItem("api", v) : localStorage.removeItem("api");
    API = (v || window.API_BASE || "").replace(/\/$/, ""); checkBackend(); };

  loadDemos().then(discoverBackend).then(checkBackend);
  setInterval(async () => { if (!running) { await discoverBackend(); checkBackend(); } }, 30000);
})();
