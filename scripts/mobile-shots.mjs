/**
 * Mobile screenshots + a MEASURED overflow report, including the battle screen.
 *
 *   node scripts/mobile-shots.mjs [baseUrl] [outDir] [--battle] [--width=390]
 *
 * Why this exists: the battle UI cannot be reviewed by loading a URL — it only exists inside a
 * running battle. This signs in with a dev account (needs the local stack on DEV_LOGIN=1),
 * fills a legal team, starts a practice match and drives it far enough to see the arena, the
 * move menu, the switch list and the log.
 *
 * The overflow report is the point, not the pictures: an element whose right edge is past the
 * viewport is what makes a phone pan sideways, and `overflow-x: clip` on the root hides that
 * from a screenshot by silently cutting the content off instead.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));
const base = positional[0] ?? "http://localhost:5174";
const out = positional[1] ?? "/tmp/mobile-shots";
const WIDTH = Number(flags.find((f) => f.startsWith("--width="))?.split("=")[1] ?? 390);
const HEIGHT = Number(flags.find((f) => f.startsWith("--height="))?.split("=")[1] ?? 844);
const WANT_BATTLE = flags.includes("--battle");
/**
 * --cards walks the gacha section with a STUBBED injected wallet, because every page in it
 * beyond the shop floor renders a "connect" state otherwise — deposit, withdraw, transfer and
 * messages are exactly the screens that never get looked at on a phone. Read-only: the stub
 * answers account/chain queries itself and forwards everything else to a public RPC, and this
 * pass never clicks anything that would sign or send.
 */
const WANT_CARDS = flags.includes("--cards");
/**
 * --reveal drives an actual pack opening against the DEMO backend (slabs/backend/src/demo.ts,
 * real pipeline + mock CC/bridge/minter, no money). The reveal is a full-screen takeover that
 * exists for a few seconds after a purchase, so it cannot be reached by visiting a URL — and it
 * is the centrepiece of a $50-$1000 flow, which makes it the last thing that should go
 * unchecked on a phone.
 */
const WANT_REVEAL = flags.includes("--reveal");
const STUB_RPC = flags.find((f) => f.startsWith("--rpc="))?.split("=")[1]
  ?? "https://rpc.mainnet.chain.robinhood.com";
const STUB_ADDRESS = flags.find((f) => f.startsWith("--as="))?.split("=")[1]
  ?? "0x1111111111111111111111111111111111111111";
/** --desktop drops the touch emulation, so the same run can prove the wide layout still works. */
const DESKTOP = flags.includes("--desktop");
const API = process.env.API_BASE ?? "http://127.0.0.1:8090";
/** Which dev account to sign in as. A battle already in progress keeps /play on the battle
 *  screen, so a second run needs a different account rather than a cleared database. */
const WHO = flags.find((f) => f.startsWith("--who="))?.split("=")[1] ?? "ash";

mkdirSync(out, { recursive: true });

/** Right edge past the viewport, or intrinsically wider than it. */
const MEASURE = () => {
  const vw = window.innerWidth;
  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const style = getComputedStyle(el);
    // An element inside its own horizontal scroller is not a page-level overflow.
    let scroller = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX === "auto" || ps.overflowX === "scroll") { scroller = true; break }
    }
    if (scroller) continue;
    if (style.position === "fixed") continue;
    const over = Math.max(r.right - vw, r.width - vw);
    if (over > 1) {
      const cls = typeof el.className === "string" ? el.className : "";
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: cls.split(/\s+/).filter(Boolean).slice(0, 3).join("."),
        w: Math.round(r.width),
        over: Math.round(over),
      });
    }
  }
  offenders.sort((a, b) => b.over - a.over);

  /*
   * Content hidden INSIDE a horizontal scroller.
   *
   * The offender scan above deliberately ignores anything in a scroll container, because that
   * is a legitimate pattern. But a table that only fits by scrolling is still content a phone
   * user cannot see — the leaderboard's P/L column was off the right edge of its own scroller
   * with nothing to suggest a swipe would reveal it. Report those separately rather than
   * calling the page clean.
   */
  /* Carousels that are MEANT to scroll sideways, and visibly do — a partly-visible next item
     is the affordance. Listed explicitly so everything else still gets reported. */
  const INTENTIONAL = ["roster-strip", "guide__toc-inner", "tb-chips", "opps", "tn__watch"];

  const clipped = [];
  for (const el of document.querySelectorAll("*")) {
    const s = getComputedStyle(el);
    if (s.overflowX !== "auto" && s.overflowX !== "scroll") continue;
    const klass = typeof el.className === "string" ? el.className : "";
    if (INTENTIONAL.some((k) => klass.includes(k))) continue;
    const hidden = el.scrollWidth - el.clientWidth;
    if (hidden > 4) {
      const cls = typeof el.className === "string" ? el.className : "";
      clipped.push({
        tag: el.tagName.toLowerCase(),
        cls: cls.split(/\s+/).filter(Boolean).slice(0, 2).join("."),
        hidden: Math.round(hidden),
        visible: Math.round(el.clientWidth),
      });
    }
  }

  return {
    vw,
    scrollWidth: document.scrollingElement.scrollWidth,
    offenders: offenders.slice(0, 10),
    clipped: clipped.slice(0, 6),
  };
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: DESKTOP ? 1 : 2,
  isMobile: !DESKTOP,
  hasTouch: !DESKTOP,
});
if (WANT_CARDS) {
  const { walletStub } = await import("./dry-run/wallet-stub.mjs");
  await ctx.addInitScript(
    walletStub({ address: STUB_ADDRESS, rpc: STUB_RPC, chainIdHex: "0x1237" }),
  );
}

const page = await ctx.newPage();
const problems = [];

async function shot(name) {
  await page.waitForTimeout(600);
  const r = await page.evaluate(MEASURE);
  const bad = r.offenders.length > 0 || r.scrollWidth > r.vw + 1 || r.clipped.length > 0;
  console.log(`\n## ${name}  (${r.vw}px viewport, scrollWidth ${r.scrollWidth}) ${bad ? "⚠" : "ok"}`);
  for (const o of r.offenders) console.log(`    +${o.over}px  ${o.tag}.${o.cls}  w=${o.w}`);
  for (const c of r.clipped)
    console.log(`    ${c.hidden}px hidden inside ${c.tag}.${c.cls} (only ${c.visible}px visible)`);
  if (bad) problems.push(name);
  await page.screenshot({ path: `${out}/${name}.png` });
}

/* ---- signed-out pages ---- */
for (const [name, path] of [
  ["home", "/"],
  ["leaderboard", "/leaderboard"],
  ["tournaments", "/tournaments"],
  ["token", "/token"],
  ["guide", "/guide"],
]) {
  await page.goto(base + path, { waitUntil: "load" });
  await shot(name);
}

if (WANT_CARDS) {
  for (const [name, path] of [
    ["cards-gacha", "/cards/gacha"],
    ["cards-collection", "/cards/collection"],
    ["cards-marketplace", "/cards/marketplace"],
    ["cards-deposit", "/cards/deposit"],
    ["cards-withdraw", "/cards/withdraw"],
    ["cards-transfer", "/cards/transfer"],
    ["cards-messages", "/cards/messages"],
  ]) {
    await page.goto(base + path, { waitUntil: "load" });
    // The inner app routes on the History API and fetches per tab, so give it a beat.
    await page.waitForTimeout(2500);
    await shot(name);
  }
}

if (WANT_REVEAL) {
  await page.goto(base + "/cards/gacha", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const demo = page.getByRole("button", { name: /try a demo pack/i });
  if (!(await demo.count())) {
    console.log("\n!! no demo-pack button — is the backend the demo server (API_PORT=8787 demo.ts)?");
  } else {
    await demo.first().click();
    // Staged copy, then the card. Sampled rather than waited on a selector so a stall shows up
    // as an empty stage instead of a timeout.
    for (const [i, ms] of [700, 1200, 1800, 2600, 4000].entries()) {
      await page.waitForTimeout(i === 0 ? ms : ms - [700, 1200, 1800, 2600, 4000][i - 1]);
      await shot(`reveal-${i + 1}`);
    }
    // Dismiss and look at the collection the pull landed in.
    const close = page.getByRole("button", { name: /close|done|keep/i });
    if (await close.count()) await close.first().click();
    await page.goto(base + "/cards/collection", { waitUntil: "load" });
    await page.waitForTimeout(2500);
    await shot("cards-collection-full");

    /*
     * The card sheet, which is where sell-back / withdraw / transfer live. It is the one screen
     * in the section whose mobile rule is `max-height: 100vh`, and 100vh is TALLER than what an
     * iOS browser actually shows, so its actions are the likeliest thing on the site to end up
     * under the browser chrome. Report anything below the fold rather than trusting the picture.
     */
    /* The floor's card grid, not the collection: the collection is built from on-chain
       ownership, which the demo backend cannot mint, so it is always empty here. Both open the
       same sheet. */
    await page.goto(base + "/cards/gacha", { waitUntil: "load" });
    await page.waitForTimeout(3000);
    const tile = page.locator(".slabs-root article.prize:not(.skeleton)").first();
    if (await tile.count()) {
      await tile.scrollIntoViewIfNeeded();
      await tile.click();
      await page.waitForTimeout(1500);
      await shot("card-sheet");
      const below = await page.evaluate(() => {
        const vh = window.innerHeight;
        const out = [];
        for (const el of document.querySelectorAll(".slabs-root button, .slabs-root a")) {
          const r = el.getBoundingClientRect();
          if (r.height === 0 || r.width === 0) continue;
          if (r.top > vh - 4 || r.bottom > vh + 4) {
            out.push({
              text: (el.textContent ?? "").trim().slice(0, 26),
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              vh,
            });
          }
        }
        return out.slice(0, 8);
      });
      if (below.length) {
        console.log("    controls at or past the fold in the open sheet:");
        for (const b of below) console.log(`      "${b.text}"  top=${b.top} bottom=${b.bottom} (viewport ${b.vh})`);
      } else {
        console.log("    every control in the open sheet is above the fold");
      }
    } else {
      console.log("    !! no card tile found on the collection page");
    }
  }
}

/* ---- sign in with a dev account, so the play surface renders ---- */
/* Production has no dev-login (it 404s on purpose), so the signed-in half is skipped rather
   than failing the run: pointing this at the live site to check the public pages is useful. */
let token = null;
try {
  token = await (await fetch(`${API}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ who: WHO }),
  })).json();
} catch {
  token = null;
}
if (!token?.token) {
  console.log(
    `\n(no dev-login at ${API} — skipping the signed-in pages and the battle. Run the local` +
      ` stack with DEV_LOGIN=1 to include them.)`,
  );
  console.log(
    problems.length
      ? `\n⚠ ${problems.length} screen(s) with horizontal overflow: ${problems.join(", ")}`
      : "\n✓ no horizontal overflow on any screen checked",
  );
  await browser.close();
  process.exit(problems.length ? 1 : 0);
}

await page.goto(base + "/", { waitUntil: "load" });
await page.evaluate(([t]) => {
  sessionStorage.setItem("slabshowdown.session", t);
  sessionStorage.setItem("slabshowdown.devsession", "1");
}, [token.token]);

/* The hamburger drawer is the entire navigation on a phone, so it gets checked too. */
if (!DESKTOP) {
  const toggle = page.locator(".nav-toggle");
  if (await toggle.count()) {
    await toggle.first().click();
    await shot("nav-open");
    await toggle.first().click();
  }
}

for (const [name, path] of [["wagers", "/wagers"], ["profile", "/profile"]]) {
  await page.goto(base + path, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await shot(name);
}

await page.goto(base + "/play", { waitUntil: "load" });
await page.waitForTimeout(2500);
await shot("play");

if (WANT_BATTLE) {
  // Practice needs a SIX-mon team selected. Pick the fullest team on the account rather than
  // whichever happens to be active — a one-Pokémon team leaves the Battle buttons disabled.
  const teams = page.locator(".ptm__pick");
  const count = await teams.count();
  let best = { i: -1, mons: -1 };
  for (let i = 0; i < count; i++) {
    const mons = await teams.nth(i).locator(".ptm__mon img").count();
    if (mons > best.mons) best = { i, mons };
  }
  if (best.mons >= 6) {
    await teams.nth(best.i).click();
    await page.waitForTimeout(1200);
  } else {
    // No full team on this account: build one through the UI, which also puts the team
    // builder on screen at phone width — a page worth checking anyway.
    await page.getByRole("button", { name: /\+ new/i }).first().click();
    await page.waitForTimeout(1500);
    await shot("team-builder");
    await page.getByRole("button", { name: /random team/i }).first().click();
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: /create team|save changes/i }).first().click();
    await page.waitForTimeout(2500);
  }
  await shot("play-team");

  // Practice against the AI: free, and the only battle one browser can start alone.
  const practice = page.locator("button.opp__go:not([disabled])");
  const n = await practice.count();
  if (!n) {
    console.log("\n!! every Battle button is disabled — no full team selected?");
  } else {
    await practice.first().click();
    await page.waitForURL(/\/play\//, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await shot("battle-arena");

    // The move menu: FIGHT opens the 2x2 grid, which is the densest thing on the screen.
    const fight = page.getByRole("button", { name: /^fight$/i });
    if (await fight.count()) {
      await fight.first().click();
      await shot("battle-moves");
    }
    const back = page.getByRole("button", { name: /back/i });
    if (await back.count()) await back.first().click();
    const sw = page.getByRole("button", { name: /^switch$/i });
    if (await sw.count()) {
      await sw.first().click();
      await shot("battle-switch");
    }
  }
}

console.log(
  problems.length
    ? `\n⚠ ${problems.length} screen(s) with horizontal overflow: ${problems.join(", ")}`
    : "\n✓ no horizontal overflow on any screen",
);
await browser.close();
