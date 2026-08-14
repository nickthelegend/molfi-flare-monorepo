/**
 * Phase 3 driver — runs inside the page, self-paced against measured audio.
 *
 * Injected once and left to run; it never blocks on the tool that started it.
 * Marks land on window.__MARKS and on the console as `DEMO_LINE <ms> <id>` so a
 * mark exists even if the harness that injected it goes away.
 *
 * Everything here is real: real DOM events, real wagmi writes, real receipts.
 * The only synthetic thing on screen is the cursor, because the hardware cursor
 * jumps and can be stolen by a notification mid-take.
 */
(function () {
  if (window.__MOLFI_DRIVER__) return "already running";
  window.__MOLFI_DRIVER__ = true;

  const D = (window.__DURATIONS__ = window.__DURATIONS__ || {});
  const MARKS = (window.__MARKS = []);
  // sessionStorage throws SecurityError on a document that has no storage
  // origin (about:blank between navigations, or a sandboxed frame). At module
  // scope that killed the whole driver before its first line ran — and the take
  // came back "0 beats, 0 errors" with no clue why. Never let storage be fatal.
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* no storage origin */ } },
  };
  const RESUME = Number(ss.get("__demo_t0_offset") || 0);
  const T0 = performance.now() - RESUME;
  const BREATH = 450;
  const state = (window.__DEMO = { beat: null, done: false, error: null, txs: {} });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const byText = (re, sels = "button,a,[role=button]") =>
    [...document.querySelectorAll(sels)].find((e) => re.test((e.innerText || "").trim()));

  // ── cursor + click ring ────────────────────────────────────────────────────
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("style", "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000");
  const ring = document.createElementNS(ns, "circle");
  ring.setAttribute("r", "0"); ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "#7dd3fc"); ring.setAttribute("stroke-width", "2");
  const dot = document.createElementNS(ns, "path");
  dot.setAttribute("d", "M0,0 L0,17 L4.5,12.8 L7.4,19.2 L10.2,17.9 L7.3,11.6 L13,11.3 Z");
  dot.setAttribute("fill", "#fff"); dot.setAttribute("stroke", "#0b0f14"); dot.setAttribute("stroke-width", "1.2");
  svg.append(ring, dot);
  document.documentElement.appendChild(svg);
  let cx = innerWidth / 2, cy = innerHeight / 2;
  const place = () => dot.setAttribute("transform", `translate(${cx},${cy})`);
  place();

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  /** Always settles. requestAnimationFrame is paused while the window is
   *  occluded or backgrounded, so an rAF-only loop hangs the take forever with
   *  no error to catch — one run burned its entire 10m budget that way. */
  const bounded = (fn, ms) =>
    new Promise((res) => {
      let done = false;
      const finish = () => { if (!done) { done = true; res(); } };
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, ((now ?? performance.now()) - t0) / ms);
        fn(t);
        if (t < 1 && !done) requestAnimationFrame(step);
        else finish();
      };
      requestAnimationFrame(step);
      setTimeout(() => { fn(1); finish(); }, ms + 400);
    });
  function glide(x, y, ms = 620) {
    const sx = cx, sy = cy;
    return bounded((t) => { const e = easeInOut(t); cx = sx + (x - sx) * e; cy = sy + (y - sy) * e; place(); }, ms);
  }
  async function clickRing() {
    ring.setAttribute("cx", cx); ring.setAttribute("cy", cy);
    await bounded((t) => {
      ring.setAttribute("r", String(4 + 26 * t));
      ring.setAttribute("opacity", String(1 - t));
    }, 420);
    ring.setAttribute("r", "0");
  }
  const centerOf = (el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  async function clickEl(el, ms = 620) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(420);
    const [x, y] = centerOf(el);
    await glide(x, y, ms);
    await clickRing();
    el.click();
  }

  // ── typing ─────────────────────────────────────────────────────────────────
  const setNative = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, v);
  };
  async function typeInto(el, text) {
    el.focus();
    setNative(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    let acc = "";
    for (const ch of text) {
      acc += ch;
      setNative(el, acc);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(1000 / 24 + (Math.random() * 26 - 8));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ── real-state polling with a NAMED failure ────────────────────────────────
  async function until(label, pred, timeoutMs = 180000) {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = await pred(); } catch { ok = false; }
      if (ok) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(`TIMEOUT[${label}] after ${timeoutMs}ms`);
      await sleep(400);
    }
  }

  // ── beat clock ─────────────────────────────────────────────────────────────
  let beatStart = 0;
  function line(id) {
    const ms = Math.round(performance.now() - T0);
    ss.set("__demo_last_beat", id);
    ss.set("__demo_t0_offset", String(ms));
    state.beat = id; beatStart = performance.now();
    const signing = /-sign$/.test(id);
    MARKS.push({ id, ms, signing });
    console.log(`DEMO_LINE ${ms} ${id}${signing ? " SIGNING" : ""}`);
  }
  async function hold() {
    const need = (D[state.beat] ?? 4) * 1000 + BREATH;
    const spent = performance.now() - beatStart;
    if (spent < need) await sleep(need - spent);
  }

  // ── overlays ───────────────────────────────────────────────────────────────
  function overlay(html, bg = "#050a12") {
    let o = document.getElementById("__demo_overlay");
    if (!o) {
      o = document.createElement("div");
      o.id = "__demo_overlay";
      o.style.cssText =
        "position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;" +
        "flex-direction:column;gap:18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6f1ff;" +
        "padding:6vh 6vw;text-align:left;transition:opacity .28s ease";
      document.documentElement.appendChild(o);
    }
    o.style.background = bg;
    o.style.opacity = "1";
    o.innerHTML = html;
    return o;
  }
  const hideOverlay = () => {
    const o = document.getElementById("__demo_overlay");
    if (o) { o.style.opacity = "0"; setTimeout(() => o.remove(), 320); }
  };
  const signingOverlay = () =>
    overlay(
      '<div style="font-size:34px;letter-spacing:.14em;text-transform:uppercase;opacity:.95">Signing Transaction</div>' +
        '<div style="font-size:15px;opacity:.6">Flare Coston2 · waiting for on-chain confirmation</div>',
      "#0a1a2f",
    );
  function slide(title, json, note) {
    const body = typeof json === "string" ? json : JSON.stringify(json, null, 2);
    overlay(
      `<div style="font-size:13px;letter-spacing:.2em;text-transform:uppercase;opacity:.55">${title}</div>` +
        `<pre style="max-height:62vh;overflow:auto;font-size:15px;line-height:1.55;background:#0b1220;border:1px solid #1e2a3d;border-radius:12px;padding:22px 26px;white-space:pre-wrap;word-break:break-word;max-width:1100px">${body.replace(/[<&]/g, (c) => ({ "<": "&lt;", "&": "&amp;" })[c])}</pre>` +
        (note ? `<div style="font-size:15px;opacity:.7;max-width:1000px">${note}</div>` : ""),
    );
  }

  const API = "/__api/api"; // same-origin via the rig; a cross-origin fetch is refused by CORS
  const getJson = async (u) => (await fetch(u)).json();
  const EXPLORER = "https://coston2-explorer.flare.network";

  /**
   * How a sealed bid is actually sealed — built on screen, step by step.
   *
   * The take is captured from page frames now, so CSS animation records
   * cleanly: each stage of the flow arrives in turn and a packet travels the
   * path, which explains custody of the key far better than a static diagram.
   */
  function sealFlow() {
    const step = (n, icon, title, body) => `
      <div class="sf-step" style="--d:${n * 0.55}s">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:38px;height:38px;border-radius:10px;flex:none;display:flex;align-items:center;
               justify-content:center;background:#151d2e;border:1px solid #2a3550;font-size:19px">${icon}</div>
          <div>
            <div style="font-size:19px;font-weight:600;letter-spacing:.01em">${title}</div>
            <div style="font-size:15px;opacity:.62;margin-top:3px;line-height:1.45">${body}</div>
          </div>
        </div>
      </div>`;
    overlay(
      `<style>
        @keyframes sfIn { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:none } }
        @keyframes sfLine { from { height:0 } to { height:26px } }
        @keyframes sfPacket { 0% { top:0; opacity:0 } 8% { opacity:1 } 92% { opacity:1 } 100% { top:100%; opacity:0 } }
        @keyframes sfPulse { 0%,100% { box-shadow:0 0 0 0 rgba(139,92,246,.45) } 50% { box-shadow:0 0 0 14px rgba(139,92,246,0) } }
        .sf-step { opacity:0; animation:sfIn .6s cubic-bezier(.2,.7,.3,1) forwards; animation-delay:var(--d) }
        .sf-rail { width:2px; background:linear-gradient(#2a3550,#8b5cf6); margin:6px 0 6px 18px;
                   animation:sfLine .5s ease forwards; animation-delay:var(--d) }
      </style>
      <div style="font-size:13px;letter-spacing:.2em;text-transform:uppercase;opacity:.55">
        How a sealed bid stays sealed</div>
      <div style="position:relative;display:flex;flex-direction:column;max-width:920px;width:100%">
        <div style="position:absolute;left:18px;top:0;bottom:0;width:2px;overflow:hidden">
          <div style="position:absolute;left:-3px;width:8px;height:8px;border-radius:50%;background:#8b5cf6;
               animation:sfPacket 3.4s ease-in-out 2.2s infinite"></div>
        </div>
        ${step(0, "🖥", "Your browser seals the side",
          "The YES/NO is encrypted to the enclave's public key before it leaves the page. The stake stays public; the side does not.")}
        <div class="sf-rail" style="--d:.55s"></div>
        ${step(1, "⛓", "Ciphertext goes on-chain",
          "SealedBidBook stores an opaque blob. Nothing on Coston2 can tell you which way the bid leaned.")}
        <div class="sf-rail" style="--d:1.1s"></div>
        ${step(2, "🔒", "Only the enclave holds the key",
          "A Flare Confidential Compute image on Phala's dstack — memory the CPU keeps encrypted, registered on FlareTeeManager and reachable at status 2.")}
        <div class="sf-rail" style="--d:1.65s"></div>
        ${step(3, "✍️", "It opens the book and signs the total",
          "At close the enclave decrypts every bid, aggregates, and signs the result with its own key.")}
        <div class="sf-rail" style="--d:2.2s"></div>
        ${step(4, "✅", "The contract checks that signature",
          "ecrecover against the registered teeSigner. A total nobody in the enclave signed is simply not accepted.")}
      </div>`,
    );
  }

  /** A points card — same chrome as `slide`, for prose rather than JSON. */
  function points(title, items, note) {
    overlay(
      `<div style="font-size:13px;letter-spacing:.2em;text-transform:uppercase;opacity:.55">${title}</div>` +
        `<div style="display:flex;flex-direction:column;gap:18px;max-width:1000px">` +
        items.map((it) =>
          `<div style="display:flex;gap:16px;align-items:flex-start">` +
          `<div style="width:7px;height:7px;border-radius:50%;background:#8b5cf6;margin-top:11px;flex:none"></div>` +
          `<div style="font-size:23px;line-height:1.5">${it}</div></div>`).join("") +
        `</div>` +
        (note ? `<div style="font-size:15px;opacity:.7;max-width:1000px">${note}</div>` : ""),
    );
  }

  /**
   * Transaction hashes, taken from the wallet itself.
   *
   * There is no anchor to scrape: the app surfaces a transaction as a toast
   * whose action calls window.open(), so the DOM never holds the full hash —
   * the visible text is truncated to `0x1234ab…abcdef`. Reading the value the
   * provider returned is both simpler and exact.
   */
  // Filled by the rig's provider shim (see rig.mjs) as each send returns.
  const txHashes = () => window.__DEMO_TX || [];
  let reportedTx = 0;
  const reportTx = () => {
    const all = txHashes();
    while (reportedTx < all.length) console.log(`DEMO_TX ${all[reportedTx++]}`);
  };

  // Swallow window.open. The toast's "Explorer ↗" action would otherwise throw
  // a browser window over the capture mid-take; the recorder is the only thing
  // allowed to open one, at a geometry that matches the frame.
  window.open = () => null;

  const lastTxUrl = () => {
    reportTx();
    const all = txHashes();
    return all.length ? `${EXPLORER}/tx/${all[all.length - 1]}` : null;
  };

  /**
   * Hand a URL to the recorder, which opens it in a window sized exactly like
   * the app's and closes it when this beat ends.
   *
   * The driver deliberately does NOT navigate there itself: a document-level
   * navigation destroys this script mid-take, which is the failure that ate
   * several earlier runs. Showing the page in a separate window keeps the app —
   * and the take's clock — intact.
   */
  async function explorerBeat(url) {
    if (!url) throw new Error("NO_TX_URL");
    console.log(`DEMO_EXPLORER ${url}`);
    await hold();
    console.log("DEMO_EXPLORER_DONE");
    await sleep(400);            // let the window close before the next beat paints
  }

  // ── the take ───────────────────────────────────────────────────────────────
  async function run() {
    // SPA navigation only. A hard location.href reload tears down this driver
    // mid-take — TanStack Router listens for popstate, so pushState keeps the
    // run (and its clock) alive across every route change.
    // Navigate by clicking the real links.
    //
    // history.pushState + a synthetic popstate does NOT drive TanStack Router
    // from a cold start — three takes died on it, the last one sitting on the
    // landing hero for 45s while the driver believed it was on /markets. Real
    // clicks are also what a demo should show.
    const linkTo = (p) =>
      [...document.querySelectorAll(`a[href="${p}"]`)].find((a) => a.offsetParent) ||
      [...document.querySelectorAll("a")].find((a) => {
        if (!a.offsetParent) return false;
        // Anchors carry mailto:, tel:, empty and template hrefs — URL() throws
        // on those, and an exception here killed the take at the first nav.
        try { return new URL(a.getAttribute("href") || "", location.href).pathname === p; }
        catch { return false; }
      });

    const arrived = async (p, marker, ms = 20000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await sleep(400);
        if (location.pathname === p && (!marker || marker.test(document.body.innerText))) { await sleep(800); return true; }
      }
      return false;
    };

    const go = async (p, marker) => {
      if (location.pathname === p && (!marker || marker.test(document.body.innerText))) return;

      // pushState FIRST — this is what carried the 17-beat run. Clicking the
      // real link read as more honest but produced a chrome-error:// document,
      // which is the page the last take was actually sitting on: that is why
      // sessionStorage threw, why pushState was refused for origin 'null', and
      // why every later navigation died with no usable error.
      history.pushState({}, "", p);
      dispatchEvent(new PopStateEvent("popstate"));
      if (await arrived(p, marker, 15000)) return;

      const a = linkTo(p);
      if (a) {
        await clickEl(a);
        if (await arrived(p, marker, 15000)) return;
      }
      // Never location.href: a reload destroys this driver and the take ends
      // silently. Fail loudly so the log names the beat instead.
      throw new Error(`NAV_FAILED[${p}]`);
    };

    const MKT = window.__MARKET_ID__;

    line("intro");        await go("/");                       await hold();
    line("markets");      await go("/markets", /Search markets|Ending soon/i);
      await until("market-rows", () => document.querySelector('a[href^="/predictions/"]'), 90000);
      // Connect for real. Clearing persisted state is a required pre-flight and
      // it also wipes wagmi's saved session, so the app boots signed-out and no
      // "Bet on-chain" button exists until we do this. RainbowKit lists our
      // injected provider under "Installed" once it is announced with its own
      // rdns — announcing as io.metamask routes to the MetaMask SDK, which waits
      // forever for an extension that is not there.
      if (!/0x3997/i.test(document.body.innerText)) {
        const si = byText(/^Sign in$/i);
        if (si) {
          await clickEl(si);
          await sleep(1400);
          const pick = byText(/Molfi Test Wallet/i) || byText(/^MetaMask$/i);
          if (pick) await clickEl(pick);
          await until("wallet-connected", () => /0x3997/i.test(document.body.innerText), 60000);
          const close = byText(/^Close$/i); if (close) close.click();
          await sleep(800);
        }
      }
      // Warm the portfolio read now, ~3.5 minutes before the portfolio beat.
      //
      // It walks the escrow for this wallet and the backend keeps a hot address
      // fresh in the background, but the FIRST caller pays for the walk. In the
      // take that bill landed exactly on the portfolio beat: 17s of "Reading
      // your positions from Coston2…" under a line claiming the page shows
      // settled positions and realized P&L. Fire and forget — nothing here
      // waits on it, and the data it primes is refreshed on the server long
      // before the beat that displays it.
      try {
        const who = window.ethereum && window.ethereum.selectedAddress;
        if (who) {
          fetch(`${API}/onchain/positions/${who}`).catch(() => {});
          fetch(`${API}/positions/${who}`).catch(() => {});
        }
      } catch { /* prefetch is best-effort */ }
      await hold();
    line("market-open");
      {
        // Open the market the RECORDER picked, not whatever sits first in the
        // list. The recorder chose one with at least eight minutes of lead;
        // the top row is ordered by ending-soonest, so on a 30-minute boundary
        // it is frequently a market that just closed — landing the take on a
        // detail page with no bet ticket at all ("NO_AMOUNT_INPUT"), or bounced
        // back to the list.
        const want = window.__MARKET_ID__;
        const rows = [...document.querySelectorAll('a[href^="/predictions/"]')].filter((a) => a.offsetParent);
        const row = want ? rows.find((a) => (a.getAttribute("href") || "").includes(want)) : rows[0];
        if (!row && !want) throw new Error("NO_MARKET_ROW");
        // Not on screen (further down the list, or filtered out) — go straight
        // there rather than clicking a market we did not vet.
        if (row) await clickEl(row);
        else await go(`/predictions/${want}`, /Strike/i);
        if (!(await arrived(location.pathname, /Strike/i, 25000))) {
          await until("market-loaded", () => /Strike/i.test(document.body.innerText), 60000);
        }
      }
      await hold();
    line("pool-depth");
      await until("pools", () => /POOL DEPTH/i.test(document.body.innerText), 60000);
      await hold();

    line("ftso-json");    slide("GET /api/health — FTSOv2 feeds", await getJson(API + "/health"),
      "The price shown in the interface is the price settlement uses.");
      await hold(); hideOverlay();

    line("bet-enter");
      const amt = [...document.querySelectorAll("input")].find((i) => i.type === "number" && i.offsetParent);
      if (!amt) throw new Error("NO_AMOUNT_INPUT");
      await typeInto(amt, "0.05");
      await hold();

    line("bet-sign");
      signingOverlay();
      const before = document.body.innerText;
      const betBtn = byText(/^Bet on-chain/i);
      if (!betBtn || betBtn.disabled) throw new Error("BET_BUTTON_UNAVAILABLE");
      const txBefore = txHashes().length;
      betBtn.click();
      // Wait on the WALLET, not on a toast.
      //
      // The success toast lives for nine seconds and its full hash is never in
      // the DOM, so "did a transaction happen" was being inferred from text
      // that may already have gone. The shim records every hash the signer
      // returns; that list only grows when a transaction is genuinely sent.
      await until("bet-confirmed", () => txHashes().length > txBefore, 300000);
      reportTx();
      hideOverlay(); await hold();

    line("bet-result");
      await until("position-shown", () => /YOUR ON-CHAIN POSITION/i.test(document.body.innerText), 90000);
      await hold();

    // The real transaction, on the real explorer. This used to be a text card
    // quoting a URL — which proves nothing. The hash comes from the anchor the
    // ticket just rendered, so it is the bet we watched being signed.
    const publicTx = lastTxUrl();
    if (!publicTx) throw new Error(`NO_TX_URL (wallet recorded ${txHashes().length} sends)`);
    line("explorer-standard");
      await explorerBeat(publicTx);

    line("private-tab");
      const priv = byText(/^Private$/i); if (priv) await clickEl(priv);
      await hold();

    line("private-sign");
      signingOverlay();
      const pAmt = [...document.querySelectorAll("input")].find((i) => i.type === "number" && i.offsetParent);
      // 1, not 0.05. Confidential stakes are fixed-denomination notes — that is
      // the whole point, since a unique amount would identify the bettor — and
      // the smallest note is 1 FXRP. An amount that cannot be decomposed leaves
      // the button correctly disabled.
      if (pAmt) { hideOverlay(); await typeInto(pAmt, "1"); signingOverlay(); }
      await sleep(900);                    // let the plan/pool checks re-run
      const privBtn = byText(/^Bet privately/i);
      if (!privBtn || privBtn.disabled) {
        // Say WHY. "Button unavailable" sent me hunting through disabled
        // conditions when the page was already displaying the reason.
        hideOverlay();
        const why = (document.body.innerText.match(
          /(needs? .*|insufficient .*|amount must .*|pool .*cannot.*|not enough .*)/i) || [])[0];
        throw new Error(`PRIVATE_BUTTON_UNAVAILABLE${why ? ` — page says: ${why.slice(0, 120)}` : ""}`);
      }
      const privBefore = txHashes().length;
      privBtn.click();
      await until("private-confirmed", () => txHashes().length > privBefore, 300000);
      reportTx();
      hideOverlay(); await hold();

    // Distinct from the public one: if the private bet reused the same hash the
    // comparison the narration makes would be a lie, so require a new tx.
    const privateTx = (() => {
      const u = lastTxUrl();
      if (!u || u === publicTx) throw new Error("NO_PRIVATE_TX");
      return u;
    })();
    line("explorer-private");
      await explorerBeat(privateTx);

    line("zk-json");     slide("GET /api/zk/proof — BN254 Groth16", await getJson(API + "/zk/proof"),
      "Public signals: root, nullifier, outcome, recipient. The nullifier is what prevents a second claim.");
      await hold(); hideOverlay();

    line("sealed-tab");
      const seal = byText(/^Sealed$/i); if (seal) await clickEl(seal);
      await hold();

    line("tee-seal");
      sealFlow();
      await hold(); hideOverlay();

    line("tee-key-json"); slide("GET /api/sealed/key — the enclave identity", await getJson(API + "/sealed/key"),
      "Your browser seals your side to this key. teeSigner is the address SealedBidBook checks with ecrecover.");
      await hold(); hideOverlay();

    line("sealed-sign");
      signingOverlay();
      const sAmt = [...document.querySelectorAll("input")].find((i) => i.type === "number" && i.offsetParent);
      if (sAmt) { hideOverlay(); await typeInto(sAmt, "0.05"); signingOverlay(); }
      const sealBtn = byText(/^Seal bid/i);
      if (!sealBtn || sealBtn.disabled) throw new Error("SEAL_BUTTON_UNAVAILABLE");
      const sealBefore = txHashes().length;
      sealBtn.click();
      await until("seal-confirmed", () => txHashes().length > sealBefore, 300000);
      reportTx();
      hideOverlay(); await hold();

    const sealedTx = (() => {
      const u = lastTxUrl();
      if (!u || u === privateTx) throw new Error("NO_SEALED_TX");
      return u;
    })();
    line("explorer-sealed");
      await explorerBeat(sealedTx);

    line("tee-tx-json"); slide("The sealed book + the enclave response", await getJson(API + "/sealed/key"),
      "The stake is public; the YES/NO split does not exist on-chain until the enclave opens it and signs an aggregate.");
      await hold(); hideOverlay();

    line("portfolio");   await go("/portfolio"); await hold();
    line("vault");       await go("/vault");     await hold();
    line("vault-json");  slide("GET /api/vaults — read from MolfiLpVault", await getJson(API + "/vaults"),
      "Share price is unit-priced, so it survives deposits and withdrawals.");
      await hold(); hideOverlay();
    line("leaderboard"); await go("/leaderboard"); await hold();
    line("fdc-json");    slide("GET /api/web2/attestations — FDC verdicts", await getJson(API + "/web2/attestations"),
      "Independent providers reaching consensus, verified on-chain as a Merkle proof.");
      await hold(); hideOverlay();
    line("guide");       await go("/guide"); await hold();

    line("why-flare");   points("Why Flare", [
        "<b>FTSOv2</b> — a settlement price secured by the chain's own validators, not a third-party oracle.",
        "<b>FAssets</b> — FXRP brings real XRP on-chain as collateral worth betting.",
        "<b>Data Connector</b> — any public JSON API becomes a settleable market.",
        "<b>Confidential Compute</b> — somewhere to keep a secret, without trusting an operator.",
      ], "Four enshrined protocols, one validator set — which is why Molfi is contracts rather than integrations.");
      await hold(); hideOverlay();

    line("roadmap");     points("What's next", [
        "XRP settlement through FAssets on Songbird, then Flare mainnet.",
        "Sealed markets opened by a quorum of enclaves rather than a single one.",
        "The Data Connector pointed at sports, elections, and any public API.",
        "Deeper vault liquidity so larger positions clear at the same price.",
      ], "The venue is built and live on Coston2. The next step is scale.");
      await hold(); hideOverlay();

    line("outro");       await go("/"); await hold();
    state.done = true;
    console.log("DEMO_DONE", Math.round(performance.now() - T0));
  }

  run().catch((e) => {
    state.error = String(e.message || e);
    console.error("DEMO_FAILED", state.error);
    overlay(`<div style="font-size:22px;color:#fca5a5">TAKE FAILED</div><div style="opacity:.8">${state.error}</div>`, "#1a0a0a");
  });
  return "driver started";
})();
