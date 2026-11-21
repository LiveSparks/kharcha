import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDialog, confirmAction, showMessage, subscribeDialogs } from '../src/ui/dialog.ts';

test('dialogs queue one at a time; a confirmation runs only when confirmed', () => {
  let seen = [];
  const stop = subscribeDialogs(q => { seen = q; });
  let ran = 0;
  showMessage('SMS checked', '3 new entries added.');
  confirmAction('Remove budget?', 'Your transactions stay.', 'Remove', () => { ran++; });
  confirmAction('Delete backup?', 'x', 'Delete', () => { ran += 10; });
  assert.deepEqual(seen.map(r => r.title), ['SMS checked', 'Remove budget?', 'Delete backup?']);
  closeDialog(seen[0].id, false);
  assert.equal(seen[0].confirm.action, 'Remove');
  closeDialog(seen[0].id, true);
  assert.equal(ran, 1);
  closeDialog(seen[0].id, false);
  assert.equal(ran, 1, 'cancel does not run the action');
  assert.equal(seen.length, 0);
  closeDialog(12345, true);
  stop();
});
