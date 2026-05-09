// xorshift128 — fast, seedable, 32-bit PRNG. Period 2^128-1.
// Output quality is more than sufficient for visual demo data.

export function xorshift128(seed) {
	let s0 = seed | 0 || 1;
	let s1 = s0 * 1103515245 + 12345;
	let s2 = s1 * 1103515245 + 12345;
	let s3 = s2 * 1103515245 + 12345;
	return function next() {
		let t = s3;
		t ^= t << 11;
		t ^= t >>> 8;
		s3 = s2;
		s2 = s1;
		s1 = s0;
		t ^= s0;
		t ^= s0 >>> 19;
		s0 = t;
		return (t >>> 0) / 4294967296;
	};
}
