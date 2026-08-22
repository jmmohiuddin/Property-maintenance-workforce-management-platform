import { check, equal, done } from "./_harness";
import { base64Encode, base64Decode } from "../src/media/base64";
import { utf8Encode } from "../src/domain/hash";

// RFC 4648 §10 test vectors.
equal("encode('')", base64Encode(utf8Encode("")), "");
equal("encode('f')", base64Encode(utf8Encode("f")), "Zg==");
equal("encode('fo')", base64Encode(utf8Encode("fo")), "Zm8=");
equal("encode('foo')", base64Encode(utf8Encode("foo")), "Zm9v");
equal("encode('foob')", base64Encode(utf8Encode("foob")), "Zm9vYg==");
equal("encode('fooba')", base64Encode(utf8Encode("fooba")), "Zm9vYmE=");
equal("encode('foobar')", base64Encode(utf8Encode("foobar")), "Zm9vYmFy");

function textOf(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
}

equal("decode('Zg==')", textOf(base64Decode("Zg==")), "f");
equal("decode('Zm9vYmFy')", textOf(base64Decode("Zm9vYmFy")), "foobar");

// Round trip on binary data that is not valid text, including bytes with the
// high bit set - the case an ASCII-only fixture would not catch.
const binary = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256);
const roundTripped = base64Decode(base64Encode(binary));
check("binary round-trip preserves length", roundTripped.length === binary.length);
check("binary round-trip preserves bytes", binary.every((b, i) => roundTripped[i] === b));

// A PNG-sized signature image is a few KB; confirm the encoder handles a
// buffer well past one 3-byte group.
const large = new Uint8Array(10_000).fill(0xab);
check("large buffer round-trips", base64Decode(base64Encode(large)).every((b) => b === 0xab));

done("base64");
