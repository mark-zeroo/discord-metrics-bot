import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import * as Q from '../src/api/queries.js';
import { DAY, dayOf } from '../src/time.js';
import { makeConfig } from './fixtures.mjs';

const cfg = () => makeConfig({ PER_MEMBER_COUNTERS: 'hmac' });

/**
 * The permission bits are the fiddly part: Discord's bitfield exceeds 2^53 in the
 * high bits, which is why it is stored and parsed as a decimal string. These
 * literals are built the same way the collector builds them, so a regression in
 * either direction shows up here.
 */
const bit = (n) => (1n << BigInt(n)).toString();
const perms = (...bits) => bits.reduce((acc, n) => acc | (1n << BigInt(n)), 0n).toString();

function fixture({ channels = [], roles = [], messages = [], voice = [], changes = [], settings = null } = {}) {
  const db = openDb(':memory:');
  const ts = Math.floor(Date.now() / 1000) - 60;

  for (const c of channels) {
    db.run(
      `INSERT INTO channel_meta(channel_id, name, type, parent_id, position, nsfw, slowmode,
                                overwrite_count, bot_can_view, changed_ts, deleted_ts)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      c.id, c.name, c.type ?? 'text', c.parent ?? null, c.position ?? 0,
      c.nsfw ? 1 : 0, c.slowmode === null ? null : (c.slowmode ?? 0), c.overwrites ?? 0,
      c.visible === undefined ? 1 : c.visible, ts,
      c.deleted === true ? ts - 10 : (c.deleted ?? null),
    );
  }
  for (const r of roles) {
    db.run(
      `INSERT INTO role_meta(role_id, name, position, color, hoist, managed, mentionable,
                             permissions, member_count, changed_ts, deleted_ts)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      r.id, r.name, r.position ?? 0, r.color ?? 0, r.hoist ? 1 : 0, r.managed ? 1 : 0,
      r.mentionable ? 1 : 0, r.permissions ?? '0', r.members ?? null, ts,
      r.deleted === true ? ts - 10 : (r.deleted ?? null),
    );
  }
  for (const m of messages) {
    db.run(
      `INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial)
       VALUES(?,?,?,?,0)`,
      m.day ?? dayOf(ts) + (m.dayOffsetDays ?? 0) * DAY, m.channel, m.messages, m.authors ?? 1,
    );
  }
  for (const v of voice) {
    db.run(
      `INSERT INTO voice_day(day_ts, channel_id, seconds, unique_users, partial) VALUES(?,?,?,?,0)`,
      v.day ?? dayOf(ts), v.channel, v.seconds, v.users ?? 1,
    );
  }
  for (const c of changes) {
    db.run(
      'INSERT INTO structure_change(ts, kind, target_id, target, detail) VALUES(?,?,?,?,?)',
      c.ts ?? ts - (c.ago ?? 0), c.kind, c.target_id ?? null, c.target ?? null, c.detail ?? null,
    );
  }
  if (settings !== null) db.setMeta('structure.guild', JSON.stringify(settings));
  db.setMeta('structure.refreshed_ts', ts);

  return { db, ts };
}

const window30 = { label: '30d', seconds: 30 * DAY, all: false };
const win = (db, ts, detail = 'summary') =>
  Q.structure(db, cfg(), { window: window30, detail, ts });

test('structure is unavailable until the collector has written it', () => {
  const db = openDb(':memory:');
  const out = Q.structure(db, cfg(), { window: window30, ts: Math.floor(Date.now() / 1000) });
  assert.equal(out.available, false);
  assert.match(out.reason, /no server structure/i);
});

test('invisible channels are counted as a measurement gap, not as quiet', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-chat', parent: 'cat1', position: 2 },
      { id: 'c2', name: 'staff-chat', parent: 'cat1', position: 1, visible: 0, overwrites: 3 },
      { id: 'cat1', name: 'GAME VOICE', type: 'category', position: 5 },
    ],
    messages: [{ channel: 'c1', messages: 100 }],
  });

  const out = win(db, ts);
  assert.equal(out.coverage.channels_total, 2, 'categories are not channels');
  assert.equal(out.coverage.visible_to_bot, 1);
  assert.equal(out.coverage.invisible_to_bot, 1);
  assert.deepEqual(out.coverage.invisible_channels, ['staff-chat']);

  // The invisible channel must never be reported as a pruning candidate.
  assert.equal(out.activity.channels_with_no_traffic, 0);
  assert.deepEqual(out.activity.no_traffic_channels, []);
});

test('a visibility value that is not 0/1 is unknown, not visible', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-chat' },
      // A writer that put something else in the column, or a future schema where
      // the field means more than yes/no. Counting it as visible would inflate
      // the denominator and hide the gap.
      { id: 'c2', name: 'mystery', visible: 'garbage' },
    ],
  });
  const out = win(db, ts, 'summary');
  assert.equal(out.coverage.visible_to_bot, 1);
  assert.equal(out.coverage.invisible_to_bot, 0);
  assert.equal(out.coverage.visibility_unknown, 1, 'garbage lands in the unknown bucket');
  assert.equal(out.counts.channels, 2, 'the channel still exists and is still counted');
});

test('a visible channel with no traffic is a pruning candidate', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-chat' },
      { id: 'c2', name: 'pokemon' },
      { id: 'c3', name: 'old-channel' },
    ],
    messages: [{ channel: 'c1', messages: 40 }],
  });

  const out = win(db, ts);
  assert.equal(out.activity.channels_with_traffic, 1);
  assert.deepEqual(out.activity.no_traffic_channels.sort(), ['old-channel', 'pokemon']);
});

test('voice channels report configured versus actually used', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'v1', name: 'Game Lobby 1', type: 'voice' },
      { id: 'v2', name: 'Game Lobby 2', type: 'voice' },
      { id: 't1', name: 'game-chat' },
    ],
    voice: [{ channel: 'v1', seconds: 3600 }],
  });

  const out = win(db, ts);
  assert.equal(out.activity.voice_channels_visible, 2);
  assert.equal(out.activity.voice_channels_used, 1, 'one lobby used, one silent');
  // A text channel must not carry a voice figure at all.
  assert.equal(out.channels, undefined, 'summary omits the per-channel list');
});

test('permissions are parsed from the bitfield without losing high bits', () => {
  const { db, ts } = fixture({
    channels: [{ id: 'c1', name: 'game-chat' }],
    roles: [
      { id: 'r1', name: 'Owner', position: 9, permissions: bit(3), members: 1 },
      { id: 'r2', name: 'Mod', position: 8, permissions: perms(28, 13), members: 3 },
      // bit 50 is past the safe-integer range: this is the case a numeric cast
      // would corrupt.
      { id: 'r3', name: 'High', position: 7, permissions: perms(50), members: 0 },
      { id: 'r4', name: 'Member', position: 1, permissions: perms(1), members: 900 },
    ],
  });

  const out = win(db, ts, 'full');
  const byName = Object.fromEntries(out.roles.map((r) => [r.name, r]));

  assert.deepEqual(byName.Owner.permissions, ['administrator']);
  assert.deepEqual(byName.Owner.permissions.length, 1);
  assert.deepEqual(byName.Mod.permissions.sort(), ['manage_messages', 'manage_roles']);
  assert.equal(byName.Mod.elevated, true, 'manage_roles is elevated');
  assert.equal(byName.Member.elevated, false);
  assert.equal(byName['High'].permissions.includes('administrator'), false, 'bit 50 is not administrator');

  assert.equal(out.permission_audit.roles_with_administrator, 1);
  assert.deepEqual(out.permission_audit.elevated_roles.map((r) => r.name).sort(), ['Mod', 'Owner']);
});

test('an unreadable bitfield is unknown, not a harmless empty list', () => {
  const { db, ts } = fixture({
    channels: [{ id: 'c1', name: 'game-chat' }],
    roles: [
      // The only audited bit here is create-instant-invite... which is not
      // audited, so this is honestly "nothing notable".
      { id: 'r1', name: '@everyone', position: 0, permissions: bit(0), members: 900 },
      { id: 'r2', name: 'Broken', position: 1, permissions: 'not-a-number', members: 1 },
    ],
  });

  const out = win(db, ts, 'full');
  const byName = Object.fromEntries(out.roles.map((r) => [r.name, r]));

  assert.deepEqual(byName['@everyone'].permissions, []);
  assert.equal(byName['@everyone'].elevated, false);
  // null, not []: a corrupt row must not be indistinguishable from a safe role.
  assert.equal(byName.Broken.permissions, null);
  assert.equal(byName.Broken.elevated, false, 'an unknown bitfield cannot be elevated');
  assert.deepEqual(out.permission_audit.everyone_role, []);
  assert.match(out.permission_audit.note, /an empty list means none of those are set/);
});

test('a role colour of zero is no colour, not black', () => {
  const { db, ts } = fixture({
    channels: [{ id: 'c1', name: 'game-chat' }],
    roles: [
      { id: 'r1', name: 'Plain', color: 0 },
      { id: 'r2', name: 'Blue', color: 0x5865f2 },
    ],
  });
  const out = win(db, ts, 'full');
  const byName = Object.fromEntries(out.roles.map((r) => [r.name, r]));
  assert.equal(byName.Plain.color, null);
  assert.equal(byName.Blue.color, '#5865f2');
});

test('deleted channels and roles are excluded from the current state', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-chat' },
      { id: 'c2', name: 'retired', deleted: true },
    ],
    roles: [
      { id: 'r1', name: 'Member' },
      { id: 'r2', name: 'Old Role', deleted: true },
    ],
    messages: [{ channel: 'c2', messages: 500 }],
  });

  const out = win(db, ts, 'full');
  assert.equal(out.counts.channels, 1);
  assert.equal(out.counts.roles, 1);
  // The 500 messages belong to the retired channel. History for a channel that no
  // longer exists stays in message_day, so the current-state view must not
  // resurrect it as a busiest channel.
  assert.deepEqual(out.activity.busiest, []);
  assert.equal(out.channels.length, 1);
  assert.equal(out.channels[0].name, 'game-chat');
});

test('categories roll up their children, and uncategorised channels are counted', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'GAME VOICE', type: 'category', position: 5 },
      { id: 'c1', name: 'game-chat', parent: 'cat1', position: 3 },
      { id: 'c2', name: 'game-clips', parent: 'cat1', position: 2 },
      { id: 'c3', name: 'general-chat', position: 9 },
    ],
    messages: [
      { channel: 'c1', messages: 60 },
      { channel: 'c3', messages: 30 },
    ],
  });

  const out = win(db, ts);
  const game = out.categories.find((c) => c.name === 'GAME VOICE');
  assert.equal(game.channels, 2);
  assert.equal(game.messages, 60);
  assert.equal(game.empty_channels, 1, 'game-clips is visible and empty');
  assert.equal(out.counts.uncategorised_channels, 1);
});

test('the category rollup accounts for every channel, uncategorised included', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'GAME VOICE', type: 'category', position: 5 },
      { id: 'c1', name: 'game-chat', parent: 'cat1', position: 3 },
      { id: 'c2', name: 'game-clips', parent: 'cat1', position: 2 },
      { id: 'c3', name: 'general-chat', position: 9 },
      { id: 'c4', name: 'game-codes', position: 8, visible: 0 },
      { id: 'v1', name: 'music', type: 'voice', position: 7 },
      { id: 't1', name: 'a thread', type: 'thread', parent: 'c1', position: 1 },
    ],
    messages: [{ channel: 'c1', messages: 60 }],
  });

  const out = win(db, ts);
  const sum = (k) => out.categories.reduce((n, c) => n + c[k], 0);

  // The rollup used to drop channels with no category, so these three sums were
  // short by however many there were (live: 41 vs 43 empty, 7 vs 9 voice).
  assert.equal(sum('channels'), out.counts.channels, 'every channel appears once');
  assert.equal(sum('empty_channels'), out.activity.channels_with_no_traffic);
  // Unused voice channels can only sum to visible minus used: a channel with voice
  // time is not unused, so equality with voice_channels_visible only holds when
  // nobody has been in voice at all.
  assert.equal(
    sum('unused_voice_channels'),
    out.activity.voice_channels_visible - out.activity.voice_channels_used,
  );

  const none = out.categories.find((c) => c.name === '(no category)');
  assert.ok(none, 'the leftovers get a row of their own');
  assert.equal(none.channels, 4, 'general-chat, game-codes, music, and the thread');
  assert.equal(none.empty_channels, 2, 'general-chat and the thread are visible and quiet');
  assert.equal(none.unused_voice_channels, 1, 'music has no voice time');
});

test('a category with no text channels reports zero, not unknown', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'VOICE CHANNELS', type: 'category', position: 5 },
      { id: 'v1', name: 'music', type: 'voice', parent: 'cat1', position: 3 },
      { id: 'v2', name: 'gaming', type: 'voice', parent: 'cat1', position: 2 },
    ],
  });

  const out = win(db, ts);
  const cat = out.categories.find((c) => c.name === 'VOICE CHANNELS');
  // null here contradicted activity_known: true — nothing was missing, there is
  // simply nowhere in this category to send a message.
  assert.equal(cat.messages, 0);
  assert.equal(cat.activity_known, true);
  assert.equal(cat.unused_voice_channels, 2);
});

test('a category with no visible text channels still reports unknown', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'STAFF', type: 'category', position: 5 },
      { id: 'c1', name: 'staff-chat', parent: 'cat1', position: 3, visible: 0 },
    ],
  });

  const out = win(db, ts);
  const cat = out.categories.find((c) => c.name === 'STAFF');
  assert.equal(cat.messages, null, 'unmeasured is not zero');
  assert.equal(cat.messages_from_invisible, null, 'and neither is its invisible half');
  assert.equal(cat.activity_known, false);
});

test('the busiest list says which channels the bot cannot see', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-chat', position: 3 },
      { id: 'c2', name: 'pokemon', position: 2, visible: 0 },
    ],
    messages: [
      { channel: 'c1', messages: 60 },
      { channel: 'c2', messages: 12 },
    ],
  });

  const out = win(db, ts);
  const byName = Object.fromEntries(out.activity.busiest.map((c) => [c.name, c]));
  assert.equal(byName['game-chat'].visible_to_bot, true);
  // It is in the list on purpose, but a reader must be able to tell it is also a
  // coverage contradiction rather than a normal channel.
  assert.equal(byName.pokemon.visible_to_bot, false);
});

test('an uncategorised invisible channel is ranked above the Archive tail', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'Archive', type: 'category', position: 9 },
      { id: 'a1', name: 'old-one', parent: 'cat1', position: 5, visible: 0 },
      { id: 'a2', name: 'old-two', parent: 'cat1', position: 4, visible: 0 },
      { id: 'x1', name: 'game-codes', position: 8, visible: 0 },
    ],
  });

  const out = win(db, ts);
  const names = out.coverage.invisible_channels;
  // Both have zero traffic and "share 0", but the uncategorised channel is the one
  // someone can actually fix; it used to sort into the Archive tail and get cut.
  assert.equal(names[0], 'game-codes');
  assert.deepEqual(names.slice(1).sort(), ['old-one', 'old-two']);
});

test('changes are newest first and bounded', () => {
  const { db, ts } = fixture({
    channels: [{ id: 'c1', name: 'game-chat' }],
    changes: Array.from({ length: 20 }, (_, i) => ({
      ago: i * 60,
      kind: 'channel_updated',
      target: `ch-${i}`,
      detail: 'slowmode',
    })),
  });

  const summary = win(db, ts);
  assert.equal(summary.changes.length, 10);
  assert.equal(summary.changes[0].target, 'ch-0', 'most recent first');
  assert.equal(win(db, ts, 'full').changes.length, 20);
});

test('guild settings come through from the stored snapshot', () => {
  const { db, ts } = fixture({
    channels: [{ id: 'c1', name: 'game-chat' }],
    settings: {
      verification_level: 2,
      mfa_level: 1,
      afk_channel: 'AFK',
      preferred_locale: 'en-US',
      features: ['COMMUNITY'],
      premium_tier: 3,
      premium_subscriptions: 20,
    },
  });

  const out = win(db, ts);
  assert.equal(out.guild.verification_level, 2);
  assert.equal(out.guild.afk_channel, 'AFK');
  assert.equal(out.guild.premium_tier, 3);
  assert.deepEqual(out.guild.features, ['COMMUNITY']);
});

test('a channel window older than the data still counts as no traffic', () => {
  const { db, ts } = fixture({
    channels: [{ id: 'c1', name: 'game-chat' }],
    messages: [{ channel: 'c1', messages: 10, dayOffsetDays: -40 }],
  });

  const recent = win(db, ts);
  assert.equal(recent.activity.channels_with_traffic, 0, '40 days ago is outside 30d');
  assert.deepEqual(recent.activity.no_traffic_channels, ['game-chat']);
});

test('data quality reports channel coverage as a denominator', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-chat' },
      { id: 'c2', name: 'staff-chat', visible: 0 },
      { id: 'c3', name: 'admin-chat', visible: 0 },
      { id: 'cat1', name: 'CAT', type: 'category' },
    ],
  });

  const q = Q.qualityReport(db, cfg(), { ts });
  assert.equal(q.coverage.channels_total, 3);
  // Same spelling as structure().coverage, so one number has one name.
  assert.equal(q.coverage.visible_to_bot, 1);
  assert.equal(q.coverage.invisible_to_bot, 2);
  assert.match(q.coverage.note, /2 of 3 channels are invisible/);
});

test('coverage says so plainly when the bot can see everything', () => {
  const { db, ts } = fixture({ channels: [{ id: 'c1', name: 'game-chat' }] });
  const q = Q.qualityReport(db, cfg(), { ts });
  assert.equal(q.coverage.invisible_to_bot, 0);
  assert.match(q.coverage.note, /can see every channel/i);
});

test('coverage degrades honestly before any structure has been collected', () => {
  const db = openDb(':memory:');
  const q = Q.qualityReport(db, cfg(), { ts: Math.floor(Date.now() / 1000) });
  assert.equal(q.coverage.available, false);
  assert.match(q.coverage.reason, /visibility has not been collected/i);
});

test('a channel flagged invisible that has traffic is reported as a contradiction', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-chat', visible: 1 },
      // Flagged invisible, yet it produced messages. Only possible for a channel
      // the bot can read, so the flag and the data cannot both be right.
      { id: 'c2', name: 'arcade-commands', visible: 0 },
      { id: 'c3', name: 'archive-old', visible: 0 },
    ],
    messages: [
      { channel: 'c1', messages: 100 },
      { channel: 'c2', messages: 7 },
    ],
  });
  const out = win(db, ts, 'summary');
  assert.equal(out.coverage.visibility_contradictions.count, 1);
  assert.equal(out.coverage.visibility_contradictions.channels[0].name, 'arcade-commands');
  assert.equal(out.coverage.visibility_contradictions.channels[0].messages, 7);
  assert.match(out.coverage.visibility_contradictions.note, /already being measured/i);
  // The genuinely invisible, genuinely quiet channel must not be swept up.
  assert.ok(!out.coverage.invisible_channels.includes('zzz'));
  assert.ok(out.coverage.invisible_channels.includes('archive-old'));
  // And the contradiction stays in the invisible count: it is still a channel
  // the bot cannot currently see, one of the two facts is just wrong.
  assert.equal(out.coverage.invisible_to_bot, 2);
});

test('voice traffic also counts as proof the bot could see the channel', () => {
  const { db, ts } = fixture({
    channels: [{ id: 'v1', name: 'Lounge', type: 'voice', visible: 0 }],
    voice: [{ channel: 'v1', seconds: 600 }],
  });
  const out = win(db, ts, 'summary');
  assert.equal(out.coverage.visibility_contradictions.count, 1);
  assert.equal(out.coverage.visibility_contradictions.channels[0].name, 'Lounge');
});

test('a truncated invisible list says so instead of looking complete', () => {
  const channels = [];
  for (let i = 0; i < 60; i += 1) channels.push({ id: `c${i}`, name: `hidden-${i}`, visible: 0 });
  const { db, ts } = fixture({ channels });
  const out = win(db, ts, 'summary');
  assert.equal(out.coverage.invisible_to_bot, 60);
  assert.equal(out.coverage.invisible_channels.length, 50, 'capped at 50');
  assert.equal(out.coverage.invisible_channels_truncated, true);
});

test('an invisible list that fits is not marked truncated', () => {
  const { db, ts } = fixture({ channels: [{ id: 'c1', name: 'a', visible: 0 }] });
  const out = win(db, ts, 'summary');
  assert.equal(out.coverage.invisible_channels_truncated, false);
});

test('no-traffic list flags truncation but keeps the true total', () => {
  const channels = [];
  for (let i = 0; i < 30; i += 1) channels.push({ id: `c${i}`, name: `quiet-${i}` });
  const { db, ts } = fixture({ channels });
  const out = win(db, ts, 'summary');
  assert.equal(out.activity.channels_with_no_traffic, 30);
  assert.equal(out.activity.no_traffic_channels.length, 25);
  assert.equal(out.activity.no_traffic_channels_truncated, true);
});

test('a category the bot cannot see reports unknown, not zero', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'Archive', type: 'category' },
      { id: 'c1', name: 'old-news', parent: 'cat1', visible: 0 },
      { id: 'c2', name: 'older-news', parent: 'cat1', visible: 0 },
      { id: 'cat2', name: 'COMMUNITY', type: 'category' },
      { id: 'c3', name: 'general', parent: 'cat2', visible: 1 },
    ],
    messages: [{ channel: 'c3', messages: 12 }],
  });
  const out = win(db, ts, 'summary');
  const archive = out.categories.find((c) => c.name === 'Archive');
  assert.equal(archive.visible_to_bot, 0);
  assert.equal(archive.messages, null, 'nothing measured, so not a zero');
  assert.equal(archive.activity_known, false);

  const community = out.categories.find((c) => c.name === 'COMMUNITY');
  assert.equal(community.messages, 12);
  assert.equal(community.activity_known, true);
});

test('a watched category with no traffic is a real zero', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'GAME NIGHT', type: 'category' },
      { id: 'c1', name: 'game-night-chat', parent: 'cat1', visible: 1 },
    ],
  });
  const out = win(db, ts, 'summary');
  const cat = out.categories.find((c) => c.name === 'GAME NIGHT');
  assert.equal(cat.messages, 0, 'watched and quiet is a genuine zero');
  assert.equal(cat.activity_known, true);
  assert.equal(cat.empty_channels, 1);
});

test('duplicate channel names are disambiguated, unique ones left alone', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'STAFF', type: 'category' },
      // A voice channel and a text channel both called staff-chat. Naming only
      // one of them "staff-chat" leaves the operator guessing which to fix.
      { id: 'v1', name: 'staff-chat', type: 'voice', parent: 'cat1', visible: 0 },
      { id: 'c1', name: 'staff-chat', parent: 'cat1', visible: 0 },
      { id: 'c2', name: 'game-chat', parent: 'cat1', visible: 0 },
    ],
  });
  const out = win(db, ts, 'summary');
  const names = out.coverage.invisible_channels;
  assert.equal(new Set(names).size, names.length, 'every entry is distinct');
  assert.ok(names.includes('game-chat'), 'a name used once stays bare');
  assert.ok(names.includes('staff-chat (text, STAFF)'), names.join(' | '));
  assert.ok(names.includes('staff-chat (voice, STAFF)'), names.join(' | '));
});

test('two channels identical down to type and category still get distinct labels', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'COMMUNITY', type: 'category' },
      { id: 'c1', name: 'memes', parent: 'cat1', visible: 0 },
      { id: 'c2', name: 'memes', parent: 'cat1', visible: 0 },
    ],
  });
  const out = win(db, ts, 'summary');
  const names = out.coverage.invisible_channels;
  assert.equal(new Set(names).size, 2, names.join(' | '));
  assert.ok(names.some((n) => n.endsWith('#2')), names.join(' | '));
});

test('the traffic count beside busiest covers the same channels busiest lists', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-chat', visible: 1 },
      { id: 'c2', name: 'arcade-commands', visible: 0 },
    ],
    messages: [
      { channel: 'c1', messages: 50 },
      { channel: 'c2', messages: 7 },
    ],
  });
  const out = win(db, ts, 'summary');
  assert.equal(out.activity.channels_with_traffic, 2, 'matches the busiest rows');
  assert.equal(out.activity.visible_channels_with_traffic, 1, 'visible only');
  assert.equal(out.activity.busiest.length, 2);
  assert.equal(out.activity.voice_channels_used, 0);
});

test('a category does not launder invisible traffic into its message count', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'ARCADE', type: 'category' },
      { id: 'c1', name: 'arcade-news', parent: 'cat1', visible: 1 },
      { id: 'c2', name: 'arcade-commands', parent: 'cat1', visible: 0 },
    ],
    messages: [{ channel: 'c2', messages: 7 }],
  });
  const out = win(db, ts, 'summary');
  const arcade = out.categories.find((c) => c.name === 'ARCADE');
  // The coverage note promises invisible channels are excluded from every activity
  // figure. Folding 7 into `messages` would make that promise false.
  assert.equal(arcade.messages, 0, 'only the visible child is counted');
  assert.equal(arcade.messages_from_invisible, 7, 'and the gap is stated, not hidden');
  assert.equal(arcade.empty_channels, 1);
});

test('voice channels are unused, not empty', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'VOICE CHANNELS', type: 'category' },
      { id: 'v1', name: 'Lounge', type: 'voice', parent: 'cat1' },
      { id: 'v2', name: 'dojo', type: 'voice', parent: 'cat1' },
      { id: 'c1', name: 'voice-text', parent: 'cat1' },
    ],
  });
  const out = win(db, ts, 'summary');
  const cat = out.categories.find((c) => c.name === 'VOICE CHANNELS');
  // A voice channel never produces messages; calling it "empty" padded the
  // pruning list with channels that could not have been used in that sense.
  assert.equal(cat.empty_channels, 1, 'only the text channel counts as empty');
  assert.equal(cat.unused_voice_channels, 2);
  assert.equal(cat.messages, 0);
  assert.equal(cat.activity_known, true);
});

test('a category holding only invisible voice channels is measured but message-less', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'STAGE', type: 'category' },
      { id: 'v1', name: 'game-night', type: 'stage', parent: 'cat1', visible: 0 },
    ],
  });
  const out = win(db, ts, 'summary');
  const cat = out.categories.find((c) => c.name === 'STAGE');
  assert.equal(cat.messages, null, 'no talkable child, so no message figure exists');
  assert.equal(cat.activity_known, false, 'nothing in it is visible');
  assert.equal(cat.unused_voice_channels, 0, 'an invisible channel is not "unused"');
});

test('an empty category is still reported, so the rollup accounts for every channel', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'ABANDONED', type: 'category' },
      { id: 'cat2', name: 'COMMUNITY', type: 'category' },
      { id: 'c1', name: 'general', parent: 'cat2' },
    ],
  });
  const out = win(db, ts, 'summary');
  const abandoned = out.categories.find((c) => c.name === 'ABANDONED');
  assert.ok(abandoned, 'an empty category is pruning material, not noise');
  assert.equal(abandoned.channels, 0);
  assert.equal(abandoned.messages, null);
  assert.equal(abandoned.activity_known, false);
  const summed = out.categories.reduce((n, c) => n + c.channels, 0);
  assert.equal(summed, out.counts.channels, 'categories + uncategorised == channels');
});

test('empty_channels across categories reconciles with the global no-traffic count', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'cat1', name: 'A', type: 'category' },
      { id: 'a1', name: 'quiet-1', parent: 'cat1' },
      { id: 'a2', name: 'quiet-2', parent: 'cat1' },
      { id: 'a3', name: 'busy-1', parent: 'cat1' },
      { id: 'cat2', name: 'B', type: 'category' },
      { id: 'b1', name: 'quiet-3', parent: 'cat2', visible: 0 },
      { id: 'b2', name: 'Lounge', type: 'voice', parent: 'cat2' },
    ],
    messages: [{ channel: 'a3', messages: 40 }],
  });
  const out = win(db, ts, 'summary');
  const summed = out.categories.reduce((n, c) => n + c.empty_channels, 0);
  // Voice must not be in here, and neither must the invisible channel, or the two
  // figures describe different sets and look like a bug to whoever compares them.
  assert.equal(summed, 2);
  assert.equal(out.activity.channels_with_no_traffic, summed);
});

test('slowmode of zero is a value, not an unknown', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'general', slowmode: 0 },
      { id: 'c2', name: 'bump', slowmode: 900 },
      { id: 'c3', name: 'legacy', slowmode: null },
    ],
  });
  const out = win(db, ts, 'full');
  const by = Object.fromEntries(out.channels.map((c) => [c.name, c.slowmode_seconds]));
  // `|| null` reported every ordinary channel as unknown, which is the same
  // null-vs-zero slip this endpoint keeps having to fix.
  assert.equal(by.general, 0, 'no slowmode is a known zero');
  assert.equal(by.bump, 900);
  assert.equal(by.legacy, null, 'never captured stays null');
});

test('an unreadable channel reports no message figure rather than zero', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-chat', visible: 1 },
      { id: 'c2', name: '1v1-top-12', visible: 0 },
      { id: 'c3', name: 'pokemon', visible: 0 },
    ],
    messages: [{ channel: 'c3', messages: 12 }],
  });
  const out = win(db, ts, 'full');
  const by = Object.fromEntries(out.channels.map((c) => [c.name, c]));
  assert.equal(by['game-chat'].messages, 0, 'visible and quiet is a real zero');
  // 0 here would read as "watched and silent" for a channel nobody can read.
  assert.equal(by['1v1-top-12'].messages, null);
  assert.equal(by['1v1-top-12'].active_days, null);
  assert.equal(by.pokemon.messages, 12, 'traffic proves it is being read');
});

test('the capped invisible list surfaces actionable channels before dead ones', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'arc', name: 'ARCADE', type: 'category' },
      { id: 'a1', name: 'arcade-news', parent: 'arc' },
      { id: 'a2', name: 'arcade-info', parent: 'arc', visible: 0 },
      { id: 'a3', name: 'event-signup', parent: 'arc', visible: 0 },
      { id: 'old', name: 'Archive', type: 'category' },
      { id: 'o1', name: 'memes', parent: 'old', visible: 0 },
      { id: 'o2', name: 'food', parent: 'old', visible: 0 },
    ],
  });
  const out = win(db, ts, 'summary');
  const names = out.coverage.invisible_channels;
  // Archive is 46 dead channels on the real server; it was crowding the arcade
  // channels out of a 50-name cap.
  assert.deepEqual(names, ['arcade-info', 'event-signup', 'memes', 'food']);
});

test('a thread names the channel it hangs off', () => {
  const { db, ts } = fixture({
    channels: [
      { id: 'c1', name: 'game-codes' },
      { id: 't1', name: 'Codes', type: 'thread', parent: 'c1' },
    ],
  });
  const out = win(db, ts, 'full');
  const thread = out.channels.find((c) => c.type === 'thread');
  assert.equal(thread.parent, null, 'a thread has no category');
  assert.equal(thread.parent_channel, 'game-codes', 'but it does have a parent channel');
});
