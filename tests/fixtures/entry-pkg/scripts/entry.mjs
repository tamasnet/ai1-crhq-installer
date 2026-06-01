#!/usr/bin/env node
// Fixture install_entry — echoes the flags the runner forwarded so the test can assert forwarding
// + mode propagation. A real install_entry would do package-specific work here (OAuth, seed, etc.).
console.log(`ENTRY-ARGV: ${process.argv.slice(2).join(' ')}`);
process.exit(0);
