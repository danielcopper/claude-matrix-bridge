import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseJsonl,
  buildReplayFromRecords,
  hasUserActivityFromRecords,
  readPermissionModeFromRecords,
  type JsonlRecord,
} from '../src/replay.js'

// --- Helpers ---

function userRecord(content: string, opts?: Partial<JsonlRecord>): JsonlRecord {
  return { type: 'user', message: { role: 'user', content }, ...opts }
}

function channelRecord(content: string): JsonlRecord {
  return {
    type: 'user',
    message: { role: 'user', content },
    isMeta: true,
    origin: { kind: 'channel' },
  }
}

function metaRecord(): JsonlRecord {
  return { type: 'user', isMeta: true, message: { role: 'user', content: 'system info' } }
}

function assistantText(text: string, opts?: Partial<JsonlRecord>): JsonlRecord {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...opts,
  }
}

function assistantWithTools(
  text: string,
  tools: { name: string; input?: Record<string, unknown> }[],
): JsonlRecord {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        ...tools.map(t => ({ type: 'tool_use' as const, name: t.name, input: t.input })),
        { type: 'text' as const, text },
      ],
    },
  }
}

function simplePair(userMsg: string, assistantMsg: string): JsonlRecord[] {
  return [userRecord(userMsg), assistantText(assistantMsg)]
}

// --- parseJsonl ---

describe('parseJsonl', () => {
  it('parses valid JSONL', () => {
    const raw = '{"type":"user"}\n{"type":"assistant"}\n'
    const records = parseJsonl(raw)
    assert.equal(records.length, 2)
    assert.equal(records[0].type, 'user')
    assert.equal(records[1].type, 'assistant')
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseJsonl(''), [])
  })

  it('skips blank lines', () => {
    const raw = '{"type":"user"}\n\n\n{"type":"assistant"}\n'
    assert.equal(parseJsonl(raw).length, 2)
  })

  it('skips malformed lines without crashing', () => {
    const raw = '{"type":"user"}\n{broken json\n{"type":"assistant"}\n'
    const records = parseJsonl(raw)
    assert.equal(records.length, 2)
    assert.equal(records[0].type, 'user')
    assert.equal(records[1].type, 'assistant')
  })

  it('handles trailing content without newline', () => {
    const raw = '{"type":"user"}'
    assert.equal(parseJsonl(raw).length, 1)
  })
})

// --- buildReplayFromRecords: basic ---

describe('buildReplayFromRecords', () => {
  it('returns null for empty records', () => {
    assert.equal(buildReplayFromRecords([], null, 20), null)
  })

  it('returns null for only meta records', () => {
    const records = [metaRecord(), metaRecord()]
    assert.equal(buildReplayFromRecords(records, null, 20), null)
  })

  it('returns null for only channel records', () => {
    const records = [channelRecord('hello from matrix'), assistantText('hi')]
    assert.equal(buildReplayFromRecords(records, null, 20), null)
  })

  it('builds a single user-assistant pair', () => {
    const records = simplePair('fix the bug', 'Done.')
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('User: fix the bug'))
    assert.ok(result.body.includes('Claude: Done.'))
    assert.ok(result.body.includes('Local session activity'))
    assert.ok(result.body.includes('Back in Matrix'))
  })

  it('builds multiple pairs', () => {
    const records = [
      ...simplePair('first question', 'first answer'),
      ...simplePair('second question', 'second answer'),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('first question'))
    assert.ok(result.body.includes('second answer'))
  })

  it('returns null when user message has no assistant response', () => {
    const records = [userRecord('hello')]
    assert.equal(buildReplayFromRecords(records, null, 20), null)
  })

  it('handles string content in user messages', () => {
    const records = [
      { type: 'user', message: { role: 'user', content: 'string content' } },
      assistantText('reply'),
    ] satisfies JsonlRecord[]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('string content'))
  })

  it('handles ContentBlock[] in user messages', () => {
    const records: JsonlRecord[] = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'block content' }] } },
      assistantText('reply'),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('block content'))
  })

  it('handles string content in assistant messages', () => {
    const records: JsonlRecord[] = [
      userRecord('hello'),
      { type: 'assistant', message: { role: 'assistant', content: 'plain string reply' } },
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('plain string reply'))
  })
})

// --- Filtering ---

describe('filtering', () => {
  it('filters out channel-origin messages', () => {
    const records = [
      channelRecord('from matrix'),
      assistantText('matrix reply'),
      ...simplePair('local message', 'local reply'),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(!result.body.includes('from matrix'))
    assert.ok(result.body.includes('local message'))
  })

  it('filters out isMeta records', () => {
    const records = [
      metaRecord(),
      ...simplePair('real message', 'real reply'),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(!result.body.includes('system info'))
    assert.ok(result.body.includes('real message'))
  })

  it('filters by since timestamp', () => {
    const cutoff = new Date('2026-04-10T12:00:00Z')
    const records = [
      ...simplePair('old message', 'old reply').map(r => ({ ...r, timestamp: '2026-04-10T11:00:00Z' })),
      ...simplePair('new message', 'new reply').map(r => ({ ...r, timestamp: '2026-04-10T13:00:00Z' })),
    ]
    const result = buildReplayFromRecords(records, cutoff, 20)
    assert.ok(result)
    assert.ok(!result.body.includes('old message'))
    assert.ok(result.body.includes('new message'))
  })

  it('includes records without timestamp when since is set', () => {
    const cutoff = new Date('2026-04-10T12:00:00Z')
    const records = simplePair('no timestamp', 'reply')
    const result = buildReplayFromRecords(records, cutoff, 20)
    assert.ok(result)
    assert.ok(result.body.includes('no timestamp'))
  })
})

// --- maxPairs truncation ---

describe('maxPairs truncation', () => {
  it('limits to last N pairs', () => {
    const records = [
      ...simplePair('msg 1', 'reply 1'),
      ...simplePair('msg 2', 'reply 2'),
      ...simplePair('msg 3', 'reply 3'),
    ]
    const result = buildReplayFromRecords(records, null, 2)
    assert.ok(result)
    assert.ok(!result.body.includes('msg 1'))
    assert.ok(result.body.includes('msg 2'))
    assert.ok(result.body.includes('msg 3'))
  })

  it('shows truncation count in header when truncated', () => {
    const records = [
      ...simplePair('a', 'b'),
      ...simplePair('c', 'd'),
      ...simplePair('e', 'f'),
    ]
    const result = buildReplayFromRecords(records, null, 2)
    assert.ok(result)
    assert.ok(result.body.includes('2 of 3 exchanges'))
  })

  it('does not show count when not truncated', () => {
    const records = simplePair('a', 'b')
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(!result.body.includes(' of '))
  })
})

// --- Tool extraction ---

describe('tool extraction', () => {
  it('includes Edit tool with diff', () => {
    const records: JsonlRecord[] = [
      userRecord('fix it'),
      assistantWithTools('Done.', [{
        name: 'Edit',
        input: { file_path: '/src/app.ts', old_string: 'old line', new_string: 'new line' },
      }]),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('Edit: app.ts'))
    assert.ok(result.body.includes('- old line'))
    assert.ok(result.body.includes('+ new line'))
  })

  it('includes Bash tool with command', () => {
    const records: JsonlRecord[] = [
      userRecord('run tests'),
      assistantWithTools('Tests pass.', [{
        name: 'Bash',
        input: { command: 'npm test' },
      }]),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('$ npm test'))
  })

  it('includes Write tool with filename', () => {
    const records: JsonlRecord[] = [
      userRecord('create file'),
      assistantWithTools('Created.', [{
        name: 'Write',
        input: { file_path: '/src/new.ts', content: 'hello world' },
      }]),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('Write: new.ts'))
  })

  it('filters out Read tools', () => {
    const records: JsonlRecord[] = [
      userRecord('check it'),
      assistantWithTools('Looks good.', [
        { name: 'Read', input: { file_path: '/src/app.ts' } },
        { name: 'Bash', input: { command: 'echo hi' } },
      ]),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(!result.body.includes('Read:'))
    assert.ok(result.body.includes('$ echo hi'))
  })

  it('filters out mcp__matrix-relay__ tools', () => {
    const records: JsonlRecord[] = [
      userRecord('do something'),
      assistantWithTools('Done.', [
        { name: 'mcp__matrix-relay__reply', input: { content: 'internal' } },
      ]),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(!result.body.includes('matrix-relay'))
  })

  it('collects tools across multiple assistant records before text', () => {
    const records: JsonlRecord[] = [
      userRecord('refactor'),
      // First assistant record: tool_use only, no text
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } }],
        },
      },
      // Second assistant record: tool_use + text
      assistantWithTools('All done.', [
        { name: 'Bash', input: { command: 'npm test' } },
      ]),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('Edit: a.ts'))
    assert.ok(result.body.includes('$ npm test'))
    assert.ok(result.body.includes('All done.'))
  })
})

// --- HTML output ---

describe('HTML output', () => {
  it('generates formatted_body with HTML tags', () => {
    const records = simplePair('hello', 'world')
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.formatted_body.includes('<blockquote>'))
    assert.ok(result.formatted_body.includes('<b>User:</b>'))
    assert.ok(result.formatted_body.includes('<b>Claude:</b>'))
  })

  it('escapes HTML in user content', () => {
    const records = simplePair('<script>alert("xss")</script>', 'safe reply')
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(!result.formatted_body.includes('<script>'))
    assert.ok(result.formatted_body.includes('&lt;script&gt;'))
  })

  it('escapes HTML in assistant content', () => {
    const records = simplePair('hello', '<img src=x onerror=alert(1)>')
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(!result.formatted_body.includes('<img'))
    assert.ok(result.formatted_body.includes('&lt;img'))
  })

  it('includes Edit diff in HTML as pre block', () => {
    const records: JsonlRecord[] = [
      userRecord('fix'),
      assistantWithTools('Fixed.', [{
        name: 'Edit',
        input: { file_path: '/src/x.ts', old_string: 'old', new_string: 'new' },
      }]),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.formatted_body.includes('<pre>'))
    assert.ok(result.formatted_body.includes('<code>Edit: x.ts</code>'))
  })
})

// --- Edge cases ---

describe('edge cases', () => {
  it('skips user messages with empty string content', () => {
    const records: JsonlRecord[] = [
      userRecord(''),
      assistantText('reply to nothing'),
    ]
    assert.equal(buildReplayFromRecords(records, null, 20), null)
  })

  it('skips user messages with whitespace-only content', () => {
    const records: JsonlRecord[] = [
      userRecord('   '),
      assistantText('reply'),
    ]
    assert.equal(buildReplayFromRecords(records, null, 20), null)
  })

  it('skips assistant messages with empty text', () => {
    const records: JsonlRecord[] = [
      userRecord('hello'),
      assistantText(''),
      ...simplePair('real question', 'real answer'),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    // Only the second pair should appear
    assert.ok(!result.body.includes('hello'))
    assert.ok(result.body.includes('real question'))
  })

  it('handles new user message overriding pending one', () => {
    const records: JsonlRecord[] = [
      userRecord('first attempt'),
      userRecord('second attempt'),
      assistantText('response'),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(!result.body.includes('first attempt'))
    assert.ok(result.body.includes('second attempt'))
  })

  it('handles assistant with only tool_use blocks (no text) as non-completing', () => {
    const records: JsonlRecord[] = [
      userRecord('do something'),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      // No text response follows -> pair not completed
    ]
    assert.equal(buildReplayFromRecords(records, null, 20), null)
  })

  it('handles mixed channel and local messages in sequence', () => {
    const records: JsonlRecord[] = [
      channelRecord('matrix msg 1'),
      assistantText('matrix reply'),
      userRecord('local msg'),
      assistantText('local reply'),
      channelRecord('matrix msg 2'),
      assistantText('matrix reply 2'),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    assert.ok(result.body.includes('local msg'))
    assert.ok(!result.body.includes('matrix msg'))
  })

  it('handles tool_result user messages (should not start a new pair)', () => {
    const records: JsonlRecord[] = [
      userRecord('do it'),
      // Assistant uses a tool (no text yet -> pair not completed)
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } }],
        },
      },
      // tool_result comes back as a user message with array content containing tool_result type
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result' as string, text: 'success' }],
        },
      },
      // Final assistant response with text completes the pair
      assistantText('All done.'),
    ]
    const result = buildReplayFromRecords(records, null, 20)
    assert.ok(result)
    // Should be a single pair: tool_result must not reset pendingUser
    assert.ok(result.body.includes('do it'))
    assert.ok(result.body.includes('All done.'))
  })
})

// --- hasUserActivityFromRecords ---

describe('hasUserActivityFromRecords', () => {
  it('returns false for empty records', () => {
    assert.equal(hasUserActivityFromRecords([]), false)
  })

  it('returns false for meta-only JSONL (just-spawned, never messaged)', () => {
    assert.equal(hasUserActivityFromRecords([metaRecord(), metaRecord()]), false)
  })

  it('returns true on a channel user message even without an assistant reply', () => {
    // A channel record only exists if a Matrix message was actually delivered —
    // archiving on this would drop the pending message on supervisor recovery.
    assert.equal(hasUserActivityFromRecords([channelRecord('hi from matrix')]), true)
  })

  it('returns true on a local user message', () => {
    assert.equal(hasUserActivityFromRecords([userRecord('hello')]), true)
  })

  it('returns true on an assistant text response (e.g. greeting before user)', () => {
    assert.equal(hasUserActivityFromRecords([assistantText('Hi there')]), true)
  })

  it('returns true on a full local pair', () => {
    assert.equal(hasUserActivityFromRecords(simplePair('hi', 'hello')), true)
  })

  it('returns true on a channel user message followed by an assistant text', () => {
    assert.equal(
      hasUserActivityFromRecords([channelRecord('matrix msg'), assistantText('reply')]),
      true,
    )
  })

  it('ignores assistant tool-only messages without text content', () => {
    const toolOnly: JsonlRecord = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a' } }],
      },
    }
    assert.equal(hasUserActivityFromRecords([toolOnly]), false)
  })

  it('short-circuits on the first real record', () => {
    // Conceptual check: a mix of meta + one real user message returns true.
    const records: JsonlRecord[] = [metaRecord(), metaRecord(), userRecord('go')]
    assert.equal(hasUserActivityFromRecords(records), true)
  })
})

// --- readPermissionModeFromRecords ---

function modeRecord(mode: string): JsonlRecord {
  return { type: 'permission-mode', permissionMode: mode }
}

describe('readPermissionModeFromRecords', () => {
  it('returns null for empty records', () => {
    assert.equal(readPermissionModeFromRecords([]), null)
  })

  it('returns null when no permission-mode records exist', () => {
    assert.equal(readPermissionModeFromRecords(simplePair('hi', 'hello')), null)
  })

  it('returns the only permission-mode value present', () => {
    assert.equal(readPermissionModeFromRecords([modeRecord('plan')]), 'plan')
  })

  it('returns the most recent permission-mode (walks from end)', () => {
    const records: JsonlRecord[] = [
      modeRecord('default'),
      ...simplePair('do thing', 'done'),
      modeRecord('acceptEdits'),
      ...simplePair('more', 'ok'),
      modeRecord('auto'),
    ]
    assert.equal(readPermissionModeFromRecords(records), 'auto')
  })

  it('accepts all known modes including bypassPermissions', () => {
    for (const m of ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions']) {
      assert.equal(readPermissionModeFromRecords([modeRecord(m)]), m)
    }
  })

  it('skips unknown mode values', () => {
    const records: JsonlRecord[] = [modeRecord('plan'), modeRecord('quantum')]
    assert.equal(readPermissionModeFromRecords(records), 'plan')
  })

  it('skips records with missing permissionMode field', () => {
    const records: JsonlRecord[] = [
      modeRecord('plan'),
      { type: 'permission-mode' },
    ]
    assert.equal(readPermissionModeFromRecords(records), 'plan')
  })
})
