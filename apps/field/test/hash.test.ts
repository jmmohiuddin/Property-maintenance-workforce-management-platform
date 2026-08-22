import { check, equal, done } from "./_harness";
import { sha256Hex, utf8Encode, sha256OfCanonicalSheet } from "../src/domain/hash";

// FIPS 180-4 / NIST published SHA-256 test vectors, plus one that crosses the
// two-block boundary - the case most likely to expose a padding bug.
equal("sha256('')", sha256Hex(utf8Encode("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
equal("sha256('abc')", sha256Hex(utf8Encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
equal(
  "sha256(two-block message)",
  sha256Hex(utf8Encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
  "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
);
equal(
  "sha256('The quick brown fox jumps over the lazy dog')",
  sha256Hex(utf8Encode("The quick brown fox jumps over the lazy dog")),
  "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
);

// A message exactly at the padding boundary (55 bytes: the largest single
// block can hold before the 1-bit + 64-bit length no longer fits) and one
// just past it (56 bytes, which must spill into a second block). Expected
// values generated independently with Node's `crypto` module, not typed from
// memory - the boundary is exactly where a padding bug hides.
equal("sha256(55 'a's)", sha256Hex(utf8Encode("a".repeat(55))),
  "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318");
equal("sha256(56 'a's)", sha256Hex(utf8Encode("a".repeat(56))),
  "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");

check("utf8Encode round-trips ASCII length", utf8Encode("abc").length === 3);
check("utf8Encode handles a multi-byte code point", utf8Encode("€").length === 3); // U+20AC -> 3 bytes
check("utf8Encode handles a surrogate-pair emoji", utf8Encode("😀").length === 4); // U+1F600 -> 4 bytes

void sha256OfCanonicalSheet("abc").then((digest) => {
  equal("sha256OfCanonicalSheet matches sha256Hex", digest, sha256Hex(utf8Encode("abc")));
  done("hash");
});
