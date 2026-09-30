// Preload fixture: replaces the runtime's locale-aware comparison with a
// deliberately hostile collation (exact reverse of code-unit order).
//
// Why a fixture instead of `LC_ALL=...`: the point of LAC-1394 is that the
// general-server shard split must not depend on the runtime collation. The
// obvious way to test that -- run the dry-run twice under different `LC_ALL`
// values and diff -- only works where ICU reads the locale from the POSIX
// environment. On Windows it does not (measured: `LC_ALL=C` and
// `LC_ALL=de_DE.UTF-8` both resolve to the machine locale), so that test would
// pass by doing nothing: a false green, which is the exact class of defect this
// guard exists to catch. Patching the comparison itself is platform-independent
// and strictly stronger: any surviving `localeCompare` in the ordering path
// reverses the list and therefore the partition.
//
// Loaded with `node --import`, so it runs before the script under test.

function reversedCompare(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? 1 : left > right ? -1 : 0;
}

Object.defineProperty(String.prototype, "localeCompare", {
  value: function localeCompare(that) {
    return reversedCompare(this, that);
  },
  writable: true,
  configurable: true,
});

// `Intl.Collator.prototype.compare` is an accessor, so it needs its own patch.
Object.defineProperty(Intl.Collator.prototype, "compare", {
  get() {
    return reversedCompare;
  },
  configurable: true,
});
