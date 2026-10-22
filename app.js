(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MODELS = ["base", "gsam", "ours"];
  let API = (localStorage.getItem("api") || window.API_BASE || "").replace(/\/$/, "");
  let live = false, demos = [], cur = null, custom = null, running = false;

  // ---- backend status
  const setStatus = (kind, text) => {
    const p = $("#status"); p.classList.remove("live", "cached"); if (kind) p.classList.add(kind);
    $("#status-text").textContent = text;
  };
  async function checkBackend() {
    if (!API) { live = false; setStatus("cached", "Gallery mode"); return; }
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
      b.innerHTML = `<img src="${d.input}" alt="" loading="lazy"><div><b>${d.kind}</b>${d.instruction}</div>`;
      b.onclick = () => pick(i); g.appendChild(b);
    });
    pick(0);
  }
  function pick(i) {
    cur = demos[i]; custom = null;
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
    custom = f; cur = null; $$(".thumb").forEach(t => t.classList.remove("on"));
    setPreview(URL.createObjectURL(f)); $("#instruction").value = ""; $("#instruction").focus(); resetCards(); updateMode();
  }
  $("#instruction").addEventListener("input", updateMode);
  $("#instruction").addEventListener("keydown", e => { if (e.key === "Enter" && !$("#run").disabled) run(); });

  function cachedOK() { return cur && !custom && $("#instruction").value.trim() === cur.instruction; }
  function updateMode() {
    const m = $("#mode");
    if (live) m.textContent = "Runs live on the GPU backend · about 50 s for all three";
    else if (cachedOK()) m.textContent = "Backend offline · showing this pipeline's recorded output";
    else m.textContent = "Custom photos and instructions need the live backend";
    $("#run").disabled = running || !(cur || custom) || !$("#instruction").value.trim() || (!live && !cachedOK());
  }

  // ---- cards
  function resetCards() {
    $$(".card").forEach(c => {
      const f = $(".frame", c); f.className = "frame show-result";
      $$("img", f).forEach(i => { i.classList.remove("ready"); i.removeAttribute("src"); });
      $(".placeholder", c).textContent = "Waiting"; $(".metrics", c).innerHTML = "";
      $$(".seg button", c).forEach(b => b.classList.toggle("on", b.dataset.v === "result"));
    });
    $("#compare").hidden = true;
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
    const rows = [["Region found in", fmtMs(d.region_ms)], ["Frame covered", d.coverage.toFixed(1) + "%"],
                  ["Edited in", d.edit_s.toFixed(1) + " s"], ["Changed outside region", d.outside_changed.toFixed(2) + "%", "good"]];
    if (m !== "base" && d.query) rows.splice(1, 0, ["Searched for", "“" + d.query + "”"]);
    $(".metrics", c).innerHTML = rows.map(([k, v, cl]) => `<dt>${k}</dt><dd class="${cl || ""}">${v}</dd>`).join("");
  }
  const fmtMs = ms => ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms";
  const sleep = t => new Promise(r => setTimeout(r, t));

  // ---- run
  $("#run").onclick = run;
  async function run() {
    if (running) return; running = true; $("#run").classList.add("busy"); updateMode(); resetCards();
    const ins = $("#instruction").value.trim(); let source = null;
    try {
      if (live) {
        const blob = custom || await (await fetch(cur.input)).blob();
        for (const m of MODELS) {
          loading(m, true, m === "base" ? "Predicting region…" : "Queued");
          if (m !== "base") loading(m, true, "Predicting region…");
          const fd = new FormData(); fd.append("image", blob, "photo.jpg"); fd.append("instruction", ins); fd.append("model", m);
          const r = await fetch(API + "/api/run", { method: "POST", body: fd });
          if (!r.ok) throw new Error(await r.text());
          const j = await r.json(); source = j.source; await fill(m, j.region, j.result, j);
        }
      } else {
        for (const m of MODELS) {
          loading(m, true, "Loading recorded output…"); await sleep(450);
          const d = cur.models[m];
          await fill(m, `demos/${cur.slug}/${m}_region.jpg`, `demos/${cur.slug}/${m}_result.jpg`, d);
        }
        source = cur.input;
      }
      const after = $(`.card[data-model="ours"] .r-result`).src;
      showCompare(source, after);
    } catch (e) {
      MODELS.forEach(m => loading(m, false, "Could not reach the backend"));
      live = false; checkBackend();
    } finally { running = false; $("#run").classList.remove("busy"); updateMode(); }
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

  loadDemos().then(checkBackend);
  setInterval(() => { if (!running) checkBackend(); }, 30000);
})();
