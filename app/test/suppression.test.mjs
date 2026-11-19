import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS,
  STATUS_LEGEND,
  countCell,
  isPublished,
  pooledCell,
  ratioCell,
  suppressPartition,
  suppressionBlock,
} from '../src/api/suppression.js';

const K = 10;

test('a count below the floor is withheld, with a status rather than a null', () => {
  const cell = countCell(3, { k: K, base: 40 });
  assert.equal(cell.value, null);
  assert.equal(cell.status, STATUS.suppressed_small_count);
  assert.equal(cell.reason, 'count_below_floor');
});

test('a count whose complement is below the floor is withheld too', () => {
  // 38 of 40 retained means two people did not come back. Publishing 38 is a
  // statement about those two.
  const cell = countCell(38, { k: K, base: 40 });
  assert.equal(cell.status, STATUS.suppressed_small_count);
  assert.equal(cell.reason, 'complement_below_floor');
});

test('a count at the floor, and one whose complement is at the floor, is published', () => {
  assert.deepEqual(countCell(10, { k: K, base: 40 }), { status: STATUS.published, value: 10 });
  // base - count = 10, which is not below k.
  assert.equal(countCell(30, { k: K, base: 40 }).value, 30);
});

test('a group smaller than the floor withholds its count even when the count is zero', () => {
  // Zero in a group of three says every one of those three did nothing, which is
  // a statement about three specific people.
  const cell = countCell(0, { k: K, base: 3 });
  assert.equal(cell.status, STATUS.suppressed_small_count);
  assert.equal(cell.reason, 'base_below_floor');
});

test('zero is published when the group is publishable', () => {
  assert.equal(countCell(0, { k: K, base: 50 }).value, 0);
});

test('a rate derived from a withheld count is withheld, never computed', () => {
  const num = countCell(1, { k: K, base: 40 });
  const den = countCell(40, { k: K, base: 40 });
  const rate = ratioCell(num, den);
  assert.equal(rate.value, null);
  // 1/40 is 2.5%: publishing it would hand back the numerator.
  assert.equal(rate.status, STATUS.suppressed_small_count);
  assert.equal(rate.reason, 'derived_from_withheld_count');
});

test('a rate publishes three decimals when both inputs publish', () => {
  const rate = ratioCell(countCell(12, { k: K, base: 40 }), countCell(40, { k: K, base: 40 }));
  assert.equal(rate.value, 0.3);
});

// ------------------------------------------------- complementary suppression

test('one withheld band forces a second suppression so the total cannot subtract it back', () => {
  // Two withheld cells and a published total is the safe state: the reader knows
  // their sum, not either value.
  const two = suppressPartition({
    k: K,
    counts: [
      { key: 'a', count: 90 },
      { key: 'b', count: 6 },
      { key: 'c', count: 4 },
      { key: 'd', count: 0 },
    ],
  });
  assert.equal(two.suppressed, 2);
  assert.equal(two.secondary_suppressed, 0);

  // Exactly one small cell on a large base: 7 is withheld, 200 and 50 publish,
  // and 257 - 250 puts the 7 straight back on the page. So 50 goes too.
  const single = suppressPartition({
    k: K,
    counts: [
      { key: 'a', count: 200 },
      { key: 'b', count: 50 },
      { key: 'c', count: 7 },
    ],
  });
  assert.equal(single.suppressed, 2, 'the smallest published cell was withheld as well');
  assert.equal(single.secondary_suppressed, 1);
  const cC = single.cells.find((c) => c.key === 'c');
  const cB = single.cells.find((c) => c.key === 'b');
  assert.equal(cC.status, STATUS.suppressed_small_count);
  assert.equal(cB.status, STATUS.suppressed_complementary);
  assert.equal(cB.count, 50, 'the count is kept for the reader as context, the value is not');
  assert.equal(cB.value, null);
  // With two unknowns the total no longer recovers either one.
  assert.equal(single.total.value, 257);
});

test('a partition with no recoverable cell keeps its total', () => {
  const out = suppressPartition({
    k: K,
    counts: [
      { key: 'a', count: 100 },
      { key: 'b', count: 100 },
    ],
  });
  assert.equal(out.suppressed, 0);
  assert.equal(out.total.value, 200);
  assert.equal(out.protected, true);
});

test('suppression of a partition never exposes a single cell', () => {
  // A partition of a small island against a much larger explicit total: the only
  // withheld cell is 5, every published cell is 0, and 100 - 0 = 5 is false… so
  // the 5 is not recoverable and the total can stand.
  const notRecoverable = suppressPartition({
    k: K,
    counts: [
      { key: 'a', count: 5 },
      { key: 'b', count: 0 },
    ],
    total: 100,
  });
  assert.equal(notRecoverable.protected, true, 'the unlisted remainder hides the cell');
  assert.equal(notRecoverable.total.value, 100);

  // Now the cells really do partition a base of 5 at a floor of 10: every cell is
  // withheld, so the total recovers nothing individual, but a "total of 5 people"
  // is itself below the floor and must not be published.
  const tiny = suppressPartition({
    k: K,
    counts: [
      { key: 'a', count: 5 },
      { key: 'b', count: 0 },
    ],
    total: 5,
  });
  assert.equal(tiny.suppressed, 2);
  assert.equal(tiny.protected, true, 'two unknowns, nothing recoverable');

  // A real partition never reaches the total-exposure branch, and that is the point:
  // if the cells add up to a base at or above the floor, a withheld non-zero cell
  // implies its complement is non-zero, so the base rule always withholds it too.
  // The branch stays as a guard for callers that pass a partition of the wrong total.
  const partitionOfFive = suppressPartition({ k: K, counts: [{ key: 'a', count: 5 }, { key: 'b', count: 0 }] });
  assert.equal(partitionOfFive.protected, true);
});

test('pooled totals are withheld when any contributing row is withheld', () => {
  const publishedCell = { status: STATUS.published, value: 4 };
  const withheldCell = { status: STATUS.suppressed_small_count, value: null };
  assert.equal(pooledCell(0.2, [publishedCell]).value, 0.2);
  const pooled = pooledCell(0.2, [publishedCell, withheldCell]);
  assert.equal(pooled.value, null);
  assert.equal(pooled.status, STATUS.withheld_suppression);
  assert.equal(pooled.withheld_inputs, 1);
});

test('the suppression block counts statuses and states the policy', () => {
  const cells = [
    countCell(1, { k: K, base: 50 }),
    countCell(50, { k: K, base: 50 }),
    { status: STATUS.unmeasured, value: null },
  ];
  const block = suppressionBlock({ k: K, cells });
  assert.equal(block.min_cell, K);
  assert.equal(block.suppressed_cells, 1);
  assert.equal(block.status_counts[STATUS.published], 1);
  assert.equal(block.status_counts[STATUS.unmeasured], 1);
  assert.match(block.policy, /below 10/);
});

test('every status in the vocabulary has a legend entry', () => {
  for (const status of Object.values(STATUS)) {
    assert.ok(STATUS_LEGEND[status], `no legend for ${status}`);
  }
  assert.equal(isPublished({ status: STATUS.published, value: 0 }), true);
  assert.equal(isPublished({ status: STATUS.unmeasured, value: null }), false);
});
