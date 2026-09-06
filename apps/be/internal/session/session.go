// Package session proves that a browser holds the key for an Ethereum address, and remembers
// the answer in a cookie.
//
// There is no account to log into. The wallet is the identity, so the only question is whether
// whoever is asking controls the address they claim. An EIP-712 signature answers it, costs no
// gas, and reveals nothing about the person.
package session

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"
)

// Errors a caller may want to tell apart. Everything else is a bad request.
var (
	ErrBadSignature = errors.New("signature does not come from that address")
	ErrBadNonce     = errors.New("nonce is unknown, spent, or expired")
	ErrStale        = errors.New("signature was issued too long ago")
	ErrNoCookie     = errors.New("no session")
	ErrExpired      = errors.New("session expired")
)

// ChainID names the chain in the EIP-712 domain. Arbitrum One, which is where everything the
// signature will later authorise actually lives.
const ChainID = 42161

// Domain and message type strings, hashed once. Changing any byte here changes every digest,
// which is why they are constants rather than assembled at call time.
const (
	domainType  = "EIP712Domain(string name,string version,uint256 chainId)"
	sessionType = "Session(address wallet,string nonce,uint256 issuedAt)"
	domainName  = "Helico"
	domainVer   = "1"
)

// MaxSkew is how far in the past a signature may have been issued and still be accepted. The
// nonce already makes a signature single-use; this bounds how long a stolen one is worth
// anything before it is spent.
const MaxSkew = 5 * time.Minute

func keccak(parts ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// pad32 left-pads to a 32-byte ABI word.
func pad32(b []byte) []byte {
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

// Digest is the EIP-712 hash a wallet signs: keccak(0x19 0x01 || domain || struct).
func Digest(wallet string, nonce string, issuedAt int64) ([]byte, error) {
	addr, err := parseAddress(wallet)
	if err != nil {
		return nil, err
	}
	domain := keccak(
		keccak([]byte(domainType)),
		keccak([]byte(domainName)),
		keccak([]byte(domainVer)),
		pad32(big.NewInt(ChainID).Bytes()),
	)
	message := keccak(
		keccak([]byte(sessionType)),
		pad32(addr),
		keccak([]byte(nonce)),
		pad32(big.NewInt(issuedAt).Bytes()),
	)
	return keccak([]byte{0x19, 0x01}, domain, message), nil
}

// TypedData is the EIP-712 payload a wallet is asked to sign, in the shape `signTypedData_v4`
// expects. The backend builds it so the browser cannot quietly sign something else.
func TypedData(wallet, nonce string, issuedAt int64) map[string]any {
	return map[string]any{
		"domain":      map[string]any{"name": domainName, "version": domainVer, "chainId": ChainID},
		"primaryType": "Session",
		"types": map[string]any{
			"EIP712Domain": []map[string]string{
				{"name": "name", "type": "string"},
				{"name": "version", "type": "string"},
				{"name": "chainId", "type": "uint256"},
			},
			"Session": []map[string]string{
				{"name": "wallet", "type": "address"},
				{"name": "nonce", "type": "string"},
				{"name": "issuedAt", "type": "uint256"},
			},
		},
		"message": map[string]any{
			"wallet":   wallet,
			"nonce":    nonce,
			"issuedAt": strconv.FormatInt(issuedAt, 10),
		},
	}
}

func parseAddress(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimPrefix(strings.ToLower(s), "0x"))
	if err != nil || len(b) != 20 {
		return nil, fmt.Errorf("not an address: %q", s)
	}
	return b, nil
}

// Normalise puts an address in the one form the database and the cookie use: lowercase, 0x.
func Normalise(s string) (string, error) {
	b, err := parseAddress(s)
	if err != nil {
		return "", err
	}
	return "0x" + hex.EncodeToString(b), nil
}

// Recover returns the address whose key produced sig over digest.
func Recover(digest, sig []byte) (string, error) {
	if len(sig) != 65 {
		return "", ErrBadSignature
	}
	// Wallets send r || s || v with v as 27/28; some send 0/1. dcrd wants the recovery byte
	// first, offset by 27.
	v := sig[64]
	if v >= 27 {
		v -= 27
	}
	if v > 1 {
		return "", ErrBadSignature
	}
	compact := make([]byte, 65)
	compact[0] = v + 27
	copy(compact[1:], sig[:64])

	pub, _, err := ecdsa.RecoverCompact(compact, digest)
	if err != nil {
		return "", ErrBadSignature
	}
	// The address is the last 20 bytes of the keccak of the uncompressed key without its 0x04.
	return "0x" + hex.EncodeToString(keccak(pub.SerializeUncompressed()[1:])[12:]), nil
}

// Verify checks the signature against the address that claims it, and that it was issued
// recently enough. The nonce is the caller's to spend.
func Verify(wallet, nonce string, issuedAt int64, sig []byte, now time.Time) (string, error) {
	want, err := Normalise(wallet)
	if err != nil {
		return "", err
	}
	if issuedAt > now.Add(time.Minute).Unix() || now.Sub(time.Unix(issuedAt, 0)) > MaxSkew {
		return "", ErrStale
	}
	digest, err := Digest(want, nonce, issuedAt)
	if err != nil {
		return "", err
	}
	got, err := Recover(digest, sig)
	if err != nil {
		return "", err
	}
	if !hmac.Equal([]byte(got), []byte(want)) {
		return "", ErrBadSignature
	}
	return want, nil
}

// Nonces hands out single-use nonces and forgets them when they are spent or stale.
//
// In memory rather than in a table: the process is single, and a restart costing someone one
// extra signature is a better trade than a table that has to be swept.
type Nonces struct {
	ttl  time.Duration
	mu   sync.Mutex
	seen map[string]time.Time
}

// NewNonces returns a store whose nonces live for ttl.
func NewNonces(ttl time.Duration) *Nonces {
	if ttl <= 0 {
		ttl = 2 * time.Minute
	}
	return &Nonces{ttl: ttl, seen: map[string]time.Time{}}
}

// Issue returns a fresh nonce, valid once.
func (n *Nonces) Issue(now time.Time) (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	nonce := base64.RawURLEncoding.EncodeToString(raw)
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sweep(now)
	n.seen[nonce] = now.Add(n.ttl)
	return nonce, nil
}

// Spend consumes a nonce. A nonce that was never issued, has already been spent, or has
// expired is refused — which is the whole point of it existing.
func (n *Nonces) Spend(nonce string, now time.Time) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sweep(now)
	expiry, ok := n.seen[nonce]
	if !ok || now.After(expiry) {
		return ErrBadNonce
	}
	delete(n.seen, nonce)
	return nil
}

func (n *Nonces) sweep(now time.Time) {
	for k, expiry := range n.seen {
		if now.After(expiry) {
			delete(n.seen, k)
		}
	}
}

// Cookies mints and reads the session cookie.
//
// Stateless: the cookie carries the address and its expiry, signed with a server secret. There
// is no session table to grow, and nothing to look up on a read.
type Cookies struct {
	secret []byte
	life   time.Duration
}

// NewCookies returns a minter. An empty secret gets a random one, which means every restart
// signs everyone out — the caller is expected to say so.
func NewCookies(secret string, life time.Duration) (*Cookies, error) {
	key := []byte(secret)
	if len(key) == 0 {
		key = make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
	}
	if life <= 0 {
		life = 7 * 24 * time.Hour
	}
	return &Cookies{secret: key, life: life}, nil
}

// Life is how long a freshly issued cookie lasts.
func (c *Cookies) Life() time.Duration { return c.life }

func (c *Cookies) sign(payload []byte) []byte {
	m := hmac.New(sha256.New, c.secret)
	m.Write(payload)
	return m.Sum(nil)
}

// Issue returns the cookie value for an address.
func (c *Cookies) Issue(wallet string, now time.Time) (string, error) {
	addr, err := Normalise(wallet)
	if err != nil {
		return "", err
	}
	payload := make([]byte, 8, 8+len(addr))
	binary.BigEndian.PutUint64(payload, uint64(now.Add(c.life).Unix()))
	payload = append(payload, addr...)
	return base64.RawURLEncoding.EncodeToString(append(payload, c.sign(payload)...)), nil
}

// Read returns the address a cookie value names, or why it cannot be trusted.
func (c *Cookies) Read(value string, now time.Time) (string, error) {
	if value == "" {
		return "", ErrNoCookie
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(raw) <= 8+sha256.Size {
		return "", ErrNoCookie
	}
	payload, mac := raw[:len(raw)-sha256.Size], raw[len(raw)-sha256.Size:]
	if !hmac.Equal(mac, c.sign(payload)) {
		return "", ErrNoCookie
	}
	if now.Unix() > int64(binary.BigEndian.Uint64(payload[:8])) {
		return "", ErrExpired
	}
	return Normalise(string(payload[8:]))
}
