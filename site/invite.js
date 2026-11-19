// The invite page: shows the friend tag from the link (?tag=7F3A9-C21DE) so it can be copied
// into freetime. Only a well-formed tag is shown, as text; anything else shows a short notice.

const tag = (new URLSearchParams(location.search).get('tag') ?? '').trim().toUpperCase();
const ok = /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(tag);
const box = document.getElementById('invite-box');
const bad = document.getElementById('invite-bad');
if (ok) {
  document.getElementById('invite-tag').textContent = tag;
  document.getElementById('copy-tag').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(tag);
      e.currentTarget.dataset.done = 'true';
    } catch {
      // Selecting the tag lets the visitor copy it by hand.
      getSelection().selectAllChildren(document.getElementById('invite-tag'));
    }
  });
} else {
  box.hidden = true;
  bad.hidden = false;
}
