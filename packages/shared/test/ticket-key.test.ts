// Phase 4a Task 7 item 4: one ticket-key check for every package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTicketKey, TICKET_KEY } from '../src/index.ts';

test('isTicketKey: PROJ-1 and A_B2-10 are keys; lower case, a missing number or project, a trailing newline or space are not', () => {
  for (const ok of ['PROJ-1', 'A-0', 'A_B2-10', 'FAKE-123']) assert.equal(isTicketKey(ok), true, ok);
  for (const bad of ['proj-1', 'PROJ-', 'PROJ-1\n', '-1', 'PROJ-1 ', ' PROJ-1', '1A-1', 'PROJ-1a', 'PROJ--1', '']) assert.equal(isTicketKey(bad), false, JSON.stringify(bad));
  assert.equal(TICKET_KEY.source, '^[A-Z][A-Z0-9_]*-[0-9]+$');
  assert.equal(TICKET_KEY.flags, '');
});
