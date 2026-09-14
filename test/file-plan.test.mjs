// Wat het bestandenplan doet, getoetst zoals de workflow het aanroept: het script als
// script, met PLAN in de omgeving en de uitslag op stdout.
//
// Waarom dit er niet was: deze repo groeide als lijm tussen Elixir en de CI van een project,
// en de drie poorten die de vloot aan elk project stelt (remote, tests, CI) zijn nooit op de
// runner zelf toegepast. Dat kostte op 13 en 14 september twee keer hetzelfde: een fout die
// pas in de CI van een klantproject bleek, nadat een hand er al mee gedraaid had.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'elixir-fix.mjs')

function draai(plan, { cwd } = {}) {
  const map = cwd || mkdtempSync(join(tmpdir(), 'elixir-fix-'))
  const out = execFileSync('node', [script], {
    cwd: map,
    encoding: 'utf8',
    env: { ...process.env, PLAN: JSON.stringify(plan), GITHUB_OUTPUT: '' },
  })
  const start = out.indexOf('{')
  return { map, out, uitslag: start === -1 ? null : JSON.parse(out.slice(start)) }
}

test('een bestand met inhoud wordt geschreven, met de mappen erbij', () => {
  const content = Buffer.from('<?php // hallo\n').toString('base64')
  const { map, uitslag } = draai([
    { kind: 'meta', branch: 'headers', message: 'Security headers: referrer-policy' },
    { kind: 'file', path: 'app/Http/Middleware/SecurityHeaders.php', content },
  ])

  assert.equal(uitslag.kind, 'files')
  assert.equal(uitslag.meta.branch, 'headers')
  assert.deepEqual(uitslag.applied, [{ path: 'app/Http/Middleware/SecurityHeaders.php', kind: 'write' }])
  assert.equal(readFileSync(join(map, 'app/Http/Middleware/SecurityHeaders.php'), 'utf8'), '<?php // hallo\n')
})

test('een regel wordt ingevoegd vóór de marker, en een tweede keer niet nog eens', () => {
  const map = mkdtempSync(join(tmpdir(), 'elixir-fix-'))
  mkdirSync(join(map, 'bootstrap'))
  writeFileSync(join(map, 'bootstrap/providers.php'), "<?php\n\nreturn [\n    App\\Providers\\AppServiceProvider::class,\n];\n")
  const item = { kind: 'file', path: 'bootstrap/providers.php', before: '];', text: '    App\\Providers\\SecurityHeadersServiceProvider::class,' }

  const eerst = draai([{ kind: 'meta', branch: 'headers' }, item], { cwd: map })
  assert.deepEqual(eerst.uitslag.applied, [{ path: 'bootstrap/providers.php', kind: 'insert' }])

  const opnieuw = draai([{ kind: 'meta', branch: 'headers' }, item], { cwd: map })
  assert.deepEqual(opnieuw.uitslag.applied, [], 'wat er al staat is geen wijziging')

  const na = readFileSync(join(map, 'bootstrap/providers.php'), 'utf8')
  assert.equal(na.split('SecurityHeadersServiceProvider').length - 1, 1, 'precies één keer')
  assert.match(na, /SecurityHeadersServiceProvider::class,\n\];/)
})

test('een ontbrekende marker mislukt met de reden, en de rest gaat door', () => {
  const map = mkdtempSync(join(tmpdir(), 'elixir-fix-'))
  writeFileSync(join(map, 'providers.php'), "<?php\nreturn [App\\Providers\\AppServiceProvider::class];\n")
  const { uitslag } = draai([
    { kind: 'meta', branch: 'headers' },
    { kind: 'file', path: 'providers.php', before: '];', text: '    X::class,' },
    { kind: 'file', path: 'nieuw.txt', content: Buffer.from('ja\n').toString('base64') },
  ], { cwd: map })

  assert.equal(uitslag.failed.length, 1)
  assert.match(uitslag.failed[0].why, /no line reads exactly/)
  assert.deepEqual(uitslag.applied, [{ path: 'nieuw.txt', kind: 'write' }])
})

test('buiten de repo schrijft het nooit', () => {
  for (const path of ['/etc/passwd', '../buiten.txt', 'a/../../buiten.txt']) {
    const { uitslag } = draai([
      { kind: 'meta', branch: 'headers' },
      { kind: 'file', path, content: Buffer.from('nee\n').toString('base64') },
    ])
    assert.deepEqual(uitslag.applied, [], `${path} mag niet geschreven worden`)
    assert.match(uitslag.failed[0].why, /relative and inside the repository/)
  }
  assert.equal(existsSync('/buiten.txt'), false)
})

test('een leeg plan doet niets en zegt dat', () => {
  const { out, uitslag } = draai([])
  assert.equal(uitslag, null)
  assert.match(out, /geen plan meegegeven/)
})
