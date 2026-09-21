/**
 * Drives a real Chrome against a running server and reports what the console
 * actually does in a browser.
 *
 * Static checks and Node-side imports only prove a module graph resolves. They
 * cannot see a top-level throw that stops every later module, which renders as
 * a page where nothing is wired up and nothing is logged. This clicks through
 * the console and fails on any console error, page exception or failed
 * request.
 *
 * No dependencies: Chrome is driven over the DevTools Protocol, and Node 24
 * has a WebSocket client built in.
 *
 *   node scripts/browser-check.mjs http://127.0.0.1:3200 admin admin123
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [baseUrl, username, password] = process.argv.slice(2)
if (!baseUrl || !username || !password) {
  console.error('usage: browser-check.mjs <baseUrl> <username> <password>')
  process.exit(2)
}

const CHROME = process.env.CHROME_BIN ?? 'google-chrome-stable'
/** A generated key is a long random string; anything shorter is a bug. */
const MIN_SECRET_LENGTH = 16

/**
 * A stand-in upstream, so the playground can be driven end to end.
 *
 * The gateway relays to whatever a channel points at; pointing one at a dead
 * port only ever exercises the failure path. This answers /v1/models and
 * streams a chat completion in the OpenAI shape, slowly when the prompt
 * asks for it so the stop button has something to interrupt.
 */
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 3206)
const UPSTREAM_MODEL = 'check-model'

function startFakeUpstream() {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: UPSTREAM_MODEL }, { id: `${UPSTREAM_MODEL}-mini` }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let slow = false
        try {
          slow = /slow/i.test(JSON.parse(body).messages?.at(-1)?.content ?? '')
        } catch {
          // An unparsable body still gets an answer; the test is about the page.
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const words = slow ? Array.from({ length: 40 }, (_, i) => `w${i} `) : ['Hello', ' from', ' the', ' fake', ' upstream.']
        const gap = slow ? 250 : 20
        let index = 0
        const tick = () => {
          if (res.destroyed) return
          if (index < words.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[index] } }] })}\n\n`)
            index += 1
            setTimeout(tick, gap)
            return
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: words.length } })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }
        tick()
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  return new Promise((resolve) => server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server)))
}
const PORT = Number(process.env.CDP_PORT ?? 9222)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- CDP plumbing ---------------------------------------------------------

let nextId = 1

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    const events = []
    const waiters = []

    socket.addEventListener('open', () => resolve({ send, events, close: () => socket.close() }))
    socket.addEventListener('error', reject)

    socket.addEventListener('message', (message) => {
      // A malformed frame must not throw inside the listener: that would kill
      // the socket and leave every pending call hanging with no explanation.
      let data
      try {
        data = JSON.parse(message.data)
      } catch {
        return
      }

      if (data.id && pending.has(data.id)) {
        const { resolve: done, reject: fail } = pending.get(data.id)
        pending.delete(data.id)
        if (data.error) fail(new Error(JSON.stringify(data.error)))
        else done(data.result)
        return
      }
      events.push(data)
      for (const waiter of waiters.splice(0)) waiter(data)
    })

    function send(method, params = {}, sessionId) {
      const id = nextId++
      return new Promise((done, fail) => {
        pending.set(id, { resolve: done, reject: fail })
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      })
    }
  })
}

async function cdpTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return response.json()
}

// ---- checks ---------------------------------------------------------------

const problems = []
const steps = []

const record = (name, ok, detail = '') => {
  steps.push({ name, ok, detail })
  if (!ok) problems.push(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'ft-chrome-'))
  const upstream = await startFakeUpstream()

  // A channel that serves the fake upstream's models. Created and removed by
  // this run, so the deployment under test is left as it was found.
  const adminAuth = async () => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then((r) => r.json())
    return { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' }
  }
  const seedHeaders = await adminAuth()
  // The billing policy defaults to reject, so an unpriced model is refused
  // with 403 before it ever reaches a channel. The fake model gets a price.
  await fetch(`${baseUrl}/api/admin/prices`, {
    method: 'POST',
    headers: seedHeaders,
    body: JSON.stringify({ model: UPSTREAM_MODEL, input_price: 1, output_price: 2, cached_price: 0, per_request_price: 0 }),
  })
  const seeded = await fetch(`${baseUrl}/api/admin/channels`, {
    method: 'POST',
    headers: seedHeaders,
    body: JSON.stringify({
      name: 'browser-check-live',
      base_url: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      api_key: 'sk-fake',
      status: 1,
      priority: 10,
      weight: 1,
      groups: ['default'],
      models: [UPSTREAM_MODEL, `${UPSTREAM_MODEL}-mini`],
      supported_protocols: ['chat_completions'],
    }),
  }).then((r) => r.json())
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1400,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let client
  try {
    // Wait for the debugging port to answer.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await cdpTargets()
        break
      } catch {
        await sleep(250)
      }
    }

    const browserInfo = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json())
    console.log(`browser: ${browserInfo.Browser}\n`)

    client = await connect(browserInfo.webSocketDebuggerUrl)

    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })

    const consoleErrors = []
    const pageErrors = []
    const failedRequests = []

    client.events.length = 0
    const drain = () => {
      for (const event of client.events.splice(0)) {
        if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
          consoleErrors.push(event.params.args.map((a) => a.value ?? a.description).join(' '))
        }
        if (event.method === 'Runtime.exceptionThrown') {
          const d = event.params.exceptionDetails
          pageErrors.push(d.exception?.description ?? d.text)
        }
        if (event.method === 'Network.responseReceived') {
          const { status, url } = event.params.response
          // 401 on /api/me before signing in is expected, not a failure. So
          // is a failed relay: /v1/ goes to an upstream, and the logs check
          // deliberately relays to a dead one to see the row arrive.
          if (status >= 400 && !url.includes('/api/me') && !url.includes('/api/auth/') && !url.includes('/v1/')) {
            failedRequests.push(`${status} ${url}`)
          }
        }
      }
    }

    await client.send('Runtime.enable', {}, sessionId)
    await client.send('Network.enable', {}, sessionId)
    await client.send('Page.enable', {}, sessionId)

    const evaluate = async (expression) => {
      const result = await client.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
      }
      return result.result.value
    }

    const goto = async (url) => {
      await client.send('Page.navigate', { url }, sessionId)
      await sleep(1200)
      drain()
    }

    // ---- 1. the login page renders
    await goto(`${baseUrl}/`)
    const loginReady = await evaluate(
      `!!document.querySelector('#login-username') && !!document.querySelector('#login-password')`,
    )
    record('login form renders', loginReady)

    const bootFailed = await evaluate(`!!document.querySelector('.fatal')`)
    record('no module boot failure', !bootFailed)

    // ---- 2. signing in reaches the console
    await evaluate(`
      (() => {
        const set = (sel, value) => {
          const node = document.querySelector(sel)
          node.value = value
          node.dispatchEvent(new Event('input', { bubbles: true }))
        }
        set('#login-username', ${JSON.stringify(username)})
        set('#login-password', ${JSON.stringify(password)})
        document.querySelector('form').requestSubmit()
      })()
    `)
    await sleep(2000)
    drain()

    const shellUp = await evaluate(`!!document.querySelector('.app-shell')`)
    record('sign-in mounts the console shell', shellUp)

    const navCount = await evaluate(`document.querySelectorAll('.nav-item').length`)
    record('sidebar renders navigation', navCount > 0, `${navCount} items`)

    // ---- 3. the dashboard actually loaded data
    const statCards = await evaluate(`document.querySelectorAll('.stat-card').length`)
    record('dashboard renders stat cards', statCards >= 4, `${statCards} cards`)

    const balance = await evaluate(
      `document.querySelector('.balance-chip__value')?.textContent ?? ''`,
    )
    record('header shows a balance', /\$/.test(balance), balance)

    // A fresh database has no calls, so the chart shows its empty state, and
    // that state's button is the first in-app link a new operator meets. It
    // has to be a router hop, not a page load.
    const emptyAction = await evaluate(`
      [...document.querySelectorAll('.empty .btn')]
        .find((b) => /去配置渠道|去创建密钥/.test(b.textContent))?.textContent.trim() ?? ''
    `)
    record('an empty dashboard offers a next step', emptyAction !== '', emptyAction)

    const loadsBeforeEmptyAction = await evaluate(`window.performance.getEntriesByType('navigation').length`)
    await evaluate(`
      [...document.querySelectorAll('.empty .btn')]
        .find((b) => /去配置渠道|去创建密钥/.test(b.textContent))?.click()
    `)
    await sleep(1200)
    drain()
    const emptyActionPath = await evaluate(`location.pathname`)
    const loadsAfterEmptyAction = await evaluate(`window.performance.getEntriesByType('navigation').length`)
    record(
      'the next step is a client-side hop to the page it names',
      /^\/(admin\/channels|tokens)$/.test(emptyActionPath) && loadsAfterEmptyAction === loadsBeforeEmptyAction,
      `${emptyActionPath}, ${loadsAfterEmptyAction - loadsBeforeEmptyAction} extra document loads`,
    )

    // ---- 4. client-side navigation works
    // 个人设置 is deliberately absent from the sidebar (nav marks it hidden);
    // the account menu is its only entry point, so that is what gets driven.
    await evaluate(`document.querySelector('.user-trigger').click()`)
    await sleep(300)
    const menuOpen = await evaluate(
      `[...document.querySelectorAll('.dropdown__item')].some((i) => i.textContent.includes('个人设置'))`,
    )
    record('account menu offers 个人设置', menuOpen)

    await evaluate(`
      [...document.querySelectorAll('.dropdown__item')]
        .find((i) => i.textContent.includes('个人设置'))?.click()
    `)
    await sleep(900)
    drain()

    const navigated = await evaluate(`window.performance.getEntriesByType('navigation').length`)
    const onProfile = await evaluate(
      `location.pathname === '/profile' && !!document.querySelector('#profile-name')`,
    )
    record('account menu navigates to 个人设置', onProfile)
    // One navigation entry means the document was never reloaded — the router
    // swapped the page rather than the browser fetching a new one.
    record('navigation stayed client-side', navigated === 1, `${navigated} document loads`)

    // A deep link typed straight into the address bar has to work too: that is
    // the path that depends on the server's index fallback, not on the router.
    await goto(`${baseUrl}/profile`)
    const deepLink = await evaluate(`!!document.querySelector('#profile-name')`)
    record('/profile survives a full page load', deepLink)

    // ---- 5. an admin page with a table and a modal
    const groupsLink = await evaluate(`!!document.querySelector('a[href="/admin/groups"]')`)
    if (groupsLink) {
      await evaluate(`document.querySelector('a[href="/admin/groups"]').click()`)
      await sleep(1400)
      drain()

      const tableUp = await evaluate(
        `location.pathname === '/admin/groups' && !!document.querySelector('.table')`,
      )
      record('分组倍率 renders its table', tableUp)

      const rowCount = await evaluate(`document.querySelectorAll('.table tbody tr').length`)
      record('分组倍率 loaded rows from the API', rowCount > 0, `${rowCount} rows`)

      // The editor is the page's most stateful control; if the modal opens and
      // traps focus, the form plumbing underneath it is wired.
      await evaluate(`
        [...document.querySelectorAll('.btn')]
          .find((b) => b.textContent.includes('新建分组'))?.click()
      `)
      await sleep(600)
      drain()
      const modalUp = await evaluate(
        `!!document.querySelector('.modal') && !!document.querySelector('#group-name')`,
      )
      record('新建分组 opens its editor', modalUp)

      await evaluate(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      `)
      await sleep(400)
      const modalGone = await evaluate(`!document.querySelector('.modal')`)
      record('Escape closes the editor', modalGone)
    } else {
      record('分组倍率 reachable', false, 'admin nav item missing — signed in as a non-admin?')
    }

    // ---- 5b. the code pages: paging, filtering, bulk selection, generation
    for (const spec of [
      { path: '/admin/redemptions', label: '兑换码', create: '生成兑换码' },
      { path: '/admin/invites', label: '邀请码', create: '生成邀请码' },
    ]) {
      await evaluate(`document.querySelector('a[href="${spec.path}"]').click()`)
      await sleep(1400)
      drain()

      const listed = await evaluate(
        `location.pathname === '${spec.path}' && !!document.querySelector('.table')`,
      )
      record(`${spec.label} renders its table`, listed)

      // The generate dialog is the page's real work: it has to produce codes,
      // show them, and survive a click on the backdrop without losing them.
      await evaluate(`
        [...document.querySelectorAll('.btn')]
          .find((b) => b.textContent.includes(${JSON.stringify(spec.create)}))?.click()
      `)
      await sleep(600)
      const formUp = await evaluate(`!!document.querySelector('#code-count')`)
      record(`${spec.label} opens the generate form`, formUp)

      await evaluate(`
        (() => {
          const count = document.querySelector('#code-count')
          count.value = '2'
          count.dispatchEvent(new Event('input', { bubbles: true }))
          const note = document.querySelector('#code-note')
          note.value = 'browser-check'
          note.dispatchEvent(new Event('input', { bubbles: true }))
        })()
      `)
      await evaluate(`
        [...document.querySelectorAll('.modal .btn')]
          .find((b) => b.textContent.trim() === '生成')?.click()
      `)
      await sleep(1600)
      drain()

      const codes = await evaluate(
        `document.querySelector('.code-block')?.textContent.trim().split('\\n').length ?? 0`,
      )
      record(`${spec.label} generates the requested codes`, codes === 2, `${codes} codes`)

      // A stray click beside the dialog must not take the batch with it.
      await evaluate(`
        document.querySelector('.modal-scrim')
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      `)
      await sleep(400)
      const survived = await evaluate(`!!document.querySelector('.code-block')`)
      record(`${spec.label} keeps the codes on a backdrop click`, survived)

      await evaluate(`
        [...document.querySelectorAll('.modal .btn')]
          .find((b) => b.textContent.trim() === '完成')?.click()
      `)
      await sleep(1200)
      drain()

      const rows = await evaluate(`document.querySelectorAll('.table tbody tr').length`)
      record(`${spec.label} lists the new codes`, rows >= 2, `${rows} rows`)

      // Selecting drives the bulk action into view; it must count correctly.
      await evaluate(`
        document.querySelector('.table tbody tr .checkbox')?.click()
      `)
      await sleep(400)
      const bulk = await evaluate(`
        [...document.querySelectorAll('.btn')]
          .some((b) => /删除选中 1 个/.test(b.textContent))
      `)
      record(`${spec.label} shows the bulk action for a selection`, bulk)

      // Filtering to a status the new codes do not have must empty the table.
      await evaluate(`
        (() => {
          const select = document.querySelector('.filter-bar select')
          select.value = '2'
          select.dispatchEvent(new Event('change', { bubbles: true }))
        })()
      `)
      await sleep(1200)
      drain()
      const filtered = await evaluate(`
        !!document.querySelector('.empty') ||
        document.querySelectorAll('.table tbody tr').length === 0
      `)
      record(`${spec.label} status filter reaches the server`, filtered)

      await evaluate(`
        [...document.querySelectorAll('.btn')]
          .find((b) => b.textContent.trim() === '重置')?.click()
      `)
      await sleep(1200)
      drain()
    }

    // The loop ends on 邀请码. Invite-gated registration is off by default, so
    // the page carries a notice pointing at 全局设置; that link has to stay a
    // router hop as well.
    const inviteNotice = await evaluate(`
      [...document.querySelectorAll('.btn')].some((b) => b.textContent.trim() === '去开启')
    `)
    record('邀请码 explains that registration is not invite-gated', inviteNotice)

    const loadsBeforeInviteHop = await evaluate(`window.performance.getEntriesByType('navigation').length`)
    await evaluate(`
      [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '去开启')?.click()
    `)
    await sleep(1200)
    drain()
    const inviteHopPath = await evaluate(`location.pathname`)
    const loadsAfterInviteHop = await evaluate(`window.performance.getEntriesByType('navigation').length`)
    record(
      '去开启 hops to 全局设置 client-side',
      inviteHopPath === '/admin/settings' && loadsAfterInviteHop === loadsBeforeInviteHop,
      `${inviteHopPath}, ${loadsAfterInviteHop - loadsBeforeInviteHop} extra document loads`,
    )

    // ---- 5c. user management: create, top-up, and the self-protection rules
    await evaluate(`document.querySelector('a[href="/admin/users"]').click()`)
    await sleep(1400)
    drain()

    record(
      '用户管理 renders its table',
      await evaluate(
        `location.pathname === '/admin/users' && !!document.querySelector('.table')`,
      ),
    )

    // The signed-in admin must not be able to lock itself out: its own status
    // switch is disabled and its delete entry is refused.
    record(
      'the current account cannot disable itself',
      await evaluate(`
        (() => {
          const row = [...document.querySelectorAll('.table tbody tr')]
            .find((r) => r.textContent.includes('当前登录'))
          return !!row && row.querySelector('.switch').disabled
        })()
      `),
    )

    const created = `checkuser${Date.now().toString().slice(-6)}`
    await evaluate(`
      [...document.querySelectorAll('.btn')]
        .find((b) => b.textContent.includes('新建用户'))?.click()
    `)
    await sleep(600)
    record('新建用户 opens its editor', await evaluate(`!!document.querySelector('#user-name')`))

    // A password under 8 characters has to be refused in the form, not by the
    // server: the field owns that rule.
    await evaluate(`
      (() => {
        const set = (s, v) => {
          const n = document.querySelector(s)
          n.value = v
          n.dispatchEvent(new Event('input', { bubbles: true }))
        }
        set('#user-name', ${JSON.stringify(created)})
        set('#user-password', 'short')
      })()
    `)
    await evaluate(`
      [...document.querySelectorAll('.modal .btn')]
        .find((b) => b.textContent.trim() === '创建')?.click()
    `)
    await sleep(500)
    record(
      'short password is rejected by the form',
      await evaluate(`
        !!document.querySelector('.modal') &&
        [...document.querySelectorAll('.field__error')].some((e) => e.textContent.includes('8 位'))
      `),
    )

    await evaluate(`
      (() => {
        const n = document.querySelector('#user-password')
        n.value = 'browsercheck123'
        n.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await evaluate(`
      [...document.querySelectorAll('.modal .btn')]
        .find((b) => b.textContent.trim() === '创建')?.click()
    `)
    await sleep(1600)
    drain()

    record(
      '新建用户 creates the account',
      await evaluate(`
        !document.querySelector('.modal') &&
        [...document.querySelectorAll('.table tbody tr')]
          .some((r) => r.textContent.includes(${JSON.stringify(created)}))
      `),
    )

    // The top-up dialog adds to the balance, so it previews the result and
    // renames its button when the amount turns negative.
    await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.table tbody tr')]
          .find((r) => r.textContent.includes(${JSON.stringify(created)}))
        ;[...row.querySelectorAll('.btn')].find((b) => b.textContent.includes('充值')).click()
      })()
    `)
    await sleep(600)
    record('充值 opens its dialog', await evaluate(`!!document.querySelector('#quota-amount')`))

    await evaluate(`
      (() => {
        const n = document.querySelector('#quota-amount')
        n.value = '-5'
        n.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(300)
    record(
      'a negative amount switches to 确认扣减',
      await evaluate(`
        [...document.querySelectorAll('.modal .btn')]
          .some((b) => b.textContent.trim() === '确认扣减')
      `),
    )

    await evaluate(`
      (() => {
        const n = document.querySelector('#quota-amount')
        n.value = '25'
        n.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(300)
    await evaluate(`
      [...document.querySelectorAll('.modal .btn')]
        .find((b) => b.textContent.trim() === '确认充值')?.click()
    `)
    await sleep(1600)
    drain()

    record(
      '充值 credits the account',
      await evaluate(`
        (() => {
          const row = [...document.querySelectorAll('.table tbody tr')]
            .find((r) => r.textContent.includes(${JSON.stringify(created)}))
          return !!row && /\\$2[56]\\./.test(row.textContent)
        })()
      `),
      await evaluate(`
        ([...document.querySelectorAll('.table tbody tr')]
          .find((r) => r.textContent.includes(${JSON.stringify(created)})) || {}).textContent
          ?.match(/\\$[\\d.]+/)?.[0] ?? 'no row'
      `),
    )

    // Clean up after itself: the check must be repeatable against the same
    // database without piling up accounts.
    await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.table tbody tr')]
          .find((r) => r.textContent.includes(${JSON.stringify(created)}))
        row.querySelector('[aria-haspopup="menu"]').click()
      })()
    `)
    await sleep(400)
    await evaluate(`
      [...document.querySelectorAll('.dropdown__item')]
        .find((i) => i.textContent.includes('删除用户'))?.click()
    `)
    await sleep(600)
    await evaluate(`
      [...document.querySelectorAll('.modal .btn')]
        .find((b) => b.textContent.trim() === '删除')?.click()
    `)
    await sleep(1600)
    drain()
    record(
      'the created account is removed again',
      await evaluate(`
        ![...document.querySelectorAll('.table tbody tr')]
          .some((r) => r.textContent.includes(${JSON.stringify(created)}))
      `),
    )

    // ---- 5d. the plaza: vendor chips filter what the keyword left
    await evaluate(`document.querySelector('a[href="/models"]').click()`)
    await sleep(1400)
    drain()

    const plazaReady = await evaluate(`
      location.pathname === '/models' &&
      (!!document.querySelector('.model-card') || !!document.querySelector('.empty'))
    `)
    record('模型广场 renders', plazaReady)

    // An empty catalogue is a legitimate state on a fresh deployment, so the
    // filtering assertions only run when there is something to filter.
    const cardCount = await evaluate(`document.querySelectorAll('.model-card').length`)
    if (cardCount > 0) {
      record('模型广场 shows vendor chips', await evaluate(`document.querySelectorAll('.chip').length > 0`))

      const beforeChip = cardCount
      await evaluate(`[...document.querySelectorAll('.chip')].at(-1).click()`)
      await sleep(400)
      const afterChip = await evaluate(`document.querySelectorAll('.model-card').length`)
      record(
        'a vendor chip narrows the grid',
        afterChip > 0 && afterChip <= beforeChip,
        `${beforeChip} -> ${afterChip}`,
      )

      // Clicking the active chip clears the filter rather than doing nothing.
      await evaluate(`document.querySelector('.chip--active').click()`)
      await sleep(400)
      record(
        'clicking the active chip clears the filter',
        (await evaluate(`document.querySelectorAll('.model-card').length`)) === beforeChip,
      )
    } else {
      record('模型广场 empty state is explained', await evaluate(`!!document.querySelector('.empty__title')`))
    }

    // ---- 5e. prices: policy, sorting, and the guarded import
    await evaluate(`document.querySelector('a[href="/admin/prices"]').click()`)
    await sleep(1600)
    drain()

    record(
      '模型价格 renders its table',
      await evaluate(
        `location.pathname === '/admin/prices' && !!document.querySelector('.table')`,
      ),
    )
    record(
      '模型价格 states the unpriced policy',
      await evaluate(`
        [...document.querySelectorAll('.alert')]
          .some((a) => a.textContent.includes('未配价模型的处理方式'))
      `),
    )

    // Adding a price is the page's core write; the row has to appear.
    const priceModel = `check-model-${Date.now().toString().slice(-6)}`
    await evaluate(`
      [...document.querySelectorAll('.btn')]
        .find((b) => b.textContent.includes('新增价格'))?.click()
    `)
    await sleep(600)
    record('新增价格 opens its editor', await evaluate(`!!document.querySelector('#price-model')`))

    await evaluate(`
      (() => {
        const set = (s, v) => {
          const n = document.querySelector(s)
          n.value = v
          n.dispatchEvent(new Event('input', { bubbles: true }))
        }
        set('#price-model', ${JSON.stringify(priceModel)})
        set('#price-input', '1.25')
        set('#price-output', '5')
      })()
    `)
    await evaluate(`
      [...document.querySelectorAll('.modal .btn')]
        .find((b) => b.textContent.trim() === '创建')?.click()
    `)
    await sleep(1600)
    drain()

    // The catalogue seeds hundreds of models, so the new row is not reliably
    // on the current page. Narrow to it the way an operator would.
    const findPriceRow = async () => {
      await evaluate(`
        (() => {
          const box = document.querySelector('.page-header input[type="text"]')
          box.value = ${JSON.stringify(priceModel)}
          box.dispatchEvent(new Event('input', { bubbles: true }))
        })()
      `)
      // searchInput debounces before it filters.
      await sleep(700)
      return evaluate(`
        [...document.querySelectorAll('.table tbody tr')]
          .some((r) => r.textContent.includes(${JSON.stringify(priceModel)}))
      `)
    }

    record(
      '新增价格 writes the row',
      (await evaluate(`!document.querySelector('.modal')`)) && (await findPriceRow()),
    )

    // Sorting is client-side over the whole table, so the header has to
    // actually reorder rows and announce the direction.
    await evaluate(`
      [...document.querySelectorAll('.th-sort')]
        .find((b) => b.textContent.includes('输入'))?.click()
    `)
    await sleep(400)
    record(
      'a sortable header announces its direction',
      await evaluate(`
        [...document.querySelectorAll('th')]
          .some((th) => th.getAttribute('aria-sort') === 'ascending')
      `),
    )
    await evaluate(`
      [...document.querySelectorAll('.th-sort')]
        .find((b) => b.textContent.includes('输入'))?.click()
    `)
    await sleep(400)
    record(
      'clicking the same header flips to descending',
      await evaluate(`
        [...document.querySelectorAll('th')]
          .some((th) => th.getAttribute('aria-sort') === 'descending')
      `),
    )

    // The billing policy dialog reveals its fallback fields only when the
    // fallback option is chosen.
    await evaluate(`
      [...document.querySelectorAll('.btn')]
        .find((b) => b.textContent.includes('计费策略'))?.click()
    `)
    await sleep(600)
    record('计费策略 opens', await evaluate(`!!document.querySelector('#policy-choice')`))

    record(
      'fallback prices are hidden until chosen',
      await evaluate(`!document.querySelector('#fb-input')`),
    )
    await evaluate(`
      (() => {
        const s = document.querySelector('#policy-choice')
        s.value = 'fallback'
        s.dispatchEvent(new Event('change', { bubbles: true }))
      })()
    `)
    await sleep(400)
    record(
      'choosing 兑底价 reveals its fields',
      await evaluate(`!!document.querySelector('#fb-input')`),
    )

    // All-zero fallback prices are the same as free; the form must refuse it.
    await evaluate(`
      [...document.querySelectorAll('.modal .btn')]
        .find((b) => b.textContent.trim() === '保存')?.click()
    `)
    await sleep(700)
    record(
      'an all-zero fallback is refused',
      await evaluate(`!!document.querySelector('#policy-choice')`),
    )

    await evaluate(`
      [...document.querySelectorAll('.modal .btn')]
        .find((b) => b.textContent.trim() === '取消')?.click()
    `)
    await sleep(500)

    // Clean up the row this check created. Sorting moved it off the first
    // page, so it is located by search rather than by position.
    await findPriceRow()
    await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.table tbody tr')]
          .find((r) => r.textContent.includes(${JSON.stringify(priceModel)}))
        if (!row) throw new Error('price row not found after search')
        ;[...row.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '删除').click()
      })()
    `)
    await sleep(600)
    await evaluate(`
      [...document.querySelectorAll('.modal .btn')]
        .find((b) => b.textContent.trim() === '删除')?.click()
    `)
    await sleep(1600)
    drain()
    record('the created price is removed again', !(await findPriceRow()))

    // ---- 5f. icons: every glyph is a filled Ant Design path, not a stroke
    record(
      'icons render as filled Ant Design paths',
      await evaluate(`
        (() => {
          const svgs = [...document.querySelectorAll('svg.icon')]
          return svgs.length > 0 && svgs.every((s) =>
            s.getAttribute('fill') === 'currentColor' &&
            !s.hasAttribute('stroke') &&
            /^(64 64 896 896|0 0 1024 1024)$/.test(s.getAttribute('viewBox')) &&
            s.querySelector('path')?.getAttribute('d')?.length > 20)
        })()
      `),
      await evaluate(`document.querySelectorAll('svg.icon').length + ' glyphs'`),
    )

    // ---- 5g. settings: dirty tracking, tab dots, and the blocklist editor
    await evaluate(`document.querySelector('a[href="/admin/settings"]').click()`)
    await sleep(1400)
    drain()

    record(
      '全局设置 renders its tabs',
      await evaluate(
        `location.pathname === '/admin/settings' && document.querySelectorAll('.tabs__item').length === 5`,
      ),
    )
    record('no save bar while nothing changed', await evaluate(`!document.querySelector('.settings-savebar')`))

    // Editing a field must raise the save bar and mark the owning tab.
    await evaluate(`
      (() => {
        const n = document.querySelector('[aria-label="默认优先级"]')
        n.value = String(Number(n.value) + 1)
        n.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await sleep(300)
    record('a change raises the save bar', await evaluate(`!!document.querySelector('.settings-savebar')`))
    record(
      'the changed tab carries a dot',
      await evaluate(`
        !!document.querySelector('.tabs__item--active .tabs__dot')
      `),
    )

    // The dot has to stay visible from a different tab.
    await evaluate(`[...document.querySelectorAll('.tabs__item')].find((t) => t.textContent.includes('屏蔽规则')).click()`)
    await sleep(300)
    record(
      'the dot is visible from another tab',
      await evaluate(`
        !document.querySelector('.tabs__item--active .tabs__dot') &&
        document.querySelectorAll('.tabs__dot').length === 1
      `),
    )

    // Adding a group opens it, with the editor's fields ready to type in.
    await evaluate(`[...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('添加规则组')).click()`)
    await sleep(400)
    record(
      '添加规则组 adds an open group',
      await evaluate(`
        !!document.querySelector('.rule-group--open') &&
        !!document.querySelector('.rule-group__body textarea')
      `),
    )
    record(
      'the blocklist tab now carries a dot too',
      await evaluate(`document.querySelectorAll('.tabs__dot').length === 2`),
    )

    // Discarding restores the baseline and drops every marker.
    await evaluate(`[...document.querySelectorAll('.settings-savebar .btn')].find((b) => b.textContent.includes('放弃修改')).click()`)
    await sleep(400)
    record(
      '放弃修改 clears the save bar and every dot',
      await evaluate(`
        !document.querySelector('.settings-savebar') &&
        document.querySelectorAll('.tabs__dot').length === 0 &&
        !document.querySelector('.rule-group')
      `),
    )

    // ---- 5h. tokens: endpoints, creation, and the once-only secret
    await evaluate(`document.querySelector('a[href="/tokens"]').click()`)
    await sleep(1400)
    drain()

    record(
      'API 密钥 renders',
      await evaluate(`location.pathname === '/tokens' && !!document.querySelector('.table')`),
    )

    // The endpoint card folds and unfolds, and remembers it.
    const wasCollapsed = await evaluate(`localStorage.getItem('faketoken-endpoints-collapsed') === '1'`)
    await evaluate(`
      [...document.querySelectorAll('.card__extra .btn')].find((b) => /展开示例|收起/.test(b.textContent)).click()
    `)
    await sleep(300)
    record(
      'the endpoint card toggles and persists',
      (await evaluate(`localStorage.getItem('faketoken-endpoints-collapsed') === '1'`)) !== wasCollapsed,
    )
    if (!wasCollapsed) {
      // Put it back expanded so the tabs assertion below has something to see.
      await evaluate(`
        [...document.querySelectorAll('.card__extra .btn')].find((b) => /展开示例|收起/.test(b.textContent)).click()
      `)
      await sleep(300)
    }
    record(
      'endpoint examples show three protocol tabs',
      await evaluate(`document.querySelectorAll('.card .tabs__item').length === 3`),
    )

    const tokenName = `check-key-${Date.now().toString().slice(-6)}`
    await evaluate(`[...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('新建密钥')).click()`)
    await sleep(600)
    record('新建密钥 opens its editor', await evaluate(`!!document.querySelector('#token-name')`))

    // The quota field only appears once "unlimited" is switched off.
    record(
      'quota is hidden while unlimited',
      await evaluate(`document.querySelector('#token-quota').closest('.field').style.display === 'none'`),
    )

    // A short custom key has to be confirmed before it is accepted.
    await evaluate(`
      (() => {
        const set = (s, v) => {
          const n = document.querySelector(s)
          n.value = v
          n.dispatchEvent(new Event('input', { bubbles: true }))
        }
        set('#token-name', ${JSON.stringify(tokenName)})
        set('#token-key', 'short')
      })()
    `)
    await evaluate(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '创建').click()`)
    await sleep(600)
    record(
      'a short key asks for confirmation',
      await evaluate(`
        document.querySelectorAll('.modal').length === 2 &&
        [...document.querySelectorAll('.modal')].at(-1).textContent.includes('密钥只有')
      `),
    )
    // Two dialogs are open: the editor, and the confirmation above it. The
    // cancel has to be the confirmation's, or the whole editor goes with it.
    await evaluate(`
      [...[...document.querySelectorAll('.modal')].at(-1).querySelectorAll('.btn')]
        .find((b) => b.textContent.trim() === '取消').click()
    `)
    await sleep(400)
    record(
      'declining the weak key keeps the editor open',
      await evaluate(`document.querySelectorAll('.modal').length === 1 && !!document.querySelector('#token-key')`),
    )

    // Let the server generate one instead.
    await evaluate(`
      (() => {
        const n = document.querySelector('#token-key')
        n.value = ''
        n.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await evaluate(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '创建').click()`)
    await sleep(1800)
    drain()

    const secret = await evaluate(`document.querySelector('.secret-box')?.textContent.trim() ?? ''`)
    record('creation shows the secret once', secret.length >= MIN_SECRET_LENGTH, `${secret.length} chars`)

    // A stray click beside the dialog must not take the only display of the
    // key with it.
    await evaluate(`document.querySelector('.modal-scrim').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(300)
    record('the secret survives a backdrop click', await evaluate(`!!document.querySelector('.secret-box')`))

    await evaluate(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '关闭').click()`)
    await sleep(1200)
    drain()
    record(
      'the new key is listed',
      await evaluate(`
        [...document.querySelectorAll('.table tbody tr')].some((r) => r.textContent.includes(${JSON.stringify(tokenName)}))
      `),
    )

    // Clean up.
    await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.table tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(tokenName)}))
        ;[...row.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '删除').click()
      })()
    `)
    await sleep(500)
    await evaluate(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '删除').click()`)
    await sleep(1400)
    drain()
    record(
      'the created key is removed again',
      await evaluate(`
        ![...document.querySelectorAll('.table tbody tr')].some((r) => r.textContent.includes(${JSON.stringify(tokenName)}))
      `),
    )

    // ---- 5i. channels: the largest page — expand, drawer, archive round-trip
    await evaluate(`document.querySelector('a[href="/admin/channels"]').click()`)
    await sleep(1600)
    drain()

    record(
      '渠道管理 renders its table',
      await evaluate(`location.pathname === '/admin/channels' && !!document.querySelector('.table')`),
    )
    record(
      '渠道管理 lists the seeded channel',
      await evaluate(`[...document.querySelectorAll('.table tbody tr')].some((r) => r.textContent.includes('browser-check'))`),
    )

    // The detail row is where the full model list lives; it must open and close.
    await evaluate(`document.querySelector('.expand-toggle').click()`)
    await sleep(400)
    record(
      'a row expands into its detail cards',
      await evaluate(`!!document.querySelector('.row-detail') && document.querySelectorAll('.detail-card').length >= 4`),
    )
    await evaluate(`document.querySelector('.expand-toggle--open').click()`)
    await sleep(300)
    record('the detail row closes again', await evaluate(`!document.querySelector('.row-detail')`))

    // Priority is editable in place: a tag until clicked, then a box.
    await evaluate(`[...document.querySelectorAll('.tag--clickable')].find((t) => /^P-?\\d+$/.test(t.textContent.trim())).click()`)
    await sleep(300)
    record('priority tag turns into an input on click', await evaluate(`!!document.querySelector('.inline-number')`))
    await evaluate(`
      (() => {
        const box = document.querySelector('.inline-number')
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })()
    `)
    await sleep(300)
    record('Escape reverts the inline edit', await evaluate(`!document.querySelector('.inline-number')`))

    // The action menu is the page's hub; the drawer is its largest form.
    // Picked by name: the live channel this run seeds sorts above it.
    await evaluate(`
      [...document.querySelectorAll('.table tbody tr')]
        .find((r) => r.textContent.includes('browser-check') && !r.textContent.includes('browser-check-live'))
        .querySelector('[aria-haspopup="menu"]').click()
    `)
    await sleep(300)
    record(
      'the row menu offers every action',
      await evaluate(`document.querySelectorAll('.dropdown__item').length === 9`),
      await evaluate(`document.querySelectorAll('.dropdown__item').length + ' items'`),
    )
    await evaluate(`[...document.querySelectorAll('.dropdown__item')].find((i) => i.textContent.includes('编辑渠道')).click()`)
    await sleep(1200)
    drain()
    record(
      '编辑渠道 opens the drawer with the row loaded',
      await evaluate(`document.querySelector('#ch-name')?.value === 'browser-check'`),
    )
    // The stored key is fetched on open; the field must end up enabled with
    // the plaintext, not stuck on "正在读取".
    record(
      'the upstream key is read back into the form',
      await evaluate(`
        (() => { const k = document.querySelector('#ch-key'); return !k.disabled && k.value.length > 0 })()
      `),
    )
    record(
      'advanced settings are open for an existing channel',
      await evaluate(`document.querySelector('.disclosure__head').getAttribute('aria-expanded') === 'true'`),
    )
    await evaluate(`document.querySelector('.disclosure__head').click()`)
    await sleep(200)
    record(
      'the advanced section folds away',
      await evaluate(`document.querySelector('.disclosure__body').style.display === 'none'`),
    )

    // An untouched form closes without a prompt.
    await evaluate(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '取消').click()`)
    await sleep(400)
    record('an untouched drawer closes without asking', await evaluate(`!document.querySelector('.modal')`))

    // A touched form asks before discarding.
    await evaluate(`[...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('新建渠道')).click()`)
    await sleep(500)
    await evaluate(`
      (() => { const n = document.querySelector('#ch-name'); n.value = 'x'; n.dispatchEvent(new Event('input', { bubbles: true })) })()
    `)
    await evaluate(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '取消').click()`)
    await sleep(400)
    record(
      'a touched drawer asks before discarding',
      await evaluate(`document.querySelectorAll('.modal').length === 2 && [...document.querySelectorAll('.modal')].at(-1).textContent.includes('放弃')`),
    )
    await evaluate(`[...[...document.querySelectorAll('.modal')].at(-1).querySelectorAll('.btn')].find((b) => b.textContent.trim() === '放弃').click()`)
    await sleep(400)
    record('confirming discards and closes both', await evaluate(`!document.querySelector('.modal')`))

    // Create a channel through the drawer, then archive it, restore it, and
    // delete it — the full lifecycle across both lists.
    const chName = `check-ch-${Date.now().toString().slice(-6)}`
    await evaluate(`[...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('新建渠道')).click()`)
    await sleep(500)
    await evaluate(`
      (() => {
        const set = (s, v) => { const n = document.querySelector(s); n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })) }
        set('#ch-name', ${JSON.stringify(chName)})
        set('#ch-url', 'http://127.0.0.1:9/v1')
        set('#ch-key', 'sk-check')
      })()
    `)
    await evaluate(`[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '保存').click()`)
    await sleep(1800)
    drain()
    record(
      '新建渠道 creates the row',
      await evaluate(`!document.querySelector('.modal') && [...document.querySelectorAll('.table tbody tr')].some((r) => r.textContent.includes(${JSON.stringify(chName)}))`),
    )

    const rowMenu = (name) => `
      (() => {
        const row = [...document.querySelectorAll('.table tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(name)}))
        row.querySelector('[aria-haspopup="menu"]').click()
      })()
    `
    const rowSwitch = (name) => `
      (() => {
        const row = [...document.querySelectorAll('.table tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(name)}))
        row.querySelector('.switch').click()
      })()
    `
    const isParked = (name) => `
      [...document.querySelectorAll('.table tbody tr.row-disabled')].some((r) => r.textContent.includes(${JSON.stringify(name)}))
    `

    // A parked row is dimmed, and dimming a cell traps whatever it contains:
    // the menu used to render faded, painted under the rows below it, which
    // then took the clicks meant for it.
    await evaluate(rowSwitch(chName))
    await sleep(1500)
    drain()
    record('the switch parks the row', await evaluate(isParked(chName)))

    await evaluate(rowMenu(chName))
    await sleep(300)
    const parkedMenu = await evaluate(`
      (() => {
        const menu = document.querySelector('.dropdown__menu')
        const items = [...menu.querySelectorAll('.dropdown__item')]
        const box = menu.getBoundingClientRect()
        return {
          opacity: getComputedStyle(menu).opacity,
          count: items.length,
          onScreen: box.top >= 0 && box.bottom <= innerHeight,
          // Hit-testing, not class names: a menu can carry every right class
          // and still sit under something that swallows the pointer.
          reachable: items.every((item) => {
            const r = item.getBoundingClientRect()
            return item.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
          }),
        }
      })()
    `)
    record(
      "a parked row's menu stays opaque, on screen and clickable",
      parkedMenu.opacity === '1' && parkedMenu.reachable && parkedMenu.onScreen && parkedMenu.count === 9,
      `opacity ${parkedMenu.opacity}, ${parkedMenu.count} items, reachable ${parkedMenu.reachable}, on screen ${parkedMenu.onScreen}`,
    )

    await evaluate(`document.body.click()`)
    await sleep(200)
    record('clicking away closes the menu', await evaluate(`!document.querySelector('.dropdown__menu')`))

    await evaluate(rowSwitch(chName))
    await sleep(1500)
    drain()
    record('the switch brings it back', await evaluate(`!(${isParked(chName)})`))

    await evaluate(rowMenu(chName))
    await sleep(300)
    await evaluate(`[...document.querySelectorAll('.dropdown__item')].find((i) => i.textContent.includes('归档渠道')).click()`)
    await sleep(500)
    await evaluate(`[...[...document.querySelectorAll('.modal')].at(-1).querySelectorAll('.btn')].find((b) => b.textContent.trim() === '归档').click()`)
    await sleep(1800)
    drain()
    record(
      'archiving moves the row out of the listing',
      await evaluate(`![...document.querySelectorAll('.table tbody tr')].some((r) => r.textContent.includes(${JSON.stringify(chName)}))`),
    )
    record('the archive shelf appears with a count', await evaluate(`!!document.querySelector('.disclosure') && /已归档/.test(document.querySelector('.disclosure').textContent)`))

    await evaluate(`[...document.querySelectorAll('.disclosure__head')].find((h) => h.textContent.includes('已归档')).click()`)
    await sleep(600)
    record(
      'the archive lists the archived channel',
      await evaluate(`[...document.querySelectorAll('.disclosure__body .table tbody tr')].some((r) => r.textContent.includes(${JSON.stringify(chName)}))`),
    )

    await evaluate(`
      (() => {
        const row = [...document.querySelectorAll('.disclosure__body .table tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(chName)}))
        ;[...row.querySelectorAll('.btn')].find((b) => b.textContent.includes('取消归档')).click()
      })()
    `)
    await sleep(1800)
    drain()
    record(
      'unarchiving returns the row to the listing',
      await evaluate(`[...document.querySelectorAll('.table tbody tr')].some((r) => r.textContent.includes(${JSON.stringify(chName)}))`),
    )

    await evaluate(rowMenu(chName))
    await sleep(300)
    await evaluate(`[...document.querySelectorAll('.dropdown__item')].find((i) => i.textContent.includes('删除渠道')).click()`)
    await sleep(500)
    await evaluate(`[...[...document.querySelectorAll('.modal')].at(-1).querySelectorAll('.btn')].find((b) => b.textContent.trim() === '删除').click()`)
    await sleep(1800)
    drain()
    record(
      'the created channel is removed again',
      await evaluate(`![...document.querySelectorAll('.table tbody tr')].some((r) => r.textContent.includes(${JSON.stringify(chName)}))`),
    )

    // ---- 5j. logs: the live feed, exercised with real traffic
    await evaluate(`document.querySelector('a[href="/logs"]').click()`)
    await sleep(1400)
    drain()
    record(
      '调用日志 renders',
      await evaluate(`location.pathname === '/logs' && !!document.querySelector('.log-table')`),
    )

    await evaluate(`document.querySelector('a[href="/admin/logs"]').click()`)
    await sleep(2000)
    drain()
    record(
      '全局日志 renders with rate chips',
      await evaluate(`location.pathname === '/admin/logs' && document.querySelectorAll('.rate-chip').length === 3`),
    )
    record(
      'the feed connects',
      await evaluate(`document.querySelector('.live-dot--live') !== null`),
      await evaluate(`document.querySelector('.live-dot')?.className`),
    )
    // 并发 reads the tracked set, so it is live whenever the feed is.
    record(
      '并发 chip is live while the feed is connected',
      await evaluate(`[...document.querySelectorAll('.rate-chip')].at(-1).classList.contains('rate-chip--live')`),
    )

    // Real traffic: mint a key, relay one call to the seeded (dead) upstream.
    // It fails, but a failed relay is still a log row — and it is announced
    // on the feed like any other.
    const beforeRows = await evaluate(`document.querySelectorAll('.log-table tbody tr[data-key]').length`)
    const relayed = await evaluate(`
      (async () => {
        const auth = { Authorization: 'Bearer ' + localStorage.getItem('faketoken-token'), 'Content-Type': 'application/json' }
        const created = await fetch('/api/tokens', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'log-check', unlimited_quota: true, allowed_models: [], group: '' }) }).then((r) => r.json())
        // One long unbreakable word: the captured body is then a single wide
        // line, which is what the raw-message view has to contain. The
        // leading turn uses OpenAI's "developer" role, which the transcript
        // has to show as system.
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + created.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'developer', content: 'be brief' }, { role: 'user', content: 'x'.repeat(3000) }] }),
        })
        await fetch('/api/tokens/' + created.token.id, { method: 'DELETE', headers: auth })
        return res.status
      })()
    `)
    record('a relay was attempted through the gateway', typeof relayed === 'number', `HTTP ${relayed}`)

    await sleep(2500)
    drain()
    const afterRows = await evaluate(`document.querySelectorAll('.log-table tbody tr[data-key]').length`)
    record(
      'the settled row arrives over the feed',
      afterRows > beforeRows &&
        (await evaluate(`[...document.querySelectorAll('.log-table tbody tr[data-key]')].some((r) => r.textContent.includes('gpt-4o'))`)),
      `${beforeRows} -> ${afterRows} rows`,
    )
    record(
      'no placeholder is left behind',
      await evaluate(`!document.querySelector('.log-row--running')`),
    )
    record(
      'RPM moved',
      await evaluate(`Number(document.querySelector('.rate-chip__value').textContent) >= 1`),
      await evaluate(`'RPM ' + document.querySelector('.rate-chip__value').textContent`),
    )

    // A settled row opens the detail drawer with its three tabs.
    await evaluate(`document.querySelector('.log-table tbody tr[data-key]').click()`)
    await sleep(1400)
    drain()
    record(
      'a row opens the detail drawer with three tabs',
      await evaluate(`!!document.querySelector('.modal') && document.querySelectorAll('.modal .tabs__item').length === 3`),
    )
    await evaluate(`[...document.querySelectorAll('.modal .tabs__item')].find((t) => t.textContent.includes('请求正文')).click()`)
    await sleep(600)
    record(
      '请求正文 renders the captured call',
      await evaluate(`!!document.querySelector('.modal .code-block') || !!document.querySelector('.modal .chat-log') || !!document.querySelector('.modal .alert')`),
    )
    // The chat view is the default for a recognisable body. A "developer"
    // turn is a system turn under another name and must read as one.
    record(
      'a developer turn is shown as system',
      await evaluate(`
        (() => {
          const roles = [...document.querySelectorAll('.modal .chat-turn__role')].map((r) => r.textContent.trim())
          return roles[0] === 'system' && !roles.includes('developer') && !!document.querySelector('.modal .chat-turn--system') && !document.querySelector('.modal .chat-turn--developer')
        })()
      `),
      await evaluate(`[...document.querySelectorAll('.modal .chat-turn__role')].map((r) => r.textContent.trim()).join(' > ')`),
    )

    // The raw message is one 3000-character line. It has to wrap inside the
    // dialog, not push a 20,000px block out of it — measured, because the
    // failure is purely visual and every static check stays green.
    await evaluate(`[...document.querySelectorAll('.modal .segmented__item')].find((t) => t.textContent.includes('报文'))?.click()`)
    await sleep(400)
    const fit = await evaluate(`
      (() => {
        const modal = document.querySelector('.modal'), pre = document.querySelector('.modal .code-block')
        if (!modal || !pre) return null
        const M = modal.getBoundingClientRect(), P = pre.getBoundingClientRect()
        return { inside: P.right <= M.right + 0.5 && P.left >= M.left - 0.5, modalOverflow: modal.scrollWidth - modal.clientWidth, preWraps: pre.scrollWidth <= pre.clientWidth + 1, preWidth: Math.round(P.width) }
      })()
    `)
    record(
      'the raw message stays inside the dialog',
      fit !== null && fit.inside && fit.modalOverflow === 0 && fit.preWraps,
      fit ? `pre ${fit.preWidth}px, modal overflow ${fit.modalOverflow}px` : 'no code block',
    )
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(400)

    // Filtering to failures keeps the failed relay; the reset brings back
    // everything and, for the stream, restarts it on the new filters.
    await evaluate(`
      (() => { const s = document.querySelector('[aria-label="按结果过滤"]'); s.value = 'error'; s.dispatchEvent(new Event('change', { bubbles: true })) })()
    `)
    await sleep(1400)
    drain()
    record(
      '仅失败 still lists the failed relay',
      await evaluate(`[...document.querySelectorAll('.log-table tbody tr[data-key]')].some((r) => r.textContent.includes('gpt-4o'))`),
    )
    record('the reset link appears once filtered', await evaluate(`[...document.querySelectorAll('.btn')].some((b) => b.textContent.trim() === '重置' && b.style.display !== 'none')`))

    // Turning the feed off parks every meter and says so.
    await evaluate(`document.querySelector('[aria-label="实时推送"]').click()`)
    await sleep(500)
    record(
      'switching the feed off parks the meters',
      await evaluate(`document.querySelectorAll('.rate-chip--live').length === 0 && !!document.querySelector('.live-dot--idle')`),
    )
    await evaluate(`document.querySelector('[aria-label="实时推送"]').click()`)
    await sleep(1800)
    drain()
    record(
      'switching it back on reconnects',
      await evaluate(`!!document.querySelector('.live-dot--live')`),
    )

    // ---- 5k. playground: a real streamed call through the relay
    await evaluate(`document.querySelector('a[href="/playground"]').click()`)
    await sleep(1600)
    drain()
    record(
      '调用测试 renders its form',
      await evaluate(`location.pathname === '/playground' && !!document.querySelector('#pg-prompt') && !!document.querySelector('#pg-model')`),
    )
    record(
      'the model list is loaded from the session',
      await evaluate(`[...document.querySelectorAll('#pg-models option')].some((o) => o.value === ${JSON.stringify(UPSTREAM_MODEL)})`),
      await evaluate(`document.querySelectorAll('#pg-models option').length + ' models'`),
    )

    // A key from this deployment, typed into the field the way a user would.
    const pgToken = await evaluate(`
      (async () => {
        const auth = { Authorization: 'Bearer ' + localStorage.getItem('faketoken-token'), 'Content-Type': 'application/json' }
        const created = await fetch('/api/tokens', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'check-playground', unlimited_quota: true, allowed_models: [], group: '' }) }).then((r) => r.json())
        return { id: created.token.id, key: created.key }
      })()
    `)
    await evaluate(`
      (() => {
        const set = (s, v) => { const n = document.querySelector(s); n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })) }
        set('#pg-key', ${JSON.stringify(pgToken.key)})
        set('#pg-model', ${JSON.stringify(UPSTREAM_MODEL)})
        set('#pg-prompt', 'say hello')
      })()
    `)
    await evaluate(`[...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '发送').click()`)
    await sleep(2500)
    drain()

    const streamed = await evaluate(`document.querySelector('.playground-output')?.textContent ?? ''`)
    record('a streamed reply lands in the output pane', streamed.includes('fake upstream'), JSON.stringify(streamed.slice(0, 40)))
    record(
      'the metric strip reports first byte, total and tokens',
      await evaluate(`
        (() => {
          const labels = [...document.querySelectorAll('.metric-strip__label')].map((l) => l.textContent)
          return labels.includes('首字节') && labels.includes('总耗时') && labels.includes('输入 / 输出 Token')
        })()
      `),
    )
    record(
      'the sent key is remembered for next time',
      await evaluate(`JSON.parse(localStorage.getItem('faketoken-playground-keys') ?? '[]').includes(${JSON.stringify(pgToken.key)})`),
    )
    record('the saved-keys menu appears', await evaluate(`!!document.querySelector('[aria-label="选择已保存的密钥"]')`))

    // Stop mid-stream: the fake upstream drips a long answer when asked to.
    await evaluate(`
      (() => { const n = document.querySelector('#pg-prompt'); n.value = 'please answer slow'; n.dispatchEvent(new Event('input', { bubbles: true })) })()
    `)
    await evaluate(`[...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '发送').click()`)
    await sleep(1200)
    record('the stop button is live while streaming', await evaluate(`!document.querySelector('.btn--danger[disabled]') && !![...document.querySelectorAll('.btn--danger')].find((b) => b.textContent.includes('停止') && !b.disabled)`))
    await evaluate(`[...document.querySelectorAll('.btn--danger')].find((b) => b.textContent.includes('停止')).click()`)
    await sleep(800)
    drain()
    record(
      'stopping reports 已手动停止 and keeps what arrived',
      await evaluate(`
        [...document.querySelectorAll('.metric-strip__value')].some((v) => v.textContent.includes('已手动停止')) &&
        (document.querySelector('.playground-output')?.textContent.length ?? 0) > 0 &&
        (document.querySelector('.playground-output')?.textContent.length ?? 0) < 200
      `),
      await evaluate(`'received ' + (document.querySelector('.playground-output')?.textContent.length ?? 0) + ' chars'`),
    )

    // Clean up the key this check minted.
    await evaluate(`
      fetch('/api/tokens/' + ${pgToken.id}, { method: 'DELETE', headers: { Authorization: 'Bearer ' + localStorage.getItem('faketoken-token') } })
    `)
    await sleep(300)

    // ---- 6. theme switching
    const beforeTheme = await evaluate(`document.documentElement.dataset.theme`)
    await evaluate(`document.querySelector('[aria-label="切换主题"]').click()`)
    await sleep(300)
    await evaluate(`
      [...document.querySelectorAll('.dropdown__item')]
        .find((i) => i.textContent.includes('深色'))?.click()
    `)
    await sleep(400)
    const afterTheme = await evaluate(`document.documentElement.dataset.theme`)
    record('theme switch applies', afterTheme === 'dark', `${beforeTheme} -> ${afterTheme}`)

    // ---- 7. nothing blew up along the way
    drain()
    record('no uncaught page exceptions', pageErrors.length === 0, pageErrors.join(' | '))
    record('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '))
    record('no failed requests', failedRequests.length === 0, failedRequests.slice(0, 5).join(' | '))
  } finally {
    client?.close()
    chrome.kill()
    if (seeded?.id) {
      await fetch(`${baseUrl}/api/admin/channels/${seeded.id}`, { method: 'DELETE', headers: seedHeaders }).catch(() => {})
    }
    await fetch(`${baseUrl}/api/admin/prices/${encodeURIComponent(UPSTREAM_MODEL)}`, { method: 'DELETE', headers: seedHeaders }).catch(() => {})
    upstream.close()
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }

  console.log('')
  if (problems.length > 0) {
    console.log(`${problems.length} problem(s):`)
    for (const problem of problems) console.log(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`all ${steps.length} browser checks passed`)
}

main().catch((error) => {
  console.error('browser check crashed:', error)
  process.exit(1)
})
