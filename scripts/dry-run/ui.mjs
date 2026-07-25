/**
 * Browser pass over the escrow UI.
 *
 * Everything here only exists when an escrow is deployed, so it has never been
 * rendered anywhere: the unclaimed-pot banner, its countdown, and the two-step
 * claim. This drives a real browser against the anvil stack with a real
 * unclaimed pot on screen.
 *
 * Screenshots land in scripts/dry-run/shots/ for eyeballing afterwards.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import {
  api, artifact, auth, account, connect, eth, login, playOut, pub, step, summary,
  wallet, TEAM_NAMES,
} from './lib.mjs'
import { walletStub } from './wallet-stub.mjs'

const ESCROW = process.env.ESCROW_ADDRESS
const SITE = process.env.SITE ?? 'http://127.0.0.1:4173'
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
const SHOTS = new URL('./shots/', import.meta.url).pathname
mkdirSync(SHOTS, { recursive: true })

const { abi } = artifact()
const at = { address: ESCROW, abi }
const read = (functionName, args = []) => pub.readContract({ ...at, functionName, args })
const send = async (who, functionName, args = [], value = 0n) => {
  const hash = await wallet(who).writeContract({ ...at, functionName, args, value })
  return pub.waitForTransactionReceipt({ hash })
}

const STAKE = eth('0.01')

/* ------------------------------------------------------------------ */
/* set up a real unclaimed pot                                         */
/* ------------------------------------------------------------------ */

console.log('\n— setting up an unclaimed pot —')

const alice = await login('alice')
const bob = await login('bob')

/**
 * Claim a username for a test wallet.
 *
 * The username gate blocks the whole app until one is set, so every wallet the
 * browser steps use needs a name first — otherwise the gate sits over the page
 * they are trying to test.
 */
async function enrolFresh(name) {
  const who = await login(name)
  await ensureName(who, name)
  return who
}

async function ensureName(who, name) {
  const me = await api('/api/me', { headers: auth(who.token) })
  if (me.body?.name) return
  const acct = account(who.name)
  const { body } = await api('/api/username/nonce', {
    method: 'POST', headers: auth(who.token), body: JSON.stringify({ name }),
  })
  if (!body?.message) throw new Error(`no claim message: ${JSON.stringify(body)}`)
  const signature = await acct.signMessage({ message: body.message })
  const r = await api('/api/username', {
    method: 'POST',
    headers: auth(who.token),
    body: JSON.stringify({ name, nonce: body.nonce, signature }),
  })
  if (r.status !== 200) throw new Error(`claim failed for ${name}: ${JSON.stringify(r.body)}`)
}

await ensureName(alice, 'aliceplays')
await ensureName(bob, 'bobbattles')

// Give alice a team so the signed-in lobby shows the team-beside-roster layout.
await api('/api/teams', {
  method: 'POST',
  headers: auth(alice.token),
  body: JSON.stringify({
    name: 'Alice squad',
    slots: (await api('/api/pokedex')).body.species.slice(0, 6).map((s) => ({
      speciesId: s.id,
      moves: s.moves.slice(0, 4),
    })),
  }),
})

const { body: dex } = await api('/api/pokedex')
const team = TEAM_NAMES.map((n) => {
  const sp = dex.species.find((s) => s.name === n)
  return { speciesId: sp.id, moves: sp.moves.slice(0, 4) }
})
const saveTeam = async (who) =>
  (await api('/api/teams', {
    method: 'POST',
    headers: auth(who.token),
    body: JSON.stringify({ name: `${who.name} squad`, slots: team }),
  })).body.id

const aliceTeam = await saveTeam(alice)
const bobTeam = await saveTeam(bob)

const block = await pub.getBlock()
await send('alice', 'createWager', [STAKE, block.timestamp + 3600n], STAKE)
const onchainId = await read('wagerCount')

const { body: posted } = await api('/api/wagers', {
  method: 'POST',
  headers: auth(alice.token),
  body: JSON.stringify({
    teamId: aliceTeam, stakeWei: STAKE.toString(), onchainId: onchainId.toString(),
  }),
})
await send('bob', 'acceptWager', [onchainId], STAKE)
await api(`/api/wagers/${posted.id}/accept`, {
  method: 'POST', headers: auth(bob.token), body: JSON.stringify({ teamId: bobTeam }),
})

const sockA = connect(alice.token)
const sockB = connect(bob.token)
const ended = await playOut(sockA, sockB)
sockA.close()
sockB.close()

const winner = ended.winner === 0 ? alice : bob
const loser = ended.winner === 0 ? bob : alice
console.log(`  winner is ${winner.name}, pot ${STAKE * 2n} wei unclaimed`)

/* ------------------------------------------------------------------ */
/* browser                                                            */
/* ------------------------------------------------------------------ */

console.log('\n— browser —')

const browser = await chromium.launch()

await step('the signed-in play lobby is laid out cleanly', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } })
  await ctx.addInitScript(
    walletStub({ address: account('alice').address, rpc: RPC, chainIdHex: '0x' + (await pub.getChainId()).toString(16) }),
  )
  await ctx.addInitScript((t) => localStorage.setItem('slabshowdown.session', t), alice.token)
  const page = await ctx.newPage()
  await page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })
  await page.locator('.play__team').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(600)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  await page.screenshot({ path: SHOTS + 'play-lobby-signedin.png' })
  if (overflow) throw new Error('the lobby scrolls sideways')
  await ctx.close()
})

async function openAs(who, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(
    walletStub({
      address: account(who.name).address,
      rpc: RPC,
      chainIdHex: '0x' + (await pub.getChainId()).toString(16),
    }),
  )
  await ctx.addInitScript(
    (t) => localStorage.setItem('slabshowdown.session', t),
    who.token,
  )
  const page = await ctx.newPage()

  const problems = []
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`))
  // A bare "404" in the console says nothing; record what actually failed.
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', (r) => {
    // Coinbase Wallet SDK fetches the page's own URL to read its
    // Cross-Origin-Opener-Policy header, and that probe is routinely aborted.
    // It is third-party, harmless, and happens in production too — traced to
    // checkCrossOriginOpenerPolicy in the wallet chunk. Anything else counts.
    const coopProbe =
      r.resourceType() === 'fetch' &&
      r.url().startsWith(SITE) &&
      !r.url().includes('/api/') &&
      r.failure()?.errorText === 'net::ERR_ABORTED'
    if (coopProbe) return
    problems.push(
      `requestfailed [${r.resourceType()}] ${r.url()} ${r.failure()?.errorText ?? ''}`,
    )
  })

  // Seed the session before the first navigation. Doing it with a goto,
  // evaluate, goto sequence aborted the first page load and filled the log
  // with ERR_ABORTED noise that looked like real failures.
  await page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })
  return { ctx, page, problems, label }
}

const win = await openAs(winner, 'winner')

await step('the page loads without console errors', async () => {
  await win.page.waitForTimeout(1500)
  if (win.problems.length) throw new Error(win.problems.join(' | '))
})

await step('the unclaimed banner is on screen for the winner', async () => {
  const banner = win.page.locator('.uc')
  await banner.waitFor({ state: 'visible', timeout: 15_000 })
  await win.page.screenshot({ path: SHOTS + 'winner-banner.png', fullPage: false })
})

await step('the banner shows the real pot, not a placeholder', async () => {
  const text = await win.page.locator('.uc__amount').first().innerText()
  // 0.01 staked each side -> a 0.02 pot.
  if (!text.includes('0.02')) throw new Error(`amount reads "${text}", expected 0.02`)
})

await step('the countdown is a real duration, not NaN or empty', async () => {
  const timer = win.page.locator('.uc__timer').first()
  await timer.waitFor({ state: 'visible', timeout: 15_000 })
  const text = (await timer.innerText()).trim()
  if (!text) throw new Error('countdown rendered empty')
  if (/nan|invalid|undefined/i.test(text)) throw new Error(`countdown reads "${text}"`)
  if (!/\d+\s*(h|m|s)/.test(text)) throw new Error(`countdown reads "${text}"`)
  console.log(`      countdown: "${text}"`)
})

await step('the countdown actually ticks', async () => {
  const timer = win.page.locator('.uc__timer').first()
  const first = await timer.innerText()
  await win.page.waitForTimeout(2500)
  const second = await timer.innerText()
  if (first === second) throw new Error(`countdown frozen at "${first}"`)
})

const lose = await openAs(loser, 'loser')

await step('the loser is not told they have a pot to claim', async () => {
  await lose.page.waitForTimeout(2500)
  if (await lose.page.locator('.uc').count()) {
    await lose.page.screenshot({ path: SHOTS + 'loser-WRONG.png' })
    throw new Error('the loser was shown an unclaimed-pot banner')
  }
})

await step('claiming settles and withdraws, and the banner goes away', async () => {
  const before = await pub.getBalance({ address: account(winner.name).address })

  await win.page.locator('.uc__claim').first().click()
  // Two transactions: settle, then withdraw.
  await win.page.locator('.uc').waitFor({ state: 'detached', timeout: 60_000 })

  const status = Number((await read('getWager', [onchainId])).status)
  if (status !== 3) throw new Error(`on-chain status ${status}, expected SETTLED(3)`)

  const after = await pub.getBalance({ address: account(winner.name).address })
  if (after <= before) throw new Error(`winner balance did not rise: ${before} -> ${after}`)

  const owed = await read('balances', [account(winner.name).address])
  if (owed !== 0n) throw new Error(`escrow still owes ${owed} — withdraw did not run`)

  await win.page.screenshot({ path: SHOTS + 'after-claim.png' })
  console.log(`      balance ${before} -> ${after}`)
})

await step('no console errors during the claim', async () => {
  if (win.problems.length) throw new Error(win.problems.join(' | '))
})

/* matchmaking ------------------------------------------------------ */

await step('quick match renders and shows a waiting state when joined', async () => {
  const page = lose.page
  const panel = page.locator('.qm')
  await panel.waitFor({ state: 'visible', timeout: 15_000 })

  const button = page.locator('.qm__go')
  const label = (await button.innerText()).trim()
  if (/sign in|build a team/i.test(label)) {
    throw new Error(`quick match is blocked for a signed-in player with a team: "${label}"`)
  }

  await button.click()
  await page.locator('.qm__waiting').waitFor({ state: 'visible', timeout: 15_000 })
  const waiting = await page.locator('.qm__waiting').innerText()
  if (!/looking for an opponent/i.test(waiting)) {
    throw new Error(`waiting state reads "${waiting}"`)
  }
  await page.locator('.qm').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await page.screenshot({ path: SHOTS + 'quick-match.png' })

  // Cancelling must put it back, not leave a dead slot.
  await page.locator('.qm__cancel').click()
  await page.locator('.qm__go').waitFor({ state: 'visible', timeout: 15_000 })
})

/* team builder ---------------------------------------------------- */

await step('the nature and ability pickers render, populate and explain themselves', async () => {
  const page = lose.page
  await page.locator('.tb-slot').first().waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => {})
  // Open the builder on the existing team.
  const edit = page.locator('button', { hasText: 'EDIT' }).first()
  if (await edit.count()) await edit.click()
  else await page.locator('button', { hasText: '+ NEW' }).first().click()

  await page.locator('.tb-traits').waitFor({ state: 'visible', timeout: 15_000 })

  // These are custom TraitSelect dropdowns, not native <select>s: the options
  // only exist in the DOM while the panel is open, and each one explains
  // itself in the panel footer on hover. Drive them the way a player would.
  const openTrait = async (nth) => {
    const trait = page.locator('.tb-trait').nth(nth)
    await trait.locator('.tsel__trigger').click()
    const panel = trait.locator('.tsel__panel')
    await panel.waitFor({ state: 'visible', timeout: 10_000 })
    return panel
  }

  const naturePanel = await openTrait(0)
  const natureOpts = naturePanel.locator('[role="option"]')
  const natures = await natureOpts.count()
  if (natures !== 25) throw new Error(`nature picker has ${natures} options, expected 25`)

  // Every nature carries a compact hint ("+Atk −SpA", or "neutral").
  const natureHint = (await natureOpts.first().locator('.tsel__opt-hint').innerText()).trim()
  if (!/^(neutral|\+\S+\s+−\S+)$/.test(natureHint))
    throw new Error(`nature hint reads "${natureHint}"`)

  // The point of the rewrite: hovering a row explains it in the footer.
  const desc = naturePanel.locator('.tsel__desc-text')
  await natureOpts.nth(1).hover()
  const natureDesc = (await desc.innerText()).trim()
  if (!/(Raises .* by 10%|changes no stats)/i.test(natureDesc))
    throw new Error(`nature hover explained nothing useful: "${natureDesc}"`)

  await page.keyboard.press('Escape')
  await naturePanel.waitFor({ state: 'hidden', timeout: 10_000 })

  const abilityPanel = await openTrait(1)
  const abilityOpts = abilityPanel.locator('[role="option"]')
  const abilities = await abilityOpts.count()
  if (abilities < 1) throw new Error('ability picker is empty')

  await abilityOpts.first().hover()
  const abilityDesc = (await abilityPanel.locator('.tsel__desc-text').innerText()).trim()
  if (abilityDesc.length < 10)
    throw new Error(`ability hover explained nothing useful: "${abilityDesc}"`)
  console.log(`      hover help: "${natureDesc.slice(0, 48)}…" / "${abilityDesc.slice(0, 48)}…"`)

  await page.keyboard.press('Escape')
  await abilityPanel.waitFor({ state: 'hidden', timeout: 10_000 })

  // Species Clause: a species already on the team cannot be picked again.
  const firstSlotName = await page.locator('.tb-slot').first().locator('.tb-slot__name').innerText()
  const card = page.locator('.sp', { hasText: new RegExp(`^${firstSlotName}$`, 'i') }).first()
  if (await card.count()) {
    // Move to another slot, then that species must be unavailable there.
    await page.locator('.tb-slot').nth(1).click()
    const dup = page.locator('.sp', { hasText: new RegExp(firstSlotName, 'i') }).first()
    if (await dup.count()) {
      const disabled = await dup.isDisabled()
      if (!disabled) throw new Error(`${firstSlotName} is still pickable in a second slot`)
    }
    await page.locator('.tb-slot').first().click()
  }

  await page.locator('.tb-traits').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await page.screenshot({ path: SHOTS + 'team-builder-traits.png' })
  console.log(`      ${natures} natures, ${abilities} abilities for this slot`)
})

/* the battle screen, on a phone ------------------------------------ */

await step('a real battle is usable at 390px', async () => {
  // Most launch traffic will be phones, and the battle screen is where people
  // spend all their time. It has never been looked at on one.
  const mk = async (who) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    })
    // The wallet stub is required, not optional: a session with no connected
    // wallet is dropped on purpose, so without it the page renders signed out.
    await ctx.addInitScript(
      walletStub({
        address: account(who.name).address,
        rpc: RPC,
        chainIdHex: '0x' + (await pub.getChainId()).toString(16),
      }),
    )
    await ctx.addInitScript((t) => localStorage.setItem('slabshowdown.session', t), who.token)
    const page = await ctx.newPage()
    const problems = []
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 160)}`))
    return { ctx, page, problems }
  }

  const one = await mk(alice)
  const two = await mk(bob)
  await one.page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })
  await two.page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })

  // Pair them through the queue, from the phones themselves.
  await one.page.locator('.qm').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  const btn = one.page.locator('.qm__go')
  if (!(await btn.count())) {
    await one.page.screenshot({ path: SHOTS + 'mobile-nobutton.png' })
    const body = (await one.page.locator('.qm').innerText().catch(() => '(no .qm)')).slice(0, 200)
    throw new Error(`no quick-match button on mobile. panel said: ${body}`)
  }
  const label = (await btn.innerText()).trim()
  if (await btn.isDisabled()) {
    await one.page.screenshot({ path: SHOTS + 'mobile-disabled.png' })
    throw new Error(`quick-match button disabled on mobile: "${label}"`)
  }
  await btn.click()
  await one.page.locator('.qm__waiting').waitFor({ state: 'visible', timeout: 15_000 })
  await two.page.locator('.qm__go').click()

  // Both should land in the arena.
  await one.page.locator('.arena').waitFor({ state: 'visible', timeout: 30_000 })
  await two.page.locator('.arena').waitFor({ state: 'visible', timeout: 30_000 })

  const overflow = await one.page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  await one.page.screenshot({ path: SHOTS + 'mobile-battle.png' })

  // The move buttons are the whole game; they must be reachable and tappable.
  const moves = one.page.locator('.moves button, .move, [data-move]')
  const moveCount = await moves.count()

  const tooSmall = await one.page.evaluate(() => {
    const els = [...document.querySelectorAll('.moves button, .move, [data-move]')]
    return els.filter((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.height < 32
    }).length
  })

  await one.ctx.close()
  await two.ctx.close()

  if (overflow) throw new Error('the battle screen scrolls sideways at 390px')
  if (moveCount === 0) throw new Error('no move buttons found on the battle screen')
  if (tooSmall > 0) throw new Error(`${tooSmall} move control(s) under 32px tall — hard to tap`)
  if (one.problems.length) throw new Error(one.problems.join(' | '))
  console.log(`      ${moveCount} move controls, no sideways scroll`)
})

/* connect -> auto sign-in -> username gate (the real first-run flow) --- */

await step('connecting a fresh wallet auto-signs in and prompts for a username', async () => {
  // Crucially NObody seeds a session token here — this exercises the real
  // connect -> sign -> gate transition a first-time player hits.
  const acct = account('carol')
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(
    walletStub({ address: acct.address, rpc: RPC, chainIdHex: '0x' + (await pub.getChainId()).toString(16) }),
  )
  const page = await ctx.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(e.message.slice(0, 160)))
  await page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  const gate = page.locator('.ug')
  if (!(await gate.isVisible().catch(() => false))) {
    const btns = await page.locator('.header button').allInnerTexts()
    console.log('      header buttons:', JSON.stringify(btns))
    const connect = page.locator('.header button').filter({ hasText: /connect/i }).first()
    if (await connect.count()) {
      await connect.click()
      const walletBtn = page.locator('.modal .wallet').first()
      await walletBtn.waitFor({ state: 'visible', timeout: 10_000 })
      await walletBtn.click()
    } else {
      const signin = page.locator('.header button').filter({ hasText: /sign in/i }).first()
      if (await signin.count()) await signin.click()
    }
  }

  await gate.waitFor({ state: 'visible', timeout: 25_000 })
  await page.screenshot({ path: SHOTS + 'first-run-flow.png' })

  if (problems.length) throw new Error(problems.join(' | '))
  await ctx.close()
  console.log('      connect -> auto sign-in -> username gate appeared, no extra steps')
})

/* quick-start team -------------------------------------------------- */

await step('one tap builds a legal, saveable six-Pokemon team', async () => {
  // A cold-start visitor should reach a playable team in one click, not thirty.
  const who = await enrolFresh('quickstart')
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  await ctx.addInitScript(
    walletStub({ address: account(who.name).address, rpc: RPC, chainIdHex: '0x' + (await pub.getChainId()).toString(16) }),
  )
  await ctx.addInitScript((t) => localStorage.setItem('slabshowdown.session', t), who.token)
  const page = await ctx.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(e.message.slice(0, 140)))
  await page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })

  // Open the builder.
  const newBtn = page.locator('button', { hasText: '+ NEW' }).first()
  await newBtn.click()

  await page.locator('.tb-quick__random').waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('.tb-quick__random').click()
  await page.waitForTimeout(400)

  // All six slots filled, no "Empty".
  const filled = await page.locator('.tb-slot:not(.tb-slot--empty)').count()
  if (filled !== 6) throw new Error(`only ${filled}/6 slots filled after Random team`)

  await page.screenshot({ path: SHOTS + 'random-team.png' })

  // The create button must be enabled (team is legal) and actually persist.
  const saveBtn = page.locator('button', { hasText: /Create team|Save changes/i }).first()
  await saveBtn.waitFor({ state: 'visible', timeout: 5000 })
  if (await saveBtn.isDisabled()) throw new Error('Create disabled — random team is not legal')
  await saveBtn.click()
  await page.waitForTimeout(1200)

  // Confirm the server accepted a legal team for this player.
  const { body } = await api(`/api/teams`, { headers: auth(who.token) })
  if (!Array.isArray(body) || body.length < 1) throw new Error('no team saved')
  const slots = body[0].slots
  if (slots.length !== 6) throw new Error(`saved team has ${slots.length} slots`)
  const species = new Set(slots.map((x) => x.speciesId))
  if (species.size !== 6) throw new Error('random team violated Species Clause (duplicate species)')

  if (problems.length) throw new Error(problems.join(' | '))
  await ctx.close()
  console.log('      random team: 6 distinct species, saved and legal')
})

/* username claim ---------------------------------------------------- */

await step('a first-time wallet must claim a username before playing', async () => {
  // A wallet that has never signed in: the gate should block the app until a
  // name is claimed, and the claim must be signed by that wallet.
  const fresh = await login('bob2')

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(
    walletStub({
      address: account('bob2').address,
      rpc: RPC,
      chainIdHex: '0x' + (await pub.getChainId()).toString(16),
    }),
  )
  await ctx.addInitScript((t) => localStorage.setItem('slabshowdown.session', t), fresh.token)
  const page = await ctx.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 160)}`))
  await page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })

  const gate = page.locator('.ug')
  await gate.waitFor({ state: 'visible', timeout: 20_000 })
  await page.screenshot({ path: SHOTS + 'username-gate.png' })

  // A taken name is refused before any signature is asked for.
  await page.locator('.ug__input').fill('aliceplays')
  await page.waitForTimeout(900)
  const okBefore = await page.locator('.ug__go').isDisabled()
  if (!okBefore) throw new Error('claim was enabled for a name already taken')

  // A free name enables the button.
  await page.locator('.ug__input').fill('freshtrainer')
  await page.waitForTimeout(900)
  if (await page.locator('.ug__go').isDisabled()) {
    const s = await page.locator('.ug__status').innerText()
    throw new Error(`claim stayed disabled for a free name: ${s}`)
  }

  await page.locator('.ug__go').click()
  await gate.waitFor({ state: 'detached', timeout: 30_000 })

  // The claim really landed, and the wallet really signed it.
  const { body } = await api('/api/me', { headers: auth(fresh.token) })
  if (body.name !== 'freshtrainer') throw new Error(`server has name ${body.name}`)
  if (body.needsUsername) throw new Error('still flagged as needing a username')

  // Reloading must not ask again.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  if (await page.locator('.ug').count()) throw new Error('the gate reappeared after claiming')

  if (problems.length) throw new Error(problems.join(' | '))
  await ctx.close()
  console.log('      claimed "freshtrainer", gate cleared and stayed cleared')
})

/* replay ------------------------------------------------------------ */

await step('a finished match replays, and proves itself from the seed', async () => {
  // Replays re-derive the whole match from the published seed, so there is
  // more to go wrong here than in an ordinary page — and it had never been
  // rendered once.
  const enrol = async (name) => {
    const who = await login(name)
    const r = await api('/api/teams', {
      method: 'POST',
      headers: auth(who.token),
      body: JSON.stringify({ name: `${name} squad`, slots: team }),
    })
    if (r.status !== 200) throw new Error(`team save failed: ${JSON.stringify(r.body)}`)
    await ensureName(who, `${name}player`)
    return who
  }

  const p1 = await enrol('deployer')
  const p2 = await enrol('treasury')

  // Play a full match through the API so there is something to replay.
  const j1 = await api('/api/queue/join', {
    method: 'POST', headers: auth(p1.token), body: JSON.stringify({ teamId: 0 }),
  }).catch(() => null)
  void j1

  const teamOf = async (who) => (await api('/api/teams', { headers: auth(who.token) })).body[0].id
  const t1 = await teamOf(p1)
  const t2 = await teamOf(p2)

  await api('/api/queue/join', {
    method: 'POST', headers: auth(p1.token), body: JSON.stringify({ teamId: t1 }),
  })
  const paired = await api('/api/queue/join', {
    method: 'POST', headers: auth(p2.token), body: JSON.stringify({ teamId: t2 }),
  })
  const roomId = paired.body?.roomId
  if (!roomId) throw new Error(`no room from the queue: ${JSON.stringify(paired.body)}`)

  const sa = connect(p1.token)
  const sb = connect(p2.token)
  const ended = await playOut(sa, sb)
  sa.close()
  sb.close()

  // Now open the replay in a browser.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const page = await ctx.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 160)}`))
  await page.goto(`${SITE}/replay/${roomId}`, { waitUntil: 'networkidle' })

  await page.locator('.rp__bar').waitFor({ state: 'visible', timeout: 20_000 })

  // The integrity claims are the whole point of publishing a seed.
  const checks = page.locator('.rp__checks li')
  const n = await checks.count()
  if (n < 2) throw new Error(`expected the seed and reproduction checks, found ${n}`)
  for (let i = 0; i < n; i++) {
    const cls = await checks.nth(i).getAttribute('class')
    const text = (await checks.nth(i).innerText()).trim()
    if (cls !== 'ok') throw new Error(`verification failed: "${text.slice(0, 90)}"`)
  }

  // The "could not be reproduced" warning must not be on screen.
  if (await page.locator('text=could not be reproduced').count()) {
    throw new Error('the replay reported it could not reproduce the battle')
  }

  const counter = page.locator('.rp__count')
  const before = (await counter.innerText()).trim()
  await page.screenshot({ path: SHOTS + 'replay.png' })

  // Step forward and confirm playback actually moves.
  await page.locator('.rp__btn', { hasText: '›' }).click()
  await page.waitForTimeout(400)
  const after = (await counter.innerText()).trim()
  if (before === after) throw new Error(`stepping did nothing: still "${before}"`)

  // Scrub to the end and confirm the result matches what the live match said.
  const scrub = page.locator('.rp__scrub')
  const max = await scrub.getAttribute('max')
  await scrub.fill(String(max))
  await page.waitForTimeout(600)

  const body = (await page.locator('body').innerText()).toLowerCase()
  const expected = ended.winner === null ? 'draw' : 'won'
  if (!body.includes(expected)) {
    throw new Error(`replay does not show the outcome (${expected})`)
  }

  await page.screenshot({ path: SHOTS + 'replay-end.png' })
  if (problems.length) throw new Error(problems.join(' | '))
  console.log(`      ${before} -> ${after}, verified from seed`)
  await ctx.close()
})

/* disconnect ------------------------------------------------------- */

await step('a disconnect shows a live countdown, then awards the match', async () => {
  // The rules are tested server-side, but nobody had ever seen what the
  // remaining player actually gets shown. A frozen screen with no explanation
  // reads as a broken game, not a working rule.
  const mk = async (who) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await ctx.addInitScript(
      walletStub({
        address: account(who.name).address,
        rpc: RPC,
        chainIdHex: '0x' + (await pub.getChainId()).toString(16),
      }),
    )
    await ctx.addInitScript((t) => localStorage.setItem('slabshowdown.session', t), who.token)
    const page = await ctx.newPage()
    await page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })
    return { ctx, page }
  }

  // Fresh accounts: alice and bob are still sitting in the battle the mobile
  // step started, so the lobby would not even be on screen for them.
  const enrol = async (name) => {
    const who = await login(name)
    const r = await api('/api/teams', {
      method: 'POST',
      headers: auth(who.token),
      body: JSON.stringify({ name: `${name} squad`, slots: team }),
    })
    if (r.status !== 200) throw new Error(`team save failed for ${name}: ${JSON.stringify(r.body)}`)
    return who
  }

  const stayer = await mk(await enrol('deployer'))
  const quitter = await mk(await enrol('treasury'))

  await stayer.page.locator('.qm__go').click()
  await stayer.page.locator('.qm__waiting').waitFor({ state: 'visible', timeout: 15_000 })
  await quitter.page.locator('.qm__go').click()

  await stayer.page.locator('.arena').waitFor({ state: 'visible', timeout: 30_000 })
  await quitter.page.locator('.arena').waitFor({ state: 'visible', timeout: 30_000 })

  // The quitter closes the tab outright.
  await quitter.ctx.close()

  const banner = stayer.page.locator('.banner', { hasText: /disconnected/i })
  await banner.waitFor({ state: 'visible', timeout: 20_000 })
  const first = await banner.innerText()
  if (!/\d+s/.test(first)) {
    throw new Error(`no countdown in the disconnect banner: "${first.slice(0, 120)}"`)
  }
  await stayer.page.screenshot({ path: SHOTS + 'disconnect.png' })

  // It must tick, not sit frozen on a number.
  await stayer.page.waitForTimeout(2500)
  const second = await banner.innerText().catch(() => '')
  const n = (t) => Number((t.match(/(\d+)s/) ?? [])[1] ?? -1)
  if (second && n(second) >= n(first) && n(second) !== -1) {
    throw new Error(`countdown did not move: "${first}" -> "${second}"`)
  }

  // And the match must actually resolve in the stayer's favour.
  //
  // Target the end-of-match panel specifically. A looser locator matched the
  // disconnect banner itself — which contains the words "you win the match" —
  // so the check passed without the battle ever ending.
  const result = stayer.page.locator('.result--win .result__title')
  await result.waitFor({ state: 'visible', timeout: 40_000 })
  const text = (await result.innerText()).trim()
  if (!/you win/i.test(text)) throw new Error(`result panel reads "${text}", expected a win`)

  // The seed reveal is what makes the result auditable. It lives inside a
  // collapsed <details>, so open it before looking.
  await stayer.page.locator('.verify summary').click()
  const seed = stayer.page.locator('.verify code').last()
  await seed.waitFor({ state: 'visible', timeout: 10_000 })
  const revealed = (await seed.innerText()).trim()
  if (revealed.length < 32) {
    throw new Error(`seed not revealed on a forfeit: "${revealed}"`)
  }

  await stayer.page.screenshot({ path: SHOTS + 'disconnect-result.png' })
  console.log(`      result panel: "${text}"`)

  await stayer.ctx.close()
})

/* paid tournaments -------------------------------------------------- */

/**
 * The paid-tournament UI, driven through the stubbed wallet against the real
 * pool — the money-touching screens the headless dry runs prove server-side but
 * nobody has ever clicked: posting a pool from the create form, paying an entry
 * fee, leaving for a refund, extending, cancelling, reclaiming a fee, and the
 * champion's prize.
 *
 * Every transaction below is really signed and really mined by anvil; every
 * assertion is read back off the contract, not off the page.
 */

const POOL = process.env.POOL_ADDRESS
const poolAbi = JSON.parse(
  readFileSync(
    new URL('../../contracts/out/PokePlayTournamentPool.sol/PokePlayTournamentPool.json', import.meta.url),
    'utf8',
  ),
).abi
const poolAt = { address: POOL, abi: poolAbi }
const poolRead = (functionName, args = []) => pub.readContract({ ...poolAt, functionName, args })

const ENTRY = eth('0.01')
/** PokePlayTournamentPool.Status, in declaration order. */
const POOL_STATUS = { NONE: 0, OPEN: 1, SETTLED: 2, REFUNDING: 3 }

/** Polls a contract read until it satisfies `ok`, so a wallet step can settle. */
async function untilChain(label, read, ok, ms = 90_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`${label}: still ${value} after ${ms / 1000}s`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Polls the server view of a tournament until `ok`. */
async function untilServer(label, id, ok, ms = 90_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const { body } = await api(`/api/tournaments/${id}`)
    if (ok(body)) return body
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(body?.status)} after ${ms / 1000}s`)
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/**
 * The claim/withdraw panel is shared with the wager pages, and its stylesheet
 * used to be imported by those pages only — so on a tournament it rendered as
 * raw markup: no padding, no row layout, the button jammed against the text. It
 * still worked, which is exactly why nothing caught it. Check the rules are
 * applied, not just that the element is there.
 */
async function assertClaimStyled(page) {
  const style = await page.evaluate(() => {
    const card = document.querySelector('.claim')
    const row = document.querySelector('.claim__withdraw')
    if (!card) return null
    return {
      padding: getComputedStyle(card).paddingTop,
      row: row ? getComputedStyle(row).display : null,
      width: card.getBoundingClientRect().width,
    }
  })
  if (!style) throw new Error('no claim panel on screen')
  if (style.padding === '0px') throw new Error('the claim panel has no padding — its stylesheet never loaded')
  if (style.row && style.row !== 'flex') throw new Error(`the withdraw row lays out as "${style.row}", expected flex`)
  if (style.width > 760) throw new Error(`the claim panel is ${Math.round(style.width)}px wide — it is not lining up with the other cards`)
}

console.log('\n— paid tournaments —')

if (!POOL) {
  await step('the browser pass has a tournament pool to drive', () => {
    throw new Error('POOL_ADDRESS is not set — run-ui.sh must deploy the pool and pass it through')
  })
}

/** Opens a signed-in browser context straight onto `path`. */
async function openAt(who, path) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  await ctx.addInitScript(
    walletStub({
      address: account(who.name).address,
      rpc: RPC,
      chainIdHex: '0x' + (await pub.getChainId()).toString(16),
    }),
  )
  await ctx.addInitScript((t) => localStorage.setItem('slabshowdown.session', t), who.token)
  const page = await ctx.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 160)}`))
  await page.goto(`${SITE}${path}`, { waitUntil: 'networkidle' })
  return { ctx, page, problems, who }
}

if (POOL) {
  // The organiser is anvil #0 — the only address in ADMIN_ADDRESSES, so the only
  // one the create form is offered to. It already claimed a name in the replay
  // step; ensureName is idempotent.
  const organizer = await login('deployer')
  await ensureName(organizer, 'deployerplayer')

  const enrolPlayer = async (key, username) => {
    const who = await login(key)
    await ensureName(who, username)
    await saveTeam(who)
    return who
  }
  const e1 = await enrolPlayer('entrant1', 'entrantone')
  const e2 = await enrolPlayer('entrant2', 'entranttwo')

  const org = await openAt(organizer, '/tournaments')
  const p1 = await openAt(e1, '/tournaments')
  const p2 = await openAt(e2, '/tournaments')

  /* ---- a paid tournament, posted from the create form ---- */

  let cupId = null
  let cupOnchain = null

  await step('the organiser posts a paid tournament and the pool opens on chain', async () => {
    const before = await poolRead('tournamentCount')

    await org.page.locator('.tn__admin button').first().click()
    await org.page.locator('.tn__create').waitFor({ state: 'visible', timeout: 15_000 })

    // The fee field only exists when the server reports paid entry AND this build
    // knows a pool address. Its absence is the failure worth naming.
    if (!(await org.page.locator('#tn-fee').count())) {
      const note = await org.page.locator('.tn__note').first().innerText().catch(() => '')
      throw new Error(`no entry-fee field — the paid path is not offered: "${note.trim().slice(0, 120)}"`)
    }

    await org.page.locator('#tn-name').fill('Browser Cup')
    await org.page.selectOption('#tn-size', '4')
    await org.page.locator('#tn-fee').fill('0.01')
    await org.page.selectOption('#tn-close', '3600')

    const go = org.page.locator('.tn__create-actions .btn--dark')
    const label = (await go.innerText()).trim()
    if (!/open pool/i.test(label)) {
      throw new Error(`create button reads "${label}", expected it to open the pool first`)
    }
    await org.page.screenshot({ path: SHOTS + 'tn-create-paid.png' })

    await go.click()
    // One wallet transaction, then the POST. The form closes only on success.
    await org.page.locator('.tn__create').waitFor({ state: 'detached', timeout: 90_000 })

    cupOnchain = await poolRead('tournamentCount')
    if (cupOnchain !== before + 1n) {
      throw new Error(`pool tournamentCount went ${before} -> ${cupOnchain}, expected +1`)
    }

    const t = await poolRead('getTournament', [cupOnchain])
    if (t.entryFee !== ENTRY) throw new Error(`on-chain entry fee ${t.entryFee}, expected ${ENTRY}`)
    if (Number(t.maxPlayers) !== 4) throw new Error(`on-chain maxPlayers ${t.maxPlayers}, expected 4`)
    if (t.organizer.toLowerCase() !== account('deployer').address.toLowerCase()) {
      throw new Error(`on-chain organizer is ${t.organizer}, not the poster`)
    }

    const { body: list } = await api('/api/tournaments')
    const row = list.tournaments.find((r) => r.name === 'Browser Cup')
    if (!row) throw new Error('the server has no Browser Cup')
    cupId = row.id

    // The two must agree about which pool holds the money.
    const view = (await api(`/api/tournaments/${cupId}`)).body
    if (view.onchainId !== cupOnchain.toString()) {
      throw new Error(`server points at pool #${view.onchainId}, the chain made #${cupOnchain}`)
    }
    console.log(`      server #${cupId} ↔ pool #${cupOnchain}, ${t.maxPlayers} seats at 0.01`)
  })

  /* ---- paying in ---- */

  const payAndEnter = async (b) => {
    await b.page.goto(`${SITE}/tournaments/${cupId}`, { waitUntil: 'networkidle' })
    const btn = b.page.locator('.tn__join button')
    await btn.waitFor({ state: 'visible', timeout: 20_000 })
    const label = (await btn.innerText()).trim()
    if (!/pay .*&\s*enter/i.test(label)) {
      throw new Error(`join button reads "${label}", expected it to name the fee`)
    }
    await btn.click()
    // Wallet transaction, then the server join. "Leave & get refund" only renders
    // once the server has actually seated them.
    await b.page.locator('.tn__you .btn--ghost').waitFor({ state: 'visible', timeout: 90_000 })
  }

  await step('both players pay the entry fee from the page and the pool takes it', async () => {
    if (cupId === null) throw new Error('no tournament was posted')
    const poolBefore = await pub.getBalance({ address: POOL })

    await payAndEnter(p1)
    await payAndEnter(p2)

    for (const key of ['entrant1', 'entrant2']) {
      if (!(await poolRead('isEntrant', [cupOnchain, account(key).address]))) {
        throw new Error(`${key} paid but is not an on-chain entrant`)
      }
    }
    const took = (await pub.getBalance({ address: POOL })) - poolBefore
    if (took !== ENTRY * 2n) throw new Error(`the pool took ${took}, expected ${ENTRY * 2n}`)

    const view = (await api(`/api/tournaments/${cupId}`)).body
    if (view.players.length !== 2) throw new Error(`server seated ${view.players.length} players`)

    await p1.page.screenshot({ path: SHOTS + 'tn-paid-entered.png' })
  })

  await step('the entrant list names both players', async () => {
    await p1.page.reload({ waitUntil: 'networkidle' })
    const names = await p1.page.locator('.tn__entrant-list .tn__player').allInnerTexts()
    const got = names.map((n) => n.trim()).sort()
    if (got.join(',') !== 'entrantone,entranttwo') {
      throw new Error(`entrant list reads ${JSON.stringify(got)}`)
    }
  })

  /* ---- organiser extends the window ---- */

  await step('the organiser extends the deadline on chain and on the server', async () => {
    await org.page.goto(`${SITE}/tournaments/${cupId}`, { waitUntil: 'networkidle' })
    const chainBefore = (await poolRead('getTournament', [cupOnchain])).registrationDeadline
    const serverBefore = (await api(`/api/tournaments/${cupId}`)).body.startAt

    const ext = org.page.locator('.tn__admin button', { hasText: /extend/i })
    await ext.waitFor({ state: 'visible', timeout: 20_000 })
    await ext.click()

    const chainAfter = await untilChain(
      'the pool deadline never moved',
      async () => (await poolRead('getTournament', [cupOnchain])).registrationDeadline,
      (v) => v > chainBefore,
    )
    // The page only POSTs the new start time after IT sees the receipt, which is
    // a poll or two behind our own — so wait for the server rather than reading
    // it the instant the chain moves.
    const { startAt: serverAfter } = await untilServer(
      'the server start time never moved',
      cupId,
      (b) => b.startAt > serverBefore,
    )
    console.log(`      deadline +${Number(chainAfter - chainBefore)}s on chain, +${serverAfter - serverBefore}s on the server`)
  })

  /* ---- leaving gets the fee back ---- */

  await step('a player leaves from the page and the pool credits their fee back', async () => {
    const addr = account('entrant1').address
    const btn = p1.page.locator('.tn__you .btn--ghost')
    await btn.waitFor({ state: 'visible', timeout: 20_000 })
    const label = (await btn.innerText()).trim()
    if (!/leave & get refund/i.test(label)) throw new Error(`leave button reads "${label}"`)

    const creditedBefore = await poolRead('balances', [addr])
    await btn.click()
    // The join panel comes back once the server has dropped the seat.
    await p1.page.locator('.tn__join button').waitFor({ state: 'visible', timeout: 90_000 })

    if (await poolRead('isEntrant', [cupOnchain, addr])) {
      throw new Error('still an on-chain entrant after leaving')
    }
    const credited = (await poolRead('balances', [addr])) - creditedBefore
    if (credited !== ENTRY) throw new Error(`leaving credited ${credited}, expected ${ENTRY}`)

    const view = (await api(`/api/tournaments/${cupId}`)).body
    if (view.players.some((p) => p.address?.toLowerCase() === addr.toLowerCase())) {
      throw new Error('the server kept the seat after the player left the pool')
    }
  })

  await step('and the leaver can withdraw that fee from the same page', async () => {
    // leaveTournament CREDITS the fee, it does not send it. The page used to
    // offer the refund panel only on a CANCELLED tournament you were still
    // seated in — neither of which is true right after leaving — so the money
    // sat in the pool with no button anywhere on the site to move it.
    const addr = account('entrant1').address
    const panel = p1.page.locator('.claim')
    await panel.waitFor({ state: 'visible', timeout: 20_000 })
    await assertClaimStyled(p1.page)
    await p1.page.screenshot({ path: SHOTS + 'tn-leaver-withdraw.png' })

    const walletBefore = await pub.getBalance({ address: addr })
    await panel.locator('button', { hasText: /withdraw/i }).click()
    await panel.waitFor({ state: 'detached', timeout: 90_000 })

    const owed = await poolRead('balances', [addr])
    if (owed !== 0n) throw new Error(`the pool still owes the leaver ${owed}`)
    const walletAfter = await pub.getBalance({ address: addr })
    if (walletAfter <= walletBefore) {
      throw new Error(`the leaver's wallet did not rise: ${walletBefore} -> ${walletAfter}`)
    }
    console.log(`      ${walletAfter - walletBefore} wei back in the wallet`)
  })

  /* ---- cancelling opens refunds ---- */

  await step('the organiser cancels and the pool flips to REFUNDING', async () => {
    const btn = org.page.locator('.tn__admin button', { hasText: /cancel/i })
    await btn.waitFor({ state: 'visible', timeout: 20_000 })
    const label = (await btn.innerText()).trim()
    if (!/cancel & refund all/i.test(label)) throw new Error(`cancel button reads "${label}"`)
    await btn.click()

    await org.page.locator('.lede', { hasText: /cancelled/i })
      .waitFor({ state: 'visible', timeout: 90_000 })

    const status = Number(await poolRead('statusOf', [cupOnchain]))
    if (status !== POOL_STATUS.REFUNDING) {
      throw new Error(`pool status ${status}, expected REFUNDING(${POOL_STATUS.REFUNDING})`)
    }
    const view = (await api(`/api/tournaments/${cupId}`)).body
    if (view.status !== 'cancelled') throw new Error(`server status ${view.status}`)
    await org.page.screenshot({ path: SHOTS + 'tn-cancelled.png' })
  })

  await step('the remaining entrant reclaims their fee and withdraws it', async () => {
    const addr = account('entrant2').address
    await p2.page.reload({ waitUntil: 'networkidle' })

    const panel = p2.page.locator('.claim')
    await panel.waitFor({ state: 'visible', timeout: 20_000 })
    await p2.page.screenshot({ path: SHOTS + 'tn-refund-panel.png' })

    // A cancelled tournament must not still read "You are signed up… it starts
    // automatically", with a leave button under it that reverts.
    const position = await p2.page.locator('.tn__you').count()
    if (position) {
      const said = (await p2.page.locator('.tn__you').innerText()).replace(/\s+/g, ' ').trim()
      throw new Error(`a cancelled tournament still shows a position panel: "${said.slice(0, 120)}"`)
    }

    await panel.locator('button', { hasText: /claim refund/i }).click()
    await untilChain(
      'the refund was never credited',
      () => poolRead('balances', [addr]),
      (v) => v === ENTRY,
    )

    const walletBefore = await pub.getBalance({ address: addr })
    const withdraw = panel.locator('button', { hasText: /withdraw/i })
    await withdraw.waitFor({ state: 'visible', timeout: 30_000 })
    await withdraw.click()

    // Nothing owed and nothing to claim: the panel takes itself off screen.
    await panel.waitFor({ state: 'detached', timeout: 90_000 })
    const owed = await poolRead('balances', [addr])
    if (owed !== 0n) throw new Error(`the pool still owes ${owed} after withdrawing`)
    const walletAfter = await pub.getBalance({ address: addr })
    if (walletAfter <= walletBefore) {
      throw new Error(`wallet did not rise on withdraw: ${walletBefore} -> ${walletAfter}`)
    }
    console.log(`      reclaimed ${ENTRY} wei, wallet ${walletBefore} -> ${walletAfter}`)
  })

  /* ---- and the happy path: a champion collects the pot ---- */

  let prizeId = null
  let prizeOnchain = null

  await step('a short-fuse paid tournament is opened for the champion path', async () => {
    // The create form's shortest sign-up window is an hour, and a paid tournament
    // deliberately cannot be started by hand before its deadline — so this one is
    // opened directly with a start time seconds away. Everything the player does
    // with it after this is browser-driven.
    const hash = await wallet('deployer').writeContract({
      ...poolAt,
      functionName: 'createTournament',
      args: [ENTRY, 2, (await pub.getBlock()).timestamp + 3600n],
    })
    await pub.waitForTransactionReceipt({ hash })
    prizeOnchain = await poolRead('tournamentCount')

    const r = await api('/api/tournaments', {
      method: 'POST',
      headers: auth(organizer.token),
      body: JSON.stringify({
        name: 'Browser Prize Cup',
        maxPlayers: 2,
        entryFeeWei: ENTRY.toString(),
        onchainId: prizeOnchain.toString(),
        startAt: Math.floor(Date.now() / 1000) + 20,
      }),
    })
    if (r.status !== 200) throw new Error(`create failed: ${JSON.stringify(r.body)}`)
    prizeId = r.body.id
  })

  await step('both players pay into it from the page', async () => {
    if (prizeId === null) throw new Error('no prize tournament was opened')
    for (const b of [p1, p2]) {
      await b.page.goto(`${SITE}/tournaments/${prizeId}`, { waitUntil: 'networkidle' })
      const btn = b.page.locator('.tn__join button')
      await btn.waitFor({ state: 'visible', timeout: 20_000 })
      await btn.click()
      await b.page.locator('.tn__you .btn--ghost').waitFor({ state: 'visible', timeout: 90_000 })
    }
    const pot = await poolRead('potOf', [prizeOnchain])
    if (pot !== ENTRY * 2n) throw new Error(`pot is ${pot}, expected ${ENTRY * 2n}`)
  })

  await step('sign-ups close and the scheduler starts it with whoever paid', async () => {
    await untilServer('never started', prizeId, (b) => b.status === 'running')
  })

  await step('the players reach the arena from the tournament page', async () => {
    // p1 starts the fixture from the page. p2's "Play my match" disappears the
    // moment the match is marked playing, so they get in the way a returning
    // player does — the lobby resumes a battle in progress.
    await p1.page.reload({ waitUntil: 'networkidle' })
    const play = p1.page.locator('.tn__you button', { hasText: /play my match/i })
    await play.waitFor({ state: 'visible', timeout: 40_000 })
    await p1.page.screenshot({ path: SHOTS + 'tn-match-ready.png' })
    await play.click()
    await p1.page.locator('.arena').waitFor({ state: 'visible', timeout: 40_000 })

    await p2.page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })
    await p2.page.locator('.arena').waitFor({ state: 'visible', timeout: 40_000 })
  })

  await step('the tournament crowns the player who stayed', async () => {
    // The battle itself is covered elsewhere; here the point is that a forfeit
    // resolves a PAID fixture and names a champion the pool will pay.
    await p1.ctx.close()
    const view = await untilServer(
      'never finished',
      prizeId,
      (b) => b.status === 'finished' && b.winner,
      120_000,
    )
    if (view.winner.toLowerCase() !== account('entrant2').address.toLowerCase()) {
      throw new Error(`champion is ${view.winner}, expected the player who stayed`)
    }
  })

  await step('the champion claims the prize and withdraws it', async () => {
    const addr = account('entrant2').address
    const feeBps = await poolRead('feeBps')
    const pot = ENTRY * 2n
    const expectedFee = (pot * BigInt(feeBps)) / 10000n
    const expectedPayout = pot - expectedFee
    const treasuryBefore = await poolRead('balances', [account('treasury').address])

    await p2.page.goto(`${SITE}/tournaments/${prizeId}`, { waitUntil: 'networkidle' })
    const panel = p2.page.locator('.claim')
    await panel.waitFor({ state: 'visible', timeout: 30_000 })
    const title = (await panel.locator('.claim__title').innerText()).trim()
    if (!/you won/i.test(title)) throw new Error(`prize panel reads "${title}"`)
    await assertClaimStyled(p2.page)
    await p2.page.screenshot({ path: SHOTS + 'tn-prize.png' })

    await panel.locator('button', { hasText: /claim prize/i }).click()
    await untilChain(
      'the pool never settled',
      async () => Number(await poolRead('statusOf', [prizeOnchain])),
      (v) => v === POOL_STATUS.SETTLED,
    )

    const credited = await poolRead('balances', [addr])
    if (credited !== expectedPayout) {
      throw new Error(`champion credited ${credited}, expected ${expectedPayout}`)
    }
    const treasury = (await poolRead('balances', [account('treasury').address])) - treasuryBefore
    if (treasury !== expectedFee) throw new Error(`treasury credited ${treasury}, expected ${expectedFee}`)

    const walletBefore = await pub.getBalance({ address: addr })
    const withdraw = panel.locator('button', { hasText: /withdraw/i })
    await withdraw.waitFor({ state: 'visible', timeout: 30_000 })
    await withdraw.click()
    await panel.waitFor({ state: 'detached', timeout: 90_000 })

    if ((await poolRead('balances', [addr])) !== 0n) throw new Error('the pool still owes the champion')
    const walletAfter = await pub.getBalance({ address: addr })
    if (walletAfter <= walletBefore) {
      throw new Error(`champion wallet did not rise: ${walletBefore} -> ${walletAfter}`)
    }
    await p2.page.screenshot({ path: SHOTS + 'tn-prize-paid.png' })
    console.log(`      pot ${pot} → champion ${expectedPayout}, fee ${expectedFee} (${feeBps}bps)`)
  })

  /* ---- and a pot that never fills must not trap the money ---- */

  await step('a tournament that closes with one player says so, and offers a way out', async () => {
    // Sign-ups close with a single entrant, so it can never run. Left alone the
    // page used to keep saying "it starts automatically when sign-ups close" and
    // offer a leave button that reverts (leaveTournament is refused past the
    // deadline), with the fee sitting in the pool until the organiser noticed.
    //
    // Wall clock, not the latest block: anvil only mines on a transaction, so a
    // deadline derived from a stale block would already have passed.
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 25n
    const hash = await wallet('deployer').writeContract({
      ...poolAt,
      functionName: 'createTournament',
      args: [ENTRY, 4, deadline],
    })
    await pub.waitForTransactionReceipt({ hash })
    const dudOnchain = await poolRead('tournamentCount')

    const r = await api('/api/tournaments', {
      method: 'POST',
      headers: auth(organizer.token),
      body: JSON.stringify({
        name: 'Browser Empty Cup',
        maxPlayers: 4,
        entryFeeWei: ENTRY.toString(),
        onchainId: dudOnchain.toString(),
        startAt: Math.floor(Date.now() / 1000) + 10,
      }),
    })
    if (r.status !== 200) throw new Error(`create failed: ${JSON.stringify(r.body)}`)
    const dudId = r.body.id

    // One player pays in from the page.
    await p2.page.goto(`${SITE}/tournaments/${dudId}`, { waitUntil: 'networkidle' })
    const enter = p2.page.locator('.tn__join button')
    await enter.waitFor({ state: 'visible', timeout: 20_000 })
    await enter.click()
    await p2.page.locator('.tn__you .btn--ghost').waitFor({ state: 'visible', timeout: 90_000 })

    // Wait out the deadline on both clocks, then look at what the page says.
    while (Math.floor(Date.now() / 1000) <= Number(deadline)) {
      await new Promise((res) => setTimeout(res, 1000))
    }
    await p2.page.reload({ waitUntil: 'networkidle' })

    const you = p2.page.locator('.tn__you')
    await you.waitFor({ state: 'visible', timeout: 20_000 })
    const said = (await you.innerText()).replace(/\s+/g, ' ').trim()
    if (!/didn.t fill/i.test(said)) throw new Error(`the page says "${said.slice(0, 140)}"`)
    if (/leave & get refund/i.test(said)) {
      throw new Error('still offering a leave button that would revert past the deadline')
    }
    await p2.page.screenshot({ path: SHOTS + 'tn-didnt-fill.png' })

    // Unlocking refunds is a plain entrant's action — the pool lets anyone cancel
    // a tournament that can never run, so nobody waits on the organiser.
    await you.locator('button', { hasText: /unlock refunds/i }).click()
    await untilChain(
      'the pool never flipped to REFUNDING',
      async () => Number(await poolRead('statusOf', [dudOnchain])),
      (v) => v === POOL_STATUS.REFUNDING,
    )

    // And then the fee comes back through the same panel as any other refund.
    const addr = account('entrant2').address
    const panel = p2.page.locator('.claim')
    await panel.waitFor({ state: 'visible', timeout: 30_000 })
    await assertClaimStyled(p2.page)
    await panel.locator('button', { hasText: /claim refund/i }).click()
    await untilChain(
      'the refund was never credited',
      () => poolRead('balances', [addr]),
      (v) => v === ENTRY,
    )

    const walletBefore = await pub.getBalance({ address: addr })
    const withdraw = panel.locator('button', { hasText: /withdraw/i })
    await withdraw.waitFor({ state: 'visible', timeout: 30_000 })
    await withdraw.click()
    await panel.waitFor({ state: 'detached', timeout: 90_000 })

    if ((await poolRead('balances', [addr])) !== 0n) throw new Error('the pool still owes them')
    if ((await pub.getBalance({ address: addr })) <= walletBefore) {
      throw new Error('the wallet did not rise on withdraw')
    }
    console.log(`      one-player pot unlocked and refunded by its own entrant`)
  })

  await step('the runner-up is offered nothing to collect', async () => {
    // The loser of a paid tournament is still an on-chain entrant — `settle` only
    // flips the status, it never clears `joined` — so a panel keyed on that alone
    // would invite them to "reclaim" a fee that is now part of someone else's
    // prize. They are owed nothing and must be shown nothing.
    const rup = await openAt(e1, `/tournaments/${prizeId}`)
    await rup.page.locator('.tn__champion').waitFor({ state: 'visible', timeout: 30_000 })
    await rup.page.waitForTimeout(1500)
    const shown = await rup.page.locator('.claim').count()
    if (shown) {
      await rup.page.screenshot({ path: SHOTS + 'tn-runnerup-WRONG.png' })
      throw new Error('the runner-up was shown a claim panel')
    }
    if (rup.problems.length) throw new Error(rup.problems.join(' | '))
    await rup.ctx.close()
  })

  await step('a bracket with more than one round lays out in even columns', async () => {
    // Every tournament above is two players, so the bracket only ever had one
    // round — and one round used to stretch the final across the whole page.
    // A free four-player one draws a two-round bracket the moment it starts, with
    // no battles needed, which is all this needs to look at.
    const r = await api('/api/tournaments', {
      method: 'POST',
      headers: auth(organizer.token),
      body: JSON.stringify({ name: 'Browser Bracket Cup', maxPlayers: 4, entryFeeWei: '0' }),
    })
    if (r.status !== 200) throw new Error(`create failed: ${JSON.stringify(r.body)}`)
    const id = r.body.id

    for (const who of [e1, e2, alice, bob]) {
      const teams = await api('/api/teams', { headers: auth(who.token) })
      const j = await api(`/api/tournaments/${id}/join`, {
        method: 'POST', headers: auth(who.token), body: JSON.stringify({ teamId: teams.body[0].id }),
      })
      if (j.status !== 200) throw new Error(`${who.name} join failed: ${JSON.stringify(j.body)}`)
    }
    const s = await api(`/api/tournaments/${id}/start`, { method: 'POST', headers: auth(organizer.token) })
    if (s.status !== 200) throw new Error(`start failed: ${JSON.stringify(s.body)}`)

    await p2.page.goto(`${SITE}/tournaments/${id}`, { waitUntil: 'networkidle' })
    await p2.page.locator('.tn__bracket').waitFor({ state: 'visible', timeout: 20_000 })

    const titles = await p2.page.locator('.tn__round-title').allInnerTexts()
    if (titles.length !== 2) throw new Error(`${titles.length} rounds drawn, expected 2`)
    if (!/final/i.test(titles[titles.length - 1])) throw new Error(`last round is "${titles.at(-1)}"`)

    // Even columns: a round that grows to fill the page is what made a two-player
    // bracket look broken, and the same rule governs every other size.
    const widths = await p2.page.evaluate(() =>
      [...document.querySelectorAll('.tn__round')].map((e) => Math.round(e.getBoundingClientRect().width)),
    )
    if (new Set(widths).size !== 1) throw new Error(`round widths differ: ${JSON.stringify(widths)}`)
    if (widths[0] > 320) throw new Error(`rounds are ${widths[0]}px wide — they are still stretching`)

    const overflow = await p2.page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    await p2.page.screenshot({ path: SHOTS + 'tn-bracket-rounds.png' })
    if (overflow) throw new Error('the bracket page scrolls sideways')
    console.log(`      ${titles.join(' → ')}, ${widths[0]}px columns`)
  })

  await step('the finished tournament page holds up on a phone', async () => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    })
    await ctx.addInitScript(
      walletStub({
        address: account('entrant2').address,
        rpc: RPC,
        chainIdHex: '0x' + (await pub.getChainId()).toString(16),
      }),
    )
    await ctx.addInitScript((t) => localStorage.setItem('slabshowdown.session', t), e2.token)
    const page = await ctx.newPage()
    await page.goto(`${SITE}/tournaments/${prizeId}`, { waitUntil: 'networkidle' })
    await page.locator('.tn__bracket').waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(600)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    await page.screenshot({ path: SHOTS + 'tn-mobile.png' })
    await ctx.close()
    if (overflow) throw new Error('the tournament page scrolls sideways at 390px')
  })

  await step('no page errors anywhere in the paid-tournament flow', async () => {
    const all = [...org.problems, ...p1.problems, ...p2.problems]
    if (all.length) throw new Error(all.join(' | '))
  })

  await org.ctx.close()
  await p2.ctx.close()
}

/* mobile ---------------------------------------------------------- */

await step('the banner is usable on a phone-sized screen', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await ctx.addInitScript(
    walletStub({
      address: account(loser.name).address,
      rpc: RPC,
      chainIdHex: '0x' + (await pub.getChainId()).toString(16),
    }),
  )
  await ctx.addInitScript(
    (t) => localStorage.setItem('slabshowdown.session', t),
    loser.token,
  )
  const page = await ctx.newPage()
  await page.goto(`${SITE}/play`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  await page.screenshot({ path: SHOTS + 'mobile-play.png', fullPage: false })
  if (overflow) throw new Error('the page scrolls sideways at 390px')
  await ctx.close()
})

await browser.close()

console.log(`\nscreenshots: ${SHOTS}`)
const ok = summary('ui pass')
process.exit(ok ? 0 : 1)
