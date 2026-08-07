const SAFE_UNQUOTED = /^[A-Za-z0-9_/:=.,+-]+$/;

/**
 * Quote a single argument for safe interpolation into a POSIX shell command line.
 *
 * Values made purely of shell-safe characters are returned as-is so generated
 * commands stay readable; everything else is single-quoted with embedded quotes
 * escaped.
 */
export function shellQuote(value: string): string {
  if (SAFE_UNQUOTED.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Join an argv array into a single shell-safe command line. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}
