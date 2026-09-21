/**
 * Regenerates web/js/ui/icons.js from the Ant Design icon set.
 *
 * The console has no runtime dependency on antd, but its glyphs are Ant
 * Design's. So the path data is copied out of @ant-design/icons-svg here and
 * inlined; the package is fetched into a cache outside the repository the
 * first time, so the repository itself never gains a package.json.
 *
 * Add an entry to NAMES, then:  node scripts/gen-icons.mjs
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// Pinned: a different release could redraw a glyph, and the generated file
// would change for no reason of ours.
const ICON_PACKAGE = '@ant-design/icons-svg@4.5.0'

/** Resolves the icon package, installing it into the cache on first use. */
function iconRequire() {
  const cache = join(tmpdir(), 'faketoken-gen-icons')
  const require = createRequire(join(cache, 'package.json'))
  const installed = () => existsSync(join(cache, 'node_modules', '@ant-design', 'icons-svg', 'package.json'))

  if (!installed()) {
    console.log(`fetching ${ICON_PACKAGE} into ${cache}`)
    mkdirSync(cache, { recursive: true })
    // --no-package-lock and --no-save: the cache is a scratch directory,
    // not a project, so nothing there needs to be reproducible.
    execFileSync('npm', ['install', '--prefix', cache, '--no-save', '--no-package-lock',
      '--no-audit', '--no-fund', '--loglevel=error', ICON_PACKAGE], { stdio: 'inherit' })
  }
  if (!installed()) {
    throw new Error(`${ICON_PACKAGE} did not land in ${cache}`)
  }
  return require
}

const require = iconRequire()

/**
 * Console name → Ant Design icon. The left-hand names are what the pages use
 * (ICONS.dashboard), so a change of glyph never touches a page.
 */
const NAMES = {
  // navigation
  dashboard: 'BarChartOutlined',
  key: 'KeyOutlined',
  apps: 'AppstoreOutlined',
  flask: 'ExperimentOutlined',
  file: 'FileTextOutlined',
  api: 'ApiOutlined',
  team: 'TeamOutlined',
  bolt: 'ThunderboltOutlined',
  dollar: 'DollarOutlined',
  gift: 'GiftOutlined',
  ticket: 'SolutionOutlined',
  settings: 'SettingOutlined',
  user: 'UserOutlined',

  // shell
  wallet: 'WalletOutlined',
  lock: 'LockOutlined',
  reload: 'ReloadOutlined',
  menu: 'MenuOutlined',
  menuFold: 'MenuFoldOutlined',
  menuUnfold: 'MenuUnfoldOutlined',
  sun: 'SunOutlined',
  moon: 'MoonOutlined',
  desktop: 'DesktopOutlined',
  logout: 'LogoutOutlined',
  warning: 'ExclamationCircleOutlined',
  chart: 'BarChartOutlined',

  // actions
  plus: 'PlusOutlined',
  search: 'SearchOutlined',
  copy: 'CopyOutlined',
  close: 'CloseOutlined',
  check: 'CheckOutlined',
  info: 'InfoCircleOutlined',
  external: 'ExportOutlined',
  download: 'CloudDownloadOutlined',
  delete: 'DeleteOutlined',
  edit: 'EditOutlined',
  more: 'EllipsisOutlined',
  save: 'SaveOutlined',
  send: 'SendOutlined',
  stop: 'StopOutlined',
  clear: 'ClearOutlined',
  import: 'ImportOutlined',
  inbox: 'InboxOutlined',
  rollback: 'RollbackOutlined',
  block: 'BlockOutlined',
  down: 'DownOutlined',
  loading: 'LoadingOutlined',
  clock: 'ClockCircleOutlined',
  fieldTime: 'FieldTimeOutlined',
  number: 'NumberOutlined',
  robot: 'RobotOutlined',
  alert: 'WarningOutlined',
  sortAsc: 'SortAscendingOutlined',
  sortDesc: 'SortDescendingOutlined',
  chevronLeft: 'LeftOutlined',
  chevronRight: 'RightOutlined',
}

const lines = []
for (const [name, antName] of Object.entries(NAMES)) {
  const { icon } = require(`@ant-design/icons-svg/lib/asn/${antName}.js`).default

  const paths = icon.children.map((child) => {
    if (child.tag !== 'path' || !child.attrs?.d) {
      throw new Error(`${antName}: expected only <path d>, got <${child.tag}>`)
    }
    return child.attrs.d
  })

  const viewBox = icon.attrs.viewBox
  const box = viewBox === '64 64 896 896' ? '' : `, box: '${viewBox}'`
  const quoted = paths.map((d) => `'${d}'`).join(', ')
  lines.push(`  ${name}: { paths: [${quoted}]${box} },`)
}

const source = `/**
 * Icon paths, generated from @ant-design/icons-svg by scripts/gen-icons.mjs.
 *
 * Do not edit by hand: add a name to the script and regenerate. Copying the
 * path data keeps the console free of a runtime dependency.
 *
 * Every entry is { paths, box? }. \`box\` is the SVG viewBox and is only
 * present when it differs from Ant Design's usual '64 64 896 896'.
 */

export const ICONS = {
${lines.join('\n')}
}
`

writeFileSync(join(root, 'web', 'js', 'ui', 'icons.js'), source)
console.log(`wrote ${Object.keys(NAMES).length} icons`)
