/**
 * Publication rules for per-person counts.
 *
 * Everything else in this API is a total over activity: 400 messages, 30 voice
 * hours. Those are safe to publish because they say nothing about which member did
 * what. A retention table is different — "3 of the 4 people who joined that week
 * came back on day 1" identifies the one who did not, to anyone who knows who
 * joined that week. That is the disclosure this module exists to prevent.
 *
 * Three rules, in order:
 *
 * 1. k-floor. A count below PRIVACY_MIN_CELL is withheld, and so is a count whose
 *    complement (base - count) is below it: "all but one of these ten were
 *    retained" identifies the one, and it is the complement that is small.
 *
 * 2. Complementary suppression. Withholding one cell from a table that adds up to
 *    a published total does not hide it — the reader subtracts. So when a
 *    partition would have exactly one withheld cell, a second (the smallest
 *    published non-zero one) is withheld too. Two unknowns and one equation is
 *    the standard answer, and it is the only one that keeps the total publishable.
 *
 * 3. A total is only published over rows that themselves published. A pooled
 *    figure that includes a withheld row recovers that row by subtraction, and
 *    there is no second cell to sacrifice at that level. Pooling over the
 *    published rows instead is safe (the result is already derivable from them) as
 *    long as the payload says how many rows were left out.
 *
 * Every withheld value is a *status*, never a bare null. A null with no status is
 * indistinguishable from "this server was quiet" and from "collection had not
 * started yet", and the whole point of the feature is that a reader can tell those
 * three apart.
 */

export const STATUS = Object.freeze({
  published: 'published',
  /** Below the anonymity floor, or its complement was. */
  suppressed_small_count: 'suppressed_small_count',
  /** Withheld so a neighbouring withheld cell cannot be recovered by subtraction. */
  suppressed_complementary: 'suppressed_complementary',
  /** A total withheld because it contains a withheld cell. */
  withheld_suppression: 'withheld_suppression',
  /** Nothing was collected for this cell — not the same as zero. */
  unmeasured: 'unmeasured',
  /** The observation window has not finished yet. */
  immature: 'immature',
  /** No rows of the kind this needs have ever been collected. */
  no_data: 'no_data',
  /** A computed figure declined to publish itself; see `code`. */
  refused: 'refused',
});

/**
 * The legend travels with every payload that can contain a withheld cell, so the
 * model never has to infer the difference between a quiet server and a hidden
 * number. Kept short because it is repeated in responses.
 */
export const STATUS_LEGEND = Object.freeze({
  published: 'a real measured value',
  suppressed_small_count:
    'withheld: the count (or its complement) was below the anonymity floor, so publishing it could point at a person',
  suppressed_complementary:
    'withheld: publishing it would let another withheld cell in the same row be recovered by subtraction',
  withheld_suppression: 'withheld: this total contains a withheld cell, so it would leak that cell',
  unmeasured: 'nothing was measured for this cell; this is not zero',
  immature: 'the period this cell describes has not finished yet, so it cannot be measured',
  no_data: 'no rows of this kind have been collected yet; this is not zero',
  refused: 'a figure that could have been computed was declined; see refused[].code',
});

export const isPublished = (cell) => cell?.status === STATUS.published;

/** A plain measured value. */
export function published(value) {
  return { status: STATUS.published, value };
}

/** A value that exists but must not be published. */
export function withheld(status, extra = {}) {
  return { status, value: null, ...extra };
}

/**
 * A count of people, guarded.
 *
 * `base` is the size of the group the count is drawn from when that is known (a
 * cohort, a period's active members). Passing it enables the complement rule,
 * which is the half of the k-floor that is usually forgotten: a count of 19 out of
 * 20 is as revealing as a count of 1, because it names the one person who is not
 * in it.
 *
 * A zero is published whenever the base is publishable: "no members in the 1000+
 * band" reveals nothing about an individual, and suppressing zeros would fill a
 * distribution with withheld cells that carry no risk.
 */
export function countCell(count, { k, base = null } = {}) {
  if (!Number.isFinite(count) || count < 0) return withheld(STATUS.no_data);
  if (base !== null && Number.isFinite(base) && base < k) {
    // The group itself is too small to describe. Withholding the count while
    // publishing the base would be theatre, so the caller is expected to withhold
    // both; this guards the count either way.
    return withheld(STATUS.suppressed_small_count, { reason: 'base_below_floor' });
  }
  if (count > 0 && count < k) {
    return withheld(STATUS.suppressed_small_count, { reason: 'count_below_floor' });
  }
  if (base !== null && Number.isFinite(base)) {
    const complement = base - count;
    if (complement > 0 && complement < k) {
      return withheld(STATUS.suppressed_small_count, { reason: 'complement_below_floor' });
    }
  }
  return published(count);
}

/**
 * A rate, publishable only when its numerator and denominator both are.
 *
 * The trap this closes: withholding "1 retained" but publishing "9%" next to a
 * published denominator of 11 puts the withheld count straight back on the page.
 * A rate is therefore derived from the *cells*, not from the raw numbers, and it
 * is withheld whenever either input was.
 */
export function ratioCell(numeratorCell, denominatorCell, digits = 3) {
  if (!isPublished(numeratorCell) || !isPublished(denominatorCell)) {
    return withheld(
      isPublished(numeratorCell) ? denominatorCell.status : numeratorCell.status,
      { reason: 'derived_from_withheld_count' },
    );
  }
  if (denominatorCell.value <= 0) return withheld(STATUS.unmeasured, { reason: 'no_denominator' });
  return published(Number((numeratorCell.value / denominatorCell.value).toFixed(digits)));
}

/**
 * Suppress a partition: counts that add up to a published total (message-volume
 * bands, response categories). Returns one cell per input, in input order.
 *
 * Secondary suppression loop: while exactly one cell is withheld, that cell equals
 * `total` minus the published ones and is therefore already visible. Withhold the
 * smallest published non-zero cell as well. If there is no non-zero cell left to
 * withhold, the total is the only thing that can be protected, so it is reported
 * as withheld and the caller must not publish it.
 */
export function suppressPartition({ counts, k, total = null }) {
  const sum = counts.reduce((a, c) => a + (Number.isFinite(c.count) ? c.count : 0), 0);
  const base = Number.isFinite(total) ? total : sum;

  const cells = counts.map(({ key, count }) => ({
    key,
    count: Number.isFinite(count) ? count : 0,
    ...countCell(count, { k, base }),
  }));

  let secondary = 0;
  let totalExposed = false;

  for (;;) {
    const openIdx = cells.map((c, i) => (isPublished(c) ? -1 : i)).filter((i) => i >= 0);
    if (openIdx.length !== 1) break;

    // Recovery is only possible when the arithmetic actually lines up: the single
    // withheld cell has to equal the total minus the published ones. Checking the
    // subtraction instead of assuming a partition means a table whose listed cells
    // do not add up to its total is not over-suppressed for nothing.
    const target = openIdx[0];
    const publishedSum = cells
      .filter(isPublished)
      .reduce((acc, c) => acc + c.count, 0);
    if (base - publishedSum !== cells[target].count) break;

    // Smallest published non-zero cell, which is the least informative one to lose.
    let victim = -1;
    for (let i = 0; i < cells.length; i += 1) {
      if (!isPublished(cells[i]) || cells[i].count === 0) continue;
      if (victim === -1 || cells[i].count < cells[victim].count) victim = i;
    }
    if (victim === -1) {
      // Everything else is a zero, so the withheld cell is the entire total and
      // publishing the total publishes it. Nothing left to suppress but the total.
      totalExposed = true;
      break;
    }
    cells[victim] = {
      key: cells[victim].key,
      count: cells[victim].count,
      ...withheld(STATUS.suppressed_complementary, { reason: 'recoverable_from_total' }),
    };
    secondary += 1;
  }

  return {
    cells,
    suppressed: cells.filter((c) => !isPublished(c)).length,
    secondary_suppressed: secondary,
    total: totalExposed ? withheld(STATUS.withheld_suppression) : published(base),
    protected: !totalExposed,
  };
}

/**
 * The standard block a payload carries so a reader can tell a small number from a
 * hidden one. `k` is repeated because the threshold is part of the interpretation.
 */
export function suppressionBlock({ k, cells = [], extra = {} } = {}) {
  const counts = {};
  for (const cell of cells) {
    if (!cell) continue;
    counts[cell.status] = (counts[cell.status] ?? 0) + 1;
  }
  const suppressed = (counts[STATUS.suppressed_small_count] ?? 0)
    + (counts[STATUS.suppressed_complementary] ?? 0);
  return {
    min_cell: k,
    suppressed_cells: suppressed,
    status_counts: counts,
    policy:
      `Any count of people below ${k}, or whose complement within its group is below ${k}, is ` +
      'withheld, and a second cell is withheld when one withheld cell could be recovered by ' +
      'subtracting published cells from a total. A withheld value is null with a status, never a ' +
      'zero: zero means measured and empty, unmeasured means nothing was collected.',
    ...extra,
  };
}
