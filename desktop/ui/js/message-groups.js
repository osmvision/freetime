import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, errText, h, icon } from './dom.js';

const MAX_MEMBERS = 20;

export function groupAvatar(size = '') {
  return h('span', { class: `avatar ${size}`, 'aria-hidden': 'true' }, icon('users'));
}

function memberRow(person, box = null) {
  return [
    avatar({ icon: person.avatar_icon, color: person.avatar_color, userId: person.user_id }, 'sm'),
    h('span', { class: 'group-member-name', translate: 'no' }, person.display_name),
    box,
  ];
}

export function groupMembers(group) {
  return h('div', { class: 'group-members report-form', hidden: true },
    h('strong', {}, 'Group members'),
    h('ul', { class: 'group-member-list' },
      group.members.map((member) => h('li', { class: 'group-member-row' }, memberRow(member)))),
  );
}

export function groupEditor({ group, friends, me, saved, cancel }) {
  const initial = new Set(group?.members.filter((m) => m.user_id !== me).map((m) => m.user_id) ?? []);
  const selected = new Set(initial);
  const choices = new Map(friends.map((friend) => [friend.user_id, friend]));
  for (const member of group?.members ?? []) {
    if (member.user_id !== me) choices.set(member.user_id, member);
  }
  const name = h('input', { class: 'input', maxlength: 40, value: group?.name ?? '', required: true });
  const status = h('p', { class: 'hint', role: 'status' });
  const save = btn({ label: group ? 'Save' : 'Create group', icon: 'check', kind: 'primary', type: 'submit' });
  const dismiss = btn({ label: 'Cancel', kind: 'quiet', onclick: cancel });
  const people = h('div', { class: 'group-picker', role: 'group', 'aria-label': 'Group members' },
    [...choices.values()].map((person) => {
      const check = h('input', { type: 'checkbox', checked: selected.has(person.user_id) });
      check.addEventListener('change', () => {
        if (check.checked && selected.size >= MAX_MEMBERS - 1) {
          check.checked = false;
          status.textContent = 'a group can have up to 20 members';
          return;
        }
        if (check.checked) selected.add(person.user_id);
        else selected.delete(person.user_id);
        status.textContent = '';
        updateSave();
      });
      return h('label', { class: 'group-member-row' }, memberRow(person, check));
    }),
  );
  const updateSave = () => { save.disabled = !name.value.trim() || (!group && selected.size < 2); };
  updateSave();
  name.addEventListener('input', updateSave);
  return h('form', { class: 'group-editor', onsubmit: async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = dismiss.disabled = true;
    name.disabled = people.inert = true;
    status.textContent = '';
    try {
      const id = await api.manageFriendGroup({
        action: group ? 'update' : 'create',
        id: group?.conversation_id,
        name: name.value.trim() === group?.name ? null : name.value.trim(),
        add: [...selected].filter((id) => !initial.has(id)),
        remove: [...initial].filter((id) => !selected.has(id)),
      });
      await saved(id);
    } catch (e) {
      status.textContent = errText(e);
    } finally {
      dismiss.disabled = name.disabled = people.inert = false;
      updateSave();
    }
  } },
    h('h2', {}, group ? 'Edit group' : 'New group'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Group name'), name),
    h('p', { class: 'hint' }, group ? 'Choose the members of this group.' : 'Choose at least two friends to start a group.'),
    people,
    status,
    h('div', { class: 'row' }, save, dismiss),
  );
}
