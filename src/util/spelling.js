// -----------------------------------------------------------------------------
// Close names for a typo.
// -----------------------------------------------------------------------------
// =============================================================================
// SPELLING SUGGESTIONS
// =============================================================================

/**
 * Edit distance between two names: one insertion, deletion, substitution
 * or swap of two neighbouring letters per step ("strat" is one step from
 * "start"), ignoring case - so a name differing only by its case is at
 * distance 0.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) { return 0; }
  let beforePrevious = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

/**
 * The known names closest to a misspelled one, best first - only those
 * close enough to be a plausible typo: at most one edit per three letters
 * (at least one), case differences being free.
 *
 * @param {string} name - what was typed
 * @param {Iterable<string>} candidates
 * @param {number} [max]
 * @returns {string[]}
 */
function findSimilarNames(name, candidates, max = 3) {
  const limit = Math.max(1, Math.floor(name.length / 3));
  return [...new Set(candidates)]
    .filter(candidate => candidate !== name)
    .map(candidate => ({ candidate, distance: editDistance(name, candidate) }))
    .filter(entry => entry.distance <= limit)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, max)
    .map(entry => entry.candidate);
}

Object.assign(module.exports, {
  findSimilarNames,
});
