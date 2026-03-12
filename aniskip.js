// ==UserScript==
// @name         AniSkip
// @namespace    https://github.com/zebra2711/aniskip
// @version      0.1
// @description  Skip OP, ED, recaps, and filler on AnimeVietSub
// @match        *://animevietsub.mx/phim/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @connect      raw.githubusercontent.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /* ─── Storage ─── */
  function storeKey() {
    return location.pathname.replace(/^\//, "");
  }

  function loadSkipTypes() {
    const defaults = { op: true, ed: true, recap: true, preview: true, filler: true, ad: true };
    try {
      const saved = JSON.parse(GM_getValue("skip_types", "{}"));
      return { ...defaults, ...saved };
    } catch (_) {
      return defaults;
    }
  }
  function saveSkipTypes(st) {
    GM_setValue("skip_types", JSON.stringify(st));
  }
  let skipTypes = {};

  function loadSegs() {
    try { return JSON.parse(GM_getValue(storeKey(), "[]")) || []; } catch (_) { return []; }
  }
  function saveSegs(s) { GM_setValue(storeKey(), JSON.stringify(s)); }

  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (hh > 0) return hh + ":" + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
    return mm + ":" + String(ss).padStart(2, "0");
  }
  function parseFmt(str) {
    str = String(str).trim().replace(/[^0-9:]/g, "");
    if (str.includes(":")) {
      const parts = str.split(":").map(Number);
      const [a = 0, b = 0, c = 0] = parts;
      return parts.length >= 3 ? a * 3600 + b * 60 + c : a * 60 + b;
    }
    const d = str.replace(/\D/g, "");
    if (!d) return NaN;
    if (d.length <= 2) return parseInt(d, 10);
    if (d.length <= 4) return parseInt(d.slice(0, -2), 10) * 60 + parseInt(d.slice(-2), 10);
    return parseInt(d.slice(0, -4), 10) * 3600 + parseInt(d.slice(-4, -2), 10) * 60 + parseInt(d.slice(-2), 10);
  }

  function autoFmt(raw) {
    const d = raw.replace(/\D/g, "").slice(0, 6);
    if (!d) return "";
    const ss = parseInt(d.slice(-2) || "0", 10);
    const mm = parseInt(d.slice(-4, -2) || "0", 10);
    const hh = parseInt(d.slice(0, -4) || "0", 10);
    if (hh > 0) return hh + ":" + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
    return mm + ":" + String(ss).padStart(2, "0");
  }

  function attachAutoFormat(inp) {
    inp.addEventListener("input", () => {
      inp.value = inp.value.replace(/[^\d:]/g, "").slice(0, 8);
    });
    inp.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text");
      inp.value = text.replace(/[^\d:]/g, "").slice(0, 8);
    });
    inp.addEventListener("blur", () => {
      if (inp.value) inp.value = autoFmt(inp.value);
    });
  }

  const TYPES = {
    op:      { label: "OP",     color: "#00b4d8" },
    ed:      { label: "ED",     color: "#f77f00" },
    recap:   { label: "Recap",  color: "#9b5de5" },
    preview: { label: "Preview",color: "#06d6a0" },
    filler:  { label: "Filler", color: "#adb5bd" },
    ad:      { label: "Ad",     color: "#e63946" },
  };

  function liveGetPos() {
    if (window.jwplayer && typeof window.jwplayer === "function") {
      const p = window.jwplayer();
      if (p && typeof p.getPosition === "function") {
        const pos = p.getPosition();
        return typeof pos === "number" ? pos : 0;
      }
    }
    const v = document.querySelector("#media-player video, video");
    if (v) return v.currentTime || 0;
    return 0;  // always returns 0 when video not start
  }

  function liveSeekTo(t) {
    t = Math.max(0, t || 0);
    if (window.jwplayer && typeof window.jwplayer === "function") {
      const p = window.jwplayer();
      if (p && typeof p.seek === "function") {
        p.seek(t);
        if (typeof p.play === "function") p.play();
        return true;
      }
    }
    const v = document.querySelector("#media-player video, video");
    if (v) {
      v.currentTime = t;
      if (v.paused) v.play().catch(() => {}); // force play if video is idle
      return true;
    }
    return false;
  }

  function detectPlayer(cb) {
    let found = false, tries = 0;
    const id = setInterval(() => {
      tries++;
      if (found) return;
      if (window.jwplayer && typeof window.jwplayer === "function") {
        const p = window.jwplayer();
        if (p && typeof p.on === "function") {
          found = true; clearInterval(id);
          const state = typeof p.getState === "function" ? p.getState() : "";
          if (state && state !== "idle" && state !== "error") cb(p, null);
          else { p.on("ready", () => cb(p, null)); p.on("firstFrame", () => cb(p, null)); }
          return;
        }
      }
      if (tries > 60) {
        found = true; clearInterval(id);
        cb(null, document.querySelector("#media-player video, video") || null);
      }
    }, 500);
  }

  const SKIP_COOL = 3000;
  let lastSkip = -Infinity;
  let tlContainer = null;

  function liveDur() {
    if (window.jwplayer && typeof window.jwplayer === "function") {
      const p = window.jwplayer();
      if (p && typeof p.getDuration === "function") return p.getDuration() || 0;
    }
    const v = document.querySelector("#media-player video, video");
    if (v) return v.duration || 0;
    return 0;
  }

  function initEngine(jwp, videoEl) {
    function onMeta() { refreshTimeline(loadSegs(), liveDur()); }
    if (jwp) {
      jwp.on("meta", onMeta);
      jwp.on("firstFrame", () => { tlContainer = null; onMeta(); });
      jwp.on("playlistItem", () => { tlContainer = null; });
    }
    if (videoEl) videoEl.addEventListener("loadedmetadata", () => { tlContainer = null; onMeta(); });
  }

  function refreshTimeline(segs, dur) {
    if (!dur) return;
    if (!tlContainer) {
      const container = document.querySelector(".jw-timesegment-container");
      if (!container) return;
      tlContainer = document.createElement("div");
      Object.assign(tlContainer.style, {
        position: "absolute", top: "0", left: "0",
        width: "100%", height: "100%",
        pointerEvents: "none", zIndex: "5",
      });
      container.appendChild(tlContainer);
    }
    tlContainer.innerHTML = "";
    for (const seg of segs) {
      const bar = document.createElement("div");
      Object.assign(bar.style, {
        position: "absolute", top: "0",
        left: (seg.start / dur * 100) + "%",
        width: Math.max(0.3, (seg.end - seg.start) / dur * 100) + "%",
        height: "100%", background: TYPES[seg.type]?.color || "#fff",
        opacity: "0.75", borderRadius: "2px", pointerEvents: "none",
      });
      bar.title = (TYPES[seg.type]?.label || seg.type) + " " + fmt(seg.start) + " – " + fmt(seg.end);
      tlContainer.appendChild(bar);
    }
  }

  function showToast(msg) {
    const old = document.getElementById("avs-toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.id = "avs-toast";
    t.textContent = msg;
    Object.assign(t.style, {
      position: "fixed", bottom: "160px", right: "16px",
      background: "#00b4d8", color: "#fff",
      padding: "7px 14px", borderRadius: "6px",
      fontSize: "13px", fontWeight: "bold",
      zIndex: "2147483647", pointerEvents: "none",
      transition: "opacity 0.5s",
    });
    document.body.appendChild(t);
    setTimeout(() => (t.style.opacity = "0"), 1600);
    setTimeout(() => t.remove(), 2200);
  }

  /* ─── WIDGET — ultra-compact list rows ─── */
  function buildWidget() {
    if (document.getElementById("avs-widget")) return;

    const wrap = document.createElement("div");
    wrap.id = "avs-widget";
    Object.assign(wrap.style, {
      position: "fixed", zIndex: "2147483647", width: "220px", background: "#1a1a2e", borderRadius: "8px",
      boxShadow: "0 3px 14px rgba(0,0,0,0.6)", fontFamily: "sans-serif", fontSize: "13px", overflow: "hidden",
      userSelect: "none", top: "10px", right: "10px", left: "auto", bottom: "auto",
    });

    const hdr = document.createElement("div");
    Object.assign(hdr.style, {
      background: "#16213e", color: "#e0e0e0",
      padding: "6px 8px", fontWeight: "bold", fontSize: "13px",
      display: "flex", justifyContent: "space-between", alignItems: "center",
      cursor: "move",
    });
    const hdrTitle = document.createElement("span");
    hdrTitle.textContent = "Anime Skip";
    const collapseBtn = document.createElement("span");
    collapseBtn.textContent = "+";
    Object.assign(collapseBtn.style, { cursor: "pointer", padding: "0 4px", fontSize: "14px" });
    hdr.append(hdrTitle, collapseBtn);

    const body = document.createElement("div");
    body.style.padding = "6px";
    body.style.display = "none";

    /* Quick Jump */
    const quickRow = document.createElement("div");
    Object.assign(quickRow.style, { display: "flex", gap: "4px", alignItems: "center", marginBottom: "6px", height: "30px" });
    const timeInput = document.createElement("input");
    timeInput.type = "text"; timeInput.placeholder = "MM:SS";
    Object.assign(timeInput.style, {
      flex: "1", padding: "4px 6px", border: "none", borderRadius: "4px", marginBottom: "0", height: "30px",
      background: "#0f3460", color: "#e0e0e0", fontSize: "13px", outline: "none", fontWeight: "bold",
    });
    const jumpBtn = document.createElement("button");
    jumpBtn.textContent = "Jump";
    Object.assign(jumpBtn.style, {
      height: "30px", justifyContent: "center", alignItems: "center",
      padding: "0px 8px", background: "#00b4d8", color: "#fff",
      border: "none", borderRadius: "4px", cursor: "pointer", display: "flex",
      fontWeight: "bold", fontSize: "13px", marginBottom: "0",
    });
    jumpBtn.onclick = () => {
      let t;
      if (!timeInput.value.trim()) {
        t = liveGetPos() + 90;
      } else {
        t = parseFmt(timeInput.value);
        if (isNaN(t)) { showToast("Invalid time"); return; }
      }
      if (liveSeekTo(t)) showToast("Jumped to " + fmt(t));
      else showToast("Player not found");
    };
    timeInput.addEventListener("keydown", e => { if (e.key === "Enter") jumpBtn.click(); });
    attachAutoFormat(timeInput);
    quickRow.append(timeInput, jumpBtn);
    body.appendChild(quickRow);

    const div1 = document.createElement("div");
    Object.assign(div1.style, { borderTop: "1px solid #2a2a4a", marginBottom: "6px" });
    body.appendChild(div1);

    const saveLabel = document.createElement("div");
    saveLabel.textContent = "Save segment";
    Object.assign(saveLabel.style, { color: "#adb5bd", fontSize: "12px", marginBottom: "4px", fontWeight: "bold" });
    body.appendChild(saveLabel);

    const typeSelect = document.createElement("select");
    Object.assign(typeSelect.style, {
      width: "100%", marginBottom: "4px", padding: "3px", height: "30px",
      background: "#0f3460", color: "#e0e0e0", border: "none", borderRadius: "4px", fontSize: "13px", fontWeight: "bold",
    });
    for (const [k, v] of Object.entries(TYPES)) {
      const o = document.createElement("option"); o.value = k; o.textContent = v.label;
      typeSelect.appendChild(o);
    }
    body.appendChild(typeSelect);

    function timeRow(placeholder) {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "3px", marginBottom: "4px" });
      const inp = document.createElement("input");
      inp.type = "text"; inp.placeholder = placeholder;
      Object.assign(inp.style, {
        flex: "1", padding: "3px 5px", background: "#0f3460", color: "#e0e0e0", marginBottom: "0",
        border: "none", borderRadius: "4px", fontSize: "13px", fontWeight: "bold", height: "30px",
      });
      const nowBtn = document.createElement("button");
      nowBtn.textContent = "Now";
      Object.assign(nowBtn.style, {
        justifyContent: "center", alignItems: "center", display: "flex",
        padding: "2px 6px", background: "#0f3460", color: "#adb5bd", marginBottom: "0", height: "30px",
        border: "1px solid #2a2a4a", borderRadius: "4px", cursor: "pointer", fontSize: "12px", fontWeight: "bold",
      });
      nowBtn.onclick = () => {
        const pos = liveGetPos();
        if (pos !== null) inp.value = fmt(pos);
        else showToast("Player not found");
      };
      row.append(inp, nowBtn);
      return { row, inp };
    }

    const { row: startRow, inp: inStart } = timeRow("Start");
    const { row: endRow,   inp: inEnd   } = timeRow("End");
    attachAutoFormat(inStart);
    attachAutoFormat(inEnd);
    body.append(startRow, endRow);

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save Segment";
    Object.assign(saveBtn.style, {
      width: "100%", padding: "5px", background: "#06d6a0", color: "#fff",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px", marginBottom: "6px",
    });
    saveBtn.onclick = () => {
      const s = inStart.value.trim() ? parseFmt(inStart.value) : 0;
      const e = inEnd.value.trim() ? parseFmt(inEnd.value) : liveDur();
      if (isNaN(s) || isNaN(e) || e <= s) { showToast("Check start / end times"); return; }
      const segs = loadSegs();
      segs.push({ type: typeSelect.value, start: s, end: e });
      saveSegs(segs);
      inStart.value = ""; inEnd.value = "";
      refreshTimeline(loadSegs(), liveDur());
      renderList();
      showToast("Segment saved");
    };
    body.appendChild(saveBtn);

    const typesLabel = document.createElement("div");
    typesLabel.textContent = "Auto-skip these:";
    Object.assign(typesLabel.style, { color: "#adb5bd", fontSize: "12px", marginBottom: "4px", fontWeight: "bold" });
    body.appendChild(typesLabel);

    const typesFlex = document.createElement("div");
    Object.assign(typesFlex.style, { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "6px" });
    for (const [k, v] of Object.entries(TYPES)) {
      const lblWrap = document.createElement("label");
      Object.assign(lblWrap.style, {
        display: "flex", alignItems: "center", gap: "3px",
        cursor: "pointer", fontSize: "13px", color: "#e0e0e0", fontWeight: "bold"
      });
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = !!skipTypes[k];
      Object.assign(chk.style, { margin: "0", accentColor: v.color });
      const chkLabel = document.createElement("span");
      chkLabel.textContent = v.label;
      lblWrap.append(chk, chkLabel);
      chk.onchange = () => {
        skipTypes[k] = chk.checked;
        saveSkipTypes(skipTypes);
      };
      typesFlex.appendChild(lblWrap);
    }
    body.appendChild(typesFlex);

    const div2 = document.createElement("div");
    Object.assign(div2.style, { borderTop: "1px solid #2a2a4a", marginBottom: "5px" });
    body.appendChild(div2);

    const listEl = document.createElement("div");
    Object.assign(listEl.style, { maxHeight: "110px", overflowY: "auto" });
    body.appendChild(listEl);

    function renderList() {
      listEl.innerHTML = "";
      const segs = loadSegs();
      if (!segs.length) {
        const empty = document.createElement("div");
        empty.textContent = "No segments yet";
        Object.assign(empty.style, { color: "#6c757d", fontSize: "12px", padding: "2px 0", fontWeight: "bold" });
        listEl.appendChild(empty); return;
      }
      const fragment = document.createDocumentFragment();
      segs.forEach((seg, i) => {
        const r = document.createElement("div");
        Object.assign(r.style, {
          display: "flex", alignItems: "center", gap: "6px",
          padding: "3px 4px", borderBottom: "1px solid #16213e",
          flexWrap: "nowrap", minHeight: "26px"
        });

        function commitEdit(newType, newStart, newEnd) {
          const s = loadSegs();
          s[i] = { type: newType, start: newStart, end: newEnd };
          saveSegs(s);
          refreshTimeline(loadSegs(), liveDur());
          renderList();
        }
        // === BADGE [OP] ===
        const badge = document.createElement("span");
        badge.textContent = TYPES[seg.type]?.label || seg.type;
        Object.assign(badge.style, {
          background: TYPES[seg.type]?.color || "#555", color: "#fff",
          padding: "2px 7px", borderRadius: "4px", fontSize: "13px",
          fontWeight: "bold", whiteSpace: "nowrap", height: "22px",
          lineHeight: "18px", display: "flex", alignItems: "center", cursor: "pointer"
        });
        badge.title = "Click to change type";
        badge.onclick = () => {
          timeSpan.style.display = "none";
          const picker = document.createElement("div");
          Object.assign(picker.style, { display: "flex", flexWrap: "wrap", gap: "2px" });
          for (const [k, v] of Object.entries(TYPES)) {
            const opt = document.createElement("span");
            opt.textContent = v.label;
            Object.assign(opt.style, {
              background: k === seg.type ? v.color : "#2a2a4a",
              color: "#fff", padding: "1px 5px", borderRadius: "3px",
              fontSize: "13px", fontWeight: "bold", cursor: "pointer", whiteSpace: "nowrap",
            });
            opt.onmousedown = e => { e.preventDefault(); commitEdit(k, seg.start, seg.end); };
            picker.appendChild(opt);
          }
          badge.replaceWith(picker);
          delBtn.style.display = "none";
          const cancel = e => { if (!r.contains(e.target)) { document.removeEventListener("mousedown", cancel); renderList(); } };
          setTimeout(() => document.addEventListener("mousedown", cancel), 0);
        };

        // === TIMELINE — click to edit start/end ===
        const timeSpan = document.createElement("span");
        timeSpan.textContent = fmt(seg.start) + " – " + fmt(seg.end);
        Object.assign(timeSpan.style, {
          flex: "1", fontSize: "12.5px", color: "#adb5bd", fontWeight: "bold",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          height: "22px", lineHeight: "18px", display: "flex", alignItems: "center", cursor: "pointer"
        });
        timeSpan.title = "Click to edit times";
        timeSpan.onclick = () => {
          const editRow = document.createElement("div");
          Object.assign(editRow.style, { display: "flex", gap: "3px", flex: "1", alignItems: "center" });

          const mkInp = val => {
            const inp = document.createElement("input");
            inp.type = "text"; inp.value = fmt(val);
            Object.assign(inp.style, {
              width: "52px", padding: "2px 4px", background: "#0f3460", color: "#e0e0e0", marginBottom: "0",
              border: "none", borderRadius: "4px", fontSize: "12px", fontWeight: "bold", height: "22px"
            });
            attachAutoFormat(inp);
            return inp;
          };

          const inS = mkInp(seg.start);
          const inE = mkInp(seg.end);
          const sep = document.createElement("span");
          sep.textContent = "–";
          Object.assign(sep.style, { color: "#adb5bd", fontSize: "12px" });

          const confirmEdit = () => {
            const s = parseFmt(inS.value), e = parseFmt(inE.value);
            if (isNaN(s) || isNaN(e) || e <= s) { showToast("Check start / end times"); return; }
            commitEdit(seg.type, s, e);
          };
          [inS, inE].forEach(inp => inp.addEventListener("keydown", ev => { if (ev.key === "Enter") confirmEdit(); if (ev.key === "Escape") renderList(); }));

          editRow.append(inS, sep, inE);
          timeSpan.replaceWith(editRow);
          delBtn.textContent = "v";
          Object.assign(delBtn.style, { background: "#06d6a0" });
          delBtn.onclick = confirmEdit;
          inS.focus();
        };

        const delBtn = document.createElement("button");
        delBtn.textContent = "×";
        Object.assign(delBtn.style, {
          padding: "2px 8px", background: "#e63946", color: "#fff",
          border: "none", borderRadius: "4px", cursor: "pointer",
          fontSize: "13px", fontWeight: "bold", height: "22px",
          lineHeight: "18px", display: "flex", alignItems: "center",
          justifyContent: "center", minWidth: "22px", margin: "0", marginBottom: "0"
        });
        delBtn.onclick = () => {
          const s = loadSegs();
          s.splice(i, 1);
          saveSegs(s);
          refreshTimeline(loadSegs(), liveDur());
          renderList();
        };

        r.append(badge, timeSpan, delBtn);
        fragment.appendChild(r);
      });
      listEl.appendChild(fragment);
    }

    /* Upstream + IO (unchanged) */
    const urlDiv = document.createElement("div");
    Object.assign(urlDiv.style, { marginTop: "6px", borderTop: "1px solid #2a2a4a", paddingTop: "6px" });

    const urlLabel = document.createElement("div");
    urlLabel.textContent = "JSON URL";
    Object.assign(urlLabel.style, { color: "#adb5bd", fontSize: "12px", marginBottom: "3px", fontWeight: "bold" });

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = "https://exam.ple/aniskip.json";
    urlInput.value = GM_getValue("upstream_url", "");
    Object.assign(urlInput.style, {
      width: "100%", padding: "4px 6px", background: "#0f3460", color: "#e0e0e0",
      border: "none", borderRadius: "4px", fontSize: "13px",
      boxSizing: "border-box", marginBottom: "4px",
    });
    urlInput.addEventListener("change", () => GM_setValue("upstream_url", urlInput.value.trim()));

    const overrideWrap = document.createElement("label");
    Object.assign(overrideWrap.style, {
      display: "flex", alignItems: "center", gap: "4px",
      marginBottom: "4px", cursor: "pointer", fontSize: "12px", color: "#adb5bd", fontWeight: "bold"
    });
    const overrideChk = document.createElement("input");
    overrideChk.type = "checkbox";
    const ovText = document.createElement("span");
    ovText.textContent = "Override";
    overrideWrap.append(overrideChk, ovText);

    const syncRow = document.createElement("div");
    Object.assign(syncRow.style, { display: "flex", gap: "4px", marginBottom: "4px" });

    const syncBtn = document.createElement("button");
    syncBtn.textContent = "Sync";
    Object.assign(syncBtn.style, {
      flex: "1", padding: "5px", background: "#06d6a0", color: "#1a1a2e",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontWeight: "bold", fontSize: "13px", marginBottom: "2px",
    });
    syncBtn.onclick = async () => {
      const url = urlInput.value.trim();
      if (!url) { showToast("Enter a URL first"); return; }
      syncBtn.textContent = "…";
      try {
        const res = await fetch(url + "?_=" + Date.now());
        if (!res.ok) throw new Error(res.status);
        const parsed = await res.json();
        GM_setValue("upstream_snapshot", JSON.stringify(parsed));
        const override = overrideChk.checked;
        const r = mergeInto(parsed, override);
        refreshTimeline(loadSegs(), liveDur());
        renderList();
        showToast("Synced +" + r.added + " new, " + r.skipped + " skipped" + (override ? " (override)" : ""));
      } catch (e) { showToast("Sync failed: " + e.message); }
      syncBtn.textContent = "Sync";
    };

    const diffBtn = document.createElement("button");
    diffBtn.textContent = "Export diff";
    Object.assign(diffBtn.style, {
      flex: "1", padding: "5px", background: "#f77f00", color: "#fff", marginBottom: "2px",
      border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontWeight: "bold",
    });
    diffBtn.onclick = () => {
      let upstream = {};
      try { upstream = JSON.parse(GM_getValue("upstream_snapshot", "{}")); } catch (_) {}
      const local = getAllLocal();
      const diff = {};
      for (const [key, segs] of Object.entries(local)) {
        const upSegs = upstream[key] || [];
        const newSegs = segs.filter(s => !upSegs.some(u => u.start === s.start && u.end === s.end));
        if (newSegs.length) diff[key] = newSegs;
      }
      if (!Object.keys(diff).length) { showToast("No new segments vs upstream"); return; }
      download("aniskipDiff.json", JSON.stringify(diff, null, 2));
      showToast("Exported " + Object.keys(diff).length + " episode(s) with new segments");
    };

    syncRow.append(syncBtn, diffBtn);
    urlDiv.append(urlLabel, urlInput, overrideWrap, syncRow);
    body.appendChild(urlDiv);

    const ioRow = document.createElement("div");
    Object.assign(ioRow.style, { display: "flex", gap: "4px", marginTop: "2px" });

    const exportBtn = document.createElement("button");
    exportBtn.textContent = "Export all";
    Object.assign(exportBtn.style, {
      flex: "1", padding: "5px", background: "#0f3460", color: "#e0e0e0", marginBottom: "2px",
      border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontWeight: "bold",
    });
    exportBtn.onclick = () => {
      const all = getAllLocal();
      download("aniskip.json", JSON.stringify(all, null, 2));
      showToast("Exported " + Object.keys(all).length + " episode(s)");
    };

    const importBtn = document.createElement("button");
    importBtn.textContent = "Import file";
    Object.assign(importBtn.style, {
      flex: "1", padding: "5px", background: "#0f3460", color: "#e0e0e0", marginBottom: "2px",
      border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontWeight: "bold",
    });
    importBtn.onclick = () => {
      const fileInput = document.createElement("input");
      fileInput.type = "file"; fileInput.accept = ".json";
      fileInput.onchange = () => {
        const file = fileInput.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
          try {
            const parsed = JSON.parse(e.target.result);
            const r = mergeInto(parsed);
            refreshTimeline(loadSegs(), liveDur());
            renderList();
            showToast("Imported +" + r.added + " segs, " + r.skipped + " episode(s) skipped");
          } catch (_) { showToast("Failed to parse file"); }
        };
        reader.readAsText(file);
      };
      fileInput.click();
    };
    ioRow.append(exportBtn, importBtn);
    body.appendChild(ioRow);

    const clearAllBtn = document.createElement("button");
    clearAllBtn.textContent = "Clear ALL";
    Object.assign(clearAllBtn.style, {
      width: "100%", padding: "5px", marginTop: "4px",
      background: "#6c1f1f", color: "#ffaaaa",
      border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "13px", fontWeight: "bold",
    });
    clearAllBtn.onclick = () => {
      if (!confirm("Delete ALL saved segments?")) return;
      clearAll();
      refreshTimeline([], 0);
      renderList();
      showToast("All segment data cleared");
    };
    body.appendChild(clearAllBtn);

    wrap.append(hdr, body);
    document.body.appendChild(wrap);

    renderList();

    let collapsed = true;
    collapseBtn.onclick = () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? "none" : "block";
      collapseBtn.textContent = collapsed ? "+" : "–";
    };

    hdr.addEventListener("mousedown", e => {
    e.preventDefault();
    const MARGIN = 10;
    let px = e.clientX, py = e.clientY;

    const onMove = ev => {
      wrap.style.left   = Math.max(MARGIN, Math.min(wrap.offsetLeft + ev.clientX - px, window.innerWidth  - wrap.offsetWidth  - MARGIN)) + "px";
      wrap.style.top    = Math.max(MARGIN, Math.min(wrap.offsetTop  + ev.clientY - py, window.innerHeight - wrap.offsetHeight - MARGIN)) + "px";
      wrap.style.right  = "auto";
      wrap.style.bottom = "auto";
      px = ev.clientX;
      py = ev.clientY;
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", () => document.removeEventListener("mousemove", onMove), { once: true });
  });

    return renderList;
  }

  function getAllLocal() {
    const all = {};
    for (const key of GM_listValues()) {
      try {
        let segs = JSON.parse(GM_getValue(key, "[]")) || [];
        if (Array.isArray(segs) && segs.length) all[key] = segs;
      } catch (_) {}
    }
    return all;
  }
  function mergeInto(parsed, override = false) {
    let added = 0, skipped = 0;
    const entries = Array.isArray(parsed) ? [[storeKey(), parsed]] : Object.entries(parsed);
    for (const [key, usegs] of entries) {
      if (!Array.isArray(usegs)) continue;
      let existing = [];
      try { existing = JSON.parse(GM_getValue(key, "[]")) || []; } catch (_) {}
      if (override || existing.length === 0) {
        GM_setValue(key, JSON.stringify(usegs));
        added += usegs.length;
      } else {
        let newAdded = 0;
        for (const seg of usegs) {
          if (!existing.some(x => x.start === seg.start && x.end === seg.end)) {
            existing.push(seg);
            newAdded++;
          }
        }
        GM_setValue(key, JSON.stringify(existing));
        if (newAdded > 0) added += newAdded;
        else skipped++;
      }
    }
    return { added, skipped };
  }
  function clearAll() {
    for (const key of GM_listValues()) GM_deleteValue(key);
  }
  function download(filename, data) {
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function waitForBody(cb) {
    if (document.body) { cb(); return; }
    new MutationObserver((_, obs) => { if (document.body) { obs.disconnect(); cb(); } })
      .observe(document.documentElement, { childList: true });
  }

  waitForBody(() => {
    skipTypes = loadSkipTypes();
    buildWidget();

    setInterval(() => {
      const dur = liveDur();
      if (dur > 0) refreshTimeline(loadSegs(), dur);
    }, 100);

    setInterval(() => {
      if (Date.now() - lastSkip < SKIP_COOL) return;
      const pos = liveGetPos();
      if (pos === null) return;
      const segs = loadSegs();
      for (const seg of segs) {
        if (!(skipTypes[seg.type] ?? true)) continue;
        if (pos >= seg.start && pos < seg.end) {
          lastSkip = Date.now();
          liveSeekTo(seg.end);
          showToast("Skipped " + (TYPES[seg.type]?.label || seg.type));
          break;
        }
      }
    }, 250);

    detectPlayer((jwp, videoEl) => {
      initEngine(jwp, videoEl);
      const inp = document.querySelector("#avs-widget input");
      if (inp) inp.placeholder = "MM:SS";
      refreshTimeline(loadSegs(), liveDur());
    });
  });
})();
