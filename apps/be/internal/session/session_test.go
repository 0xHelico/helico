package session

import (
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// A throwaway key. It signs nothing but these tests.
const testKeyHex = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"

func testKey(t *testing.T) (*secp256k1.PrivateKey, string) {
	t.Helper()
	raw, err := hex.DecodeString(testKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	key := secp256k1.PrivKeyFromBytes(raw)
	addr := "0x" + hex.EncodeToString(keccak(key.PubKey().SerializeUncompressed()[1:])[12:])
	return key, addr
}

// sign produces what a wallet produces: r || s || v, with v as 27 or 28.
func sign(t *testing.T, key *secp256k1.PrivateKey, digest []byte) []byte {
	t.Helper()
	compact := ecdsa.SignCompact(key, digest, false)
	sig := make([]byte, 65)
	copy(sig, compact[1:])
	sig[64] = compact[0] - 27 + 27
	return sig
}

func TestRecoverReturnsTheSigner(t *testing.T) {
	key, addr := testKey(t)
	digest, err := Digest(addr, "abc", 1_800_000_000)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Recover(digest, sign(t, key, digest))
	if err != nil {
		t.Fatal(err)
	}
	if got != addr {
		t.Fatalf("recovered %s, want %s", got, addr)
	}
}

func TestVerifyAcceptsAFreshSignature(t *testing.T) {
	key, addr := testKey(t)
	now := time.Unix(1_800_000_000, 0)
	digest, _ := Digest(addr, "abc", now.Unix())
	got, err := Verify(addr, "abc", now.Unix(), sign(t, key, digest), now)
	if err != nil {
		t.Fatal(err)
	}
	if got != addr {
		t.Fatalf("verified as %s, want %s", got, addr)
	}
}

// The address is checked, not trusted: a real signature from the wrong key must not pass.
func TestVerifyRefusesAnotherAddress(t *testing.T) {
	key, addr := testKey(t)
	now := time.Unix(1_800_000_000, 0)
	other := "0x1111111111111111111111111111111111111111"
	digest, _ := Digest(other, "abc", now.Unix())
	if _, err := Verify(other, "abc", now.Unix(), sign(t, key, digest), now); err == nil {
		t.Fatalf("a signature from %s passed as %s", addr, other)
	}
}

// Every field is in the digest, so changing one after signing must break it.
func TestVerifyRefusesATamperedPayload(t *testing.T) {
	key, addr := testKey(t)
	now := time.Unix(1_800_000_000, 0)
	digest, _ := Digest(addr, "abc", now.Unix())
	sig := sign(t, key, digest)

	if _, err := Verify(addr, "xyz", now.Unix(), sig, now); err == nil {
		t.Fatal("a changed nonce passed")
	}
	if _, err := Verify(addr, "abc", now.Unix()-1, sig, now); err == nil {
		t.Fatal("a changed issuedAt passed")
	}
}

func TestVerifyRefusesAStaleOrFutureSignature(t *testing.T) {
	key, addr := testKey(t)
	now := time.Unix(1_800_000_000, 0)
	old := now.Add(-MaxSkew - time.Second).Unix()
	digest, _ := Digest(addr, "abc", old)
	if _, err := Verify(addr, "abc", old, sign(t, key, digest), now); err != ErrStale {
		t.Fatalf("stale signature: got %v, want ErrStale", err)
	}
	ahead := now.Add(2 * time.Minute).Unix()
	digest, _ = Digest(addr, "abc", ahead)
	if _, err := Verify(addr, "abc", ahead, sign(t, key, digest), now); err != ErrStale {
		t.Fatalf("future signature: got %v, want ErrStale", err)
	}
}

func TestNoncesAreSingleUse(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	n := NewNonces(2 * time.Minute)
	nonce, err := n.Issue(now)
	if err != nil {
		t.Fatal(err)
	}
	if err := n.Spend(nonce, now); err != nil {
		t.Fatalf("first spend: %v", err)
	}
	if err := n.Spend(nonce, now); err != ErrBadNonce {
		t.Fatalf("replay: got %v, want ErrBadNonce", err)
	}
	if err := n.Spend("never-issued", now); err != ErrBadNonce {
		t.Fatalf("unknown nonce: got %v, want ErrBadNonce", err)
	}
	fresh, _ := n.Issue(now)
	if err := n.Spend(fresh, now.Add(3*time.Minute)); err != ErrBadNonce {
		t.Fatalf("expired nonce: got %v, want ErrBadNonce", err)
	}
}

func TestCookieRoundTrip(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	c, err := NewCookies("a-secret", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	_, addr := testKey(t)
	value, err := c.Issue(strings.ToUpper(addr[:2])+addr[2:], now)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Read(value, now)
	if err != nil {
		t.Fatal(err)
	}
	if got != addr {
		t.Fatalf("read %s, want %s", got, addr)
	}
	if _, err := c.Read(value, now.Add(2*time.Hour)); err != ErrExpired {
		t.Fatalf("expired cookie: got %v, want ErrExpired", err)
	}
}

// The point of signing the cookie: a value the server did not mint must not be believed.
func TestCookieRefusesAForgery(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	mine, _ := NewCookies("a-secret", time.Hour)
	theirs, _ := NewCookies("another-secret", time.Hour)
	_, addr := testKey(t)

	forged, _ := theirs.Issue(addr, now)
	if _, err := mine.Read(forged, now); err != ErrNoCookie {
		t.Fatalf("a cookie signed with another key was accepted: %v", err)
	}
	valid, _ := mine.Issue(addr, now)
	if _, err := mine.Read(valid[:len(valid)-2]+"aa", now); err == nil {
		t.Fatal("a tampered cookie was accepted")
	}
	if _, err := mine.Read("", now); err != ErrNoCookie {
		t.Fatal("an empty cookie was accepted")
	}
}

// The digest a wallet signs, pinned to what viem's hashTypedData produces for the same input.
//
// This is the test that matters most: everything else here signs with our own code and checks
// our own recovery, which would still agree with itself if the domain or the type string were
// wrong. A wallet uses viem's rules, and a digest that differs by one byte means every real
// signature is rejected with no clue why.
//
//	hashTypedData({
//	  domain: { name: "Helico", version: "1", chainId: 42161 },
//	  primaryType: "Session",
//	  types: { Session: [{ name: "wallet", type: "address" },
//	                     { name: "nonce", type: "string" },
//	                     { name: "issuedAt", type: "uint256" }] },
//	  message: { wallet: "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
//	             nonce: "a-nonce", issuedAt: 1800000000n },
//	})
func TestDigestMatchesViem(t *testing.T) {
	const want = "0x32494e4e82a52030678335f4a3f2f33eca1ec569961ef552c5a50b62f5fca81d"
	got, err := Digest("0x2c7536E3605D9C16a7a3D7b1898e529396a65c23", "a-nonce", 1_800_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if "0x"+hex.EncodeToString(got) != want {
		t.Fatalf("digest %s, want %s — a wallet signing this would be rejected", "0x"+hex.EncodeToString(got), want)
	}
}

// What the browser is told to sign must be what the backend hashes. If these drift, the wallet
// signs one struct and the server checks another.
func TestTypedDataDescribesTheStructTheDigestHashes(t *testing.T) {
	td := TypedData("0x2c7536E3605D9C16a7a3D7b1898e529396a65c23", "a-nonce", 1_800_000_000)
	if td["primaryType"] != "Session" {
		t.Fatalf("primaryType %v", td["primaryType"])
	}
	domain, _ := td["domain"].(map[string]any)
	if domain["name"] != domainName || domain["version"] != domainVer || domain["chainId"] != ChainID {
		t.Fatalf("domain %v does not match the constants the digest uses", domain)
	}
	fields, _ := td["types"].(map[string]any)["Session"].([]map[string]string)
	var rebuilt []string
	for _, f := range fields {
		rebuilt = append(rebuilt, f["type"]+" "+f["name"])
	}
	if got := "Session(" + strings.Join(rebuilt, ",") + ")"; got != sessionType {
		t.Fatalf("typed data says %s, digest hashes %s", got, sessionType)
	}
}
