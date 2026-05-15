import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractModeFlag, isModeCommand } from '../src/command-handler.js'

// --- extractModeFlag ---

describe('extractModeFlag', () => {
  it('returns no mode when --mode is absent', () => {
    const r = extractModeFlag(['/tmp/foo', 'my-session'])
    assert.deepEqual(r, { positional: ['/tmp/foo', 'my-session'], mode: null })
  })

  it('parses --mode <value> (space-separated)', () => {
    const r = extractModeFlag(['/tmp/foo', 'my-session', '--mode', 'plan'])
    assert.deepEqual(r, { positional: ['/tmp/foo', 'my-session'], mode: 'plan' })
  })

  it('parses --mode=<value> (equals-separated)', () => {
    const r = extractModeFlag(['/tmp/foo', 'my-session', '--mode=acceptEdits'])
    assert.deepEqual(r, { positional: ['/tmp/foo', 'my-session'], mode: 'acceptEdits' })
  })

  it('accepts the flag at any position', () => {
    const r = extractModeFlag(['--mode', 'auto', '/tmp/foo', 'my-session'])
    assert.deepEqual(r, { positional: ['/tmp/foo', 'my-session'], mode: 'auto' })
  })

  it('rejects an unknown mode value', () => {
    const r = extractModeFlag(['/tmp/foo', '--mode', 'bypassPermissions'])
    assert.match(r as string, /Invalid mode/)
  })

  it('rejects gibberish mode value', () => {
    const r = extractModeFlag(['/tmp/foo', '--mode', 'plonk'])
    assert.match(r as string, /Invalid mode/)
  })

  it('rejects missing value after --mode', () => {
    const r = extractModeFlag(['/tmp/foo', '--mode'])
    assert.match(r as string, /Missing value/)
  })

  it('accepts all 4 user-facing modes', () => {
    for (const m of ['default', 'plan', 'acceptEdits', 'auto'] as const) {
      const r = extractModeFlag(['--mode', m])
      assert.deepEqual(r, { positional: [], mode: m })
    }
  })
})

// --- isModeCommand ---

describe('isModeCommand', () => {
  it('matches !mode exactly', () => {
    assert.equal(isModeCommand('!mode'), true)
  })

  it('matches !mode with args', () => {
    assert.equal(isModeCommand('!mode auto'), true)
    assert.equal(isModeCommand('!mode hallo du frosch'), true)
  })

  it('handles leading/trailing whitespace', () => {
    assert.equal(isModeCommand('  !mode auto  '), true)
  })

  it('does NOT match /mode (reserved for claude)', () => {
    assert.equal(isModeCommand('/mode auto'), false)
  })

  it('does NOT match :mode (collides with Element emoji autocomplete)', () => {
    assert.equal(isModeCommand(':mode'), false)
    assert.equal(isModeCommand(':mode auto'), false)
  })

  it('does NOT match typos like !modus or !mod', () => {
    assert.equal(isModeCommand('!modus auto'), false)
    assert.equal(isModeCommand('!mod auto'), false)
    assert.equal(isModeCommand('!modecycle'), false)
  })

  it('does NOT match unrelated messages starting with !', () => {
    assert.equal(isModeCommand('!hello'), false)
    assert.equal(isModeCommand('hello !mode'), false)
  })

  it('does NOT match plain text containing "mode"', () => {
    assert.equal(isModeCommand('what mode are we in?'), false)
    assert.equal(isModeCommand('change mode please'), false)
  })

  it('matches case variations of the body before the mode keyword', () => {
    // We deliberately don't case-fold !mode itself — only the argument.
    // Reasoning: a stricter prefix keeps the intercept surface small.
    assert.equal(isModeCommand('!Mode auto'), false)
    assert.equal(isModeCommand('!MODE auto'), false)
  })
})
