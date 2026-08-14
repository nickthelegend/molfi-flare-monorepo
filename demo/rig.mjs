#!/usr/bin/env node
/**
 * Demo rig: a local signer + an injecting proxy in front of the Next dev server.
 *
 * Why a proxy rather than injecting after load: wagmi discovers wallets during
 * app init, so a provider installed by a post-load script is simply never seen.
 * The shim has to exist before the bundle runs, which means it has to come down
 * inside the HTML.
 *
 * The page never holds the key. `eth_sendTransaction` is forwarded to the signer
 * on SIGNER_PORT, which signs with the Coston2 demo key and broadcasts for real —
 * so every signature in the take is a genuine testnet signature, and the only
 * thing bypassed is the confirmation dialog.
 *
 *   node demo/rig.mjs        # serves :3010 -> :3001, signer on :4210
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, createPublicClient, http as viemHttp, hexToBigInt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = { host: "127.0.0.1", port: Number(process.env.APP_PORT ?? 8090) };
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3010);
const SIGNER_PORT = Number(process.env.SIGNER_PORT ?? 4210);
const RPC = process.env.FLARE_RPC ?? "https://coston2-api.flare.network/ext/C/rpc";


const SIGNER_URL = process.env.SIGNER_URL ?? "http://127.0.0.1:4201/";
if (flareTestnet.id !== 114) throw new Error("refusing to run: chain is not Coston2");
const pub = createPublicClient({ chain: flareTestnet, transport: viemHttp(RPC) });

// ── injected EIP-1193 shim ────────────────────────────────────────────────────
const shim = (addr, signerUrl) => `<script>(function(){
  var listeners = {};
  var provider = {
    isMolfiDemo: true, chainId: "0x72",
    selectedAddress: ${JSON.stringify(addr)},
    request: function(args){
      var m = args && args.method, p = (args && args.params) || [];
      if (m === "eth_accounts" || m === "eth_requestAccounts") return Promise.resolve([${JSON.stringify(addr)}]);
      if (m === "eth_chainId") return Promise.resolve("0x72");
      return fetch(${JSON.stringify(signerUrl)}, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: m, params: p })
      }).then(function(r){ return r.json(); }).then(function(j){
        if (j.error) { var e = new Error(j.error.message); e.code = j.error.code; throw e; }
        // Record transaction hashes HERE, in the provider itself.
        //
        // Patching window.ethereum.request from the driver looks equivalent and
        // is not: viem's custom() transport captures the request function when
        // the connector is built, which happens long before the driver is
        // injected — so a later patch on the object is never called, and the
        // take reported zero transactions while really sending them. The shim
        // is the thing that actually talks to the signer, so it cannot be
        // bypassed the same way.
        if (/^eth_send(Raw)?Transaction$/.test(m) &&
            typeof j.result === "string" && /^0x[0-9a-f]{64}$/i.test(j.result)) {
          (window.__DEMO_TX = window.__DEMO_TX || []).push(j.result);
        }
        return j.result;
      });
    },
    on: function(ev, fn){ (listeners[ev] = listeners[ev] || []).push(fn); return provider; },
    removeListener: function(){ return provider; },
    enable: function(){ return provider.request({ method: "eth_requestAccounts" }); },
    send: function(m, p){ return provider.request({ method: m, params: p }); },
    sendAsync: function(pl, cb){ provider.request(pl).then(function(r){ cb(null, { id: pl.id, jsonrpc: "2.0", result: r }); }, cb); }
  };
  window.ethereum = provider;
  window.dispatchEvent(new Event("ethereum#initialized"));
  var info = { uuid: "hadal-demo-0000-0000-000000000001", name: "Molfi Test Wallet", rdns: "dev.molfi.testwallet",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiNmNjg1MWIiLz48L3N2Zz4=" };
  function announce(){ window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: info, provider: provider }) })); }
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  // Nothing native may steal the capture.
  window.alert = window.confirm = window.prompt = function(){};
})();</script>`;

const API_PORT = Number(process.env.API_PORT ?? 4100);

const proxy = http.createServer((req, res) => {
  // Same-origin passthrough to the enclave service. The driver fetches these
  // endpoints directly to build its JSON slides, and a cross-origin fetch from
  // the proxy origin is refused by CORS — which kills the take mid-beat.
  if (req.url.startsWith("/__api/")) {
    const t = http.request(
      { host: "127.0.0.1", port: API_PORT, path: req.url.replace("/__api", ""), method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` } },
      (tr) => { res.writeHead(tr.statusCode, tr.headers); tr.pipe(res); },
    );
    t.on("error", (e) => { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e) })); });
    return req.pipe(t);
  }
  const up = http.request(
    { host: UPSTREAM.host, port: UPSTREAM.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}`, "accept-encoding": "identity" } },
    (ur) => {
      if (!String(ur.headers["content-type"] || "").includes("text/html")) {
        res.writeHead(ur.statusCode, ur.headers);
        return ur.pipe(res);
      }
      const chunks = [];
      ur.on("data", (c) => chunks.push(c));
      ur.on("end", () => {
        let html = Buffer.concat(chunks).toString("utf8");
        html = html.replace(/<head(\s[^>]*)?>/i, (m) => m + shim(DEMO_ADDR, SIGNER_URL));
        const h = { ...ur.headers };
        delete h["content-length"];
        delete h["content-encoding"];
        res.writeHead(ur.statusCode, h);
        res.end(html);
      });
    },
  );
  up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});
// A client that goes away mid-stream — Chrome being killed at the end of a
// take, a websocket dropped on reload — makes the raw socket emit 'error'. With
// no listener that is an unhandled 'error' event, which takes the whole rig
// down: ECONNRESET, process exits, and the next take loads chrome-error://
// because nothing is serving 3020 any more. Sockets must never be fatal.
proxy.on("clientError", (_e, socket) => { try { socket.destroy(); } catch {} });
proxy.on("connection", (socket) => socket.on("error", () => {}));

proxy.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  const up = http.request({ host: UPSTREAM.host, port: UPSTREAM.port, path: req.url, method: req.method, headers: req.headers });
  up.on("upgrade", (ur, us, uh) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\n" + Object.entries(ur.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    if (uh?.length) socket.write(uh);
    us.on("error", () => { try { socket.destroy(); } catch {} });
    us.pipe(socket); socket.pipe(us);
  });
  up.on("error", () => socket.destroy());
  if (head?.length) up.write(head);
  up.end();
});

const DEMO_ADDR = (await (await fetch(SIGNER_URL, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }) })).json()).result[0];
{
  const bal = await pub.getBalance({ address: DEMO_ADDR });
  console.log(`[rig] demo wallet ${DEMO_ADDR}  ${(Number(bal) / 1e18).toFixed(3)} C2FLR  (Coston2 ${flareTestnet.id})`);
  console.log(`[rig] signer  ${SIGNER_URL}`);
}
proxy.listen(PROXY_PORT, () => console.log(`[rig] app     http://127.0.0.1:${PROXY_PORT} -> :${UPSTREAM.port}`));
