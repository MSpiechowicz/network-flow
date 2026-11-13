import { defineScenario } from '../../model/types';
import type { HeaderField, HeaderGroup, PacketMeta } from '../../model/types';
import { HOST, IP, ISN, MAC, PORT } from '../lib/addresses';
import { ethernet, http1Request, http1Response, ipv4, tcp, tlsHandshake } from '../lib/builders';
import type { HeaderList } from '../lib/builders';

/**
 * A TLS 1.3 1-RTT handshake with a certificate chain, then protected HTTP and a session ticket.
 * The TCP handshake that precedes the ClientHello is collapsed (documented, and `resync` is set on
 * the first segment of each direction).
 */

// ---------------------------------------------------------------------------
// Record sizes (bytes on the wire inside the TCP payload)
// ---------------------------------------------------------------------------

// ClientHello: 2 version + 32 random + 33 session id + 8 suites + 2 compression + 2 extensions
// length + 127 of extensions (SNI 24, groups 10, sigalgs 18, ALPN 18, versions 9, psk modes 6,
// key_share 42) = 206; + 4 handshake header + 5 record header.
const CLIENT_HELLO_RECORD = 215;
// ServerHello: 2 + 32 + 33 + 2 suite + 1 compression + 2 + 46 of extensions = 118; + 4 + 5.
const SERVER_HELLO_RECORD = 127;
const CHANGE_CIPHER_SPEC_RECORD = 6;
// Protected records are 5-byte header + content + 1-byte inner type + 16-byte tag.
const TLS_OVERHEAD = 22;
const sealed = (plainBytes: number) => plainBytes + TLS_OVERHEAD;
const ENCRYPTED_EXTENSIONS_RECORD = sealed(15); // 4 header + 2 length + ALPN extension (9)
const LEAF_CERT_BYTES = 550;
const INTERMEDIATE_CERT_BYTES = 480;
// 4 header + 1 context + 3 list length + (3 + cert + 2 extension length) for each certificate.
const CERTIFICATE_RECORD = sealed(
  4 + 1 + 3 + 3 + LEAF_CERT_BYTES + 2 + 3 + INTERMEDIATE_CERT_BYTES + 2,
);
const CERTIFICATE_VERIFY_RECORD = sealed(4 + 2 + 2 + 72); // ECDSA P-256 signature in DER
const FINISHED_RECORD = sealed(4 + 32); // SHA-256 HMAC
const NEW_SESSION_TICKET_RECORD = sealed(4 + 4 + 4 + 1 + 8 + 2 + 192 + 2);

// ---------------------------------------------------------------------------
// The protected HTTP exchange
// ---------------------------------------------------------------------------

const GET_FIELDS: HeaderList = [
  ['User-Agent', 'ExampleBrowser/1.0'],
  ['Accept', 'text/html'],
];
const OK_FIELDS: HeaderList = [
  ['Date', 'Fri, 13 Nov 2026 10:15:02 GMT'],
  ['Content-Type', 'text/html; charset=utf-8'],
  ['Content-Length', '1024'],
];
const BODY_BYTES = 1024;

/** Bytes of a start line plus header lines plus the blank line, all ASCII with CRLF endings. */
function headBytes(startLine: string, fields: HeaderList): number {
  const lines = [startLine, ...fields.map(([name, value]) => `${name}: ${value}`)];

  return lines.reduce((sum, line) => sum + line.length + 2, 0) + 2;
}

const GET_BYTES = headBytes('GET / HTTP/1.1', [['Host', HOST.www], ...GET_FIELDS]);
const OK_BYTES = headBytes('HTTP/1.1 200 OK', OK_FIELDS) + BODY_BYTES;

// ---------------------------------------------------------------------------
// TCP plumbing
// ---------------------------------------------------------------------------

/** Tracks the next sequence number of one direction of a connection. */
function stream(start: number) {
  let next = start;

  return {
    take(length: number): number {
      const seq = next;
      next += length;

      return seq;
    },
    peek(): number {
      return next;
    },
  };
}

const CONN = 'tls';
const CLIENT_PORT = 60771;

// Placeholder frame for the server side: the real next hop and its MAC address are not modelled.
const MAC_INTERNET_GATEWAY = MAC.spare[3];

// The SYN used one number on each side; the handshake itself is not drawn.
const client = stream(ISN.client + 1);
const server = stream(ISN.server + 1);

interface SegmentInput {
  direction: 'up' | 'down';
  seq: number;
  ack: number;
  len: number;
  ipId: number;
  resync?: boolean;
}

interface Segment {
  headers: HeaderGroup[];
  meta: PacketMeta;
  sizeBytes: number;
}

/**
 * Ethernet, IPv4 and TCP for one data segment, as captured at the sender. Downstream segments are
 * addressed to the home router’s public address, the only address the server sees (NAT).
 */
function segment(s: SegmentInput): Segment {
  const up = s.direction === 'up';
  const header = tcp({
    conn: CONN,
    srcPort: up ? CLIENT_PORT : PORT.https,
    dstPort: up ? PORT.https : CLIENT_PORT,
    seq: s.seq,
    ack: s.ack,
    flags: ['PSH', 'ACK'],
    len: s.len,
    window: up ? 502 : 509,
    resync: s.resync,
  });
  // 20-byte IPv4 header + 20-byte TCP header + 12 bytes of timestamp options.
  const ip = ipv4({
    src: up ? IP.laptop : IP.cdnEdge,
    dst: up ? IP.cdnEdge : IP.routerPublic,
    ttl: 64,
    id: s.ipId,
    df: true,
    protocol: 'TCP',
    totalLength: 52 + s.len,
  });

  return {
    headers: [
      ethernet({
        src: up ? MAC.laptop : MAC.cdnEdge,
        dst: up ? MAC.routerLan : MAC_INTERNET_GATEWAY,
        etherType: 'IPv4',
      }),
      ip.group,
      header.group,
    ],
    meta: { ipv4: ip.meta, tcp: header.meta },
    sizeBytes: 66 + s.len,
  };
}

// Each segment is built in the order it is sent: `seq` takes from the sender's stream and `ack`
// peeks at the peer's, so both stay consistent with the packet order below.
const clientHelloSegment = segment({
  direction: 'up',
  seq: client.take(CLIENT_HELLO_RECORD),
  ack: server.peek(),
  len: CLIENT_HELLO_RECORD,
  ipId: 0x6e11,
  resync: true,
});
const serverHelloLength = SERVER_HELLO_RECORD + CHANGE_CIPHER_SPEC_RECORD;
const serverHelloSegment = segment({
  direction: 'down',
  seq: server.take(serverHelloLength),
  ack: client.peek(),
  len: serverHelloLength,
  ipId: 0x7a20,
  resync: true,
});
const encryptedExtensionsSegment = segment({
  direction: 'down',
  seq: server.take(ENCRYPTED_EXTENSIONS_RECORD),
  ack: client.peek(),
  len: ENCRYPTED_EXTENSIONS_RECORD,
  ipId: 0x7a21,
});
const certificateSegment = segment({
  direction: 'down',
  seq: server.take(CERTIFICATE_RECORD),
  ack: client.peek(),
  len: CERTIFICATE_RECORD,
  ipId: 0x7a22,
});
const certificateVerifySegment = segment({
  direction: 'down',
  seq: server.take(CERTIFICATE_VERIFY_RECORD),
  ack: client.peek(),
  len: CERTIFICATE_VERIFY_RECORD,
  ipId: 0x7a23,
});
const serverFinishedSegment = segment({
  direction: 'down',
  seq: server.take(FINISHED_RECORD),
  ack: client.peek(),
  len: FINISHED_RECORD,
  ipId: 0x7a24,
});
const clientFinishedLength = CHANGE_CIPHER_SPEC_RECORD + FINISHED_RECORD;
const clientFinishedSegment = segment({
  direction: 'up',
  seq: client.take(clientFinishedLength),
  ack: server.peek(),
  len: clientFinishedLength,
  ipId: 0x6e12,
});
const getSegment = segment({
  direction: 'up',
  seq: client.take(sealed(GET_BYTES)),
  ack: server.peek(),
  len: sealed(GET_BYTES),
  ipId: 0x6e13,
});
const okSegment = segment({
  direction: 'down',
  seq: server.take(sealed(OK_BYTES)),
  ack: client.peek(),
  len: sealed(OK_BYTES),
  ipId: 0x7a25,
});
const ticketSegment = segment({
  direction: 'down',
  seq: server.take(NEW_SESSION_TICKET_RECORD),
  ack: client.peek(),
  len: NEW_SESSION_TICKET_RECORD,
  ipId: 0x7a26,
});

// ---------------------------------------------------------------------------
// Handshake message fields
// ---------------------------------------------------------------------------

const CLIENT_HELLO_FIELDS: HeaderField[] = [
  {
    name: 'legacy_version',
    value: '0x0303',
    note: 'frozen; real versions are in supported_versions',
  },
  { name: 'random', value: '32 random bytes' },
  { name: 'legacy_session_id', value: '32 bytes', note: 'compatibility value for middleboxes' },
  {
    name: 'cipher_suites',
    value: 'TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256',
  },
  { name: 'legacy_compression_methods', value: '0 (null)' },
  { name: 'supported_versions', value: '0x0304 (TLS 1.3), 0x0303 (TLS 1.2)' },
  { name: 'supported_groups', value: 'x25519, secp256r1' },
  {
    name: 'signature_algorithms',
    value:
      'ecdsa_secp256r1_sha256, rsa_pss_rsae_sha256, rsa_pkcs1_sha256, ecdsa_secp384r1_sha384, rsa_pss_rsae_sha384, ed25519',
  },
  {
    name: 'key_share',
    value: 'x25519, 32-byte public value',
    note: 'ephemeral key generated for this connection',
  },
  { name: 'psk_key_exchange_modes', value: 'psk_dhe_ke' },
  { name: 'server_name', value: HOST.www, note: 'SNI, sent in clear text' },
  { name: 'alpn', value: 'h2, http/1.1' },
];

const SERVER_HELLO_FIELDS: HeaderField[] = [
  { name: 'legacy_version', value: '0x0303' },
  { name: 'random', value: '32 random bytes' },
  { name: 'legacy_session_id_echo', value: '32 bytes', note: 'copy of the client’s value' },
  { name: 'cipher_suite', value: 'TLS_AES_128_GCM_SHA256' },
  { name: 'legacy_compression_method', value: '0 (null)' },
  { name: 'supported_versions', value: '0x0304 (TLS 1.3)', note: 'the real version choice' },
  { name: 'key_share', value: 'x25519, 32-byte public value', note: 'server’s ephemeral key' },
];

const CERTIFICATE_FIELDS: HeaderField[] = [
  {
    name: 'certificate_request_context',
    value: 'empty',
    note: 'always empty for a server certificate',
  },
  {
    name: 'certificate_list[0] (leaf)',
    value: `${LEAF_CERT_BYTES} bytes: subject CN ${HOST.www}, SAN DNS:${HOST.www}`,
    note: 'ECDSA P-256 key; issuer Example Intermediate CA 1; valid 2026-10-05 to 2027-03-24',
  },
  {
    name: 'certificate_list[1] (intermediate)',
    value: `${INTERMEDIATE_CERT_BYTES} bytes: subject Example Intermediate CA 1`,
    note: 'issuer Example Root CA; valid 2024-06-01 to 2034-06-01',
  },
  {
    name: 'Root CA',
    value: 'not sent',
    note: 'the client already has it in its trust store',
  },
];

/** What the endpoints see inside an encrypted record, and what the wire shows instead. */
const sealedRecord = (plainBytes: number): HeaderGroup =>
  tlsHandshake({
    message: 'ApplicationData',
    fields: [
      {
        name: 'Encrypted Application Data',
        value: `${sealed(plainBytes)} bytes`,
        note: `${plainBytes} bytes of HTTP + 1 byte inner type + 16-byte tag`,
      },
    ],
  });

const REF_8446 = (label: string, anchor: string) => ({
  label: `RFC 8446, ${label}`,
  url: `https://www.rfc-editor.org/rfc/rfc8446#${anchor}`,
});

export default defineScenario({
  id: 'tls',
  title: 'TLS',
  tagline:
    'The TLS 1.3 handshake: key exchange, certificate checks and protected data in one round trip.',
  category: 'web',
  order: 2,
  protocols: ['ethernet', 'ipv4', 'tcp', 'tls', 'http'],
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'Your laptop',
      sublabel: IP.laptop,
      position: { col: 0, row: 2 },
      zone: 'home',
      addresses: { ipv4: IP.laptop, mac: MAC.laptop },
    },
    {
      id: 'router',
      kind: 'router',
      label: 'Home router',
      sublabel: IP.routerLan,
      position: { col: 2.5, row: 2 },
      zone: 'home',
      addresses: { ipv4: IP.routerLan, mac: MAC.routerLan },
    },
    {
      id: 'server',
      kind: 'server',
      label: 'Web server',
      sublabel: IP.cdnEdge,
      position: { col: 6.5, row: 2 },
      zone: 'web',
      addresses: { ipv4: IP.cdnEdge, mac: MAC.cdnEdge, hostname: HOST.www },
    },
  ],
  links: [
    { id: 'laptop-router', a: 'laptop', b: 'router', medium: 'wifi' },
    { id: 'router-server', a: 'router', b: 'server', medium: 'wan' },
  ],
  zones: [
    {
      id: 'home',
      label: 'Home LAN',
      from: { col: -0.75, row: 0.5 },
      to: { col: 3.25, row: 3.5 },
      tone: 'lan',
    },
    {
      id: 'web',
      label: 'Web host',
      from: { col: 5, row: 0.5 },
      to: { col: 8, row: 3.5 },
      tone: 'datacenter',
    },
  ],
  phases: [
    { id: 'hello', label: 'Hello messages' },
    { id: 'server-flight', label: 'Server flight' },
    { id: 'client-flight', label: 'Client flight' },
    { id: 'data', label: 'Protected data' },
  ],
  sequenceLanes: ['laptop', 'server'],
  steps: [
    {
      id: 'client-hello',
      title: 'ClientHello: what the client offers',
      phase: 'hello',
      summary:
        'The client lists its TLS versions, cipher suites and signature algorithms, and already sends an x25519 public key, so the server can finish the key exchange in its first reply.',
      body: [
        {
          type: 'p',
          text: 'The first message is sent in the clear. `legacy_version` is frozen at `0x0303`; the real versions sit in `supported_versions` (TLS 1.3 is `0x0304`). The client also offers cipher suites such as `TLS_AES_128_GCM_SHA256`, signature algorithms, the SNI hostname and the ALPN list.',
        },
        {
          type: 'p',
          text: 'The key extension is `key_share`: the client guesses a group, here x25519, and sends an **ephemeral** public key right away. Guessing correctly is what lets TLS 1.3 finish in one round trip. The private half never leaves the laptop.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'The 32-byte `legacy_session_id` and the ChangeCipherSpec records later on exist only so the connection looks like TLS 1.2 to middleboxes.',
        },
      ],
      packets: [
        {
          id: 'p-client-hello',
          from: 'laptop',
          to: 'server',
          via: ['router'],
          protocol: 'tls',
          label: 'ClientHello',
          summary: `ClientHello (SNI ${HOST.www}, key_share x25519)`,
          headers: [
            ...clientHelloSegment.headers,
            tlsHandshake({ message: 'ClientHello', fields: CLIENT_HELLO_FIELDS }),
          ],
          sizeBytes: clientHelloSegment.sizeBytes,
          at: 700,
          wireTimeMs: 0,
          meta: clientHelloSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-generate-key',
          node: 'laptop',
          kind: 'process',
          label: 'Generate x25519 key pair',
          at: 0,
          durationMs: 600,
        },
      ],
      focus: ['laptop', 'server'],
      simplifications: [
        'The TCP handshake before the ClientHello is not drawn; this segment carries the sequence numbers that follow it.',
        'Browsers send more extensions than shown (and a larger ClientHello); the listed ones are those that matter here.',
        'The home router’s NAT rewrites the source address; each header is shown as its sender emitted it.',
      ],
      references: [
        REF_8446('section 4.1.2: ClientHello', 'section-4.1.2'),
        REF_8446('section 4.2.8: key_share', 'section-4.2.8'),
        {
          label: 'RFC 6066, section 3: Server Name Indication',
          url: 'https://www.rfc-editor.org/rfc/rfc6066#section-3',
        },
        { label: 'RFC 7301: ALPN', url: 'https://www.rfc-editor.org/rfc/rfc7301' },
      ],
    },
    {
      id: 'server-hello',
      title: 'ServerHello: suite choice and key share',
      phase: 'hello',
      summary:
        'The server picks TLS 1.3 and one cipher suite and answers with its own x25519 public key. Both sides can now compute the same shared secret; the rest of the handshake is encrypted.',
      body: [
        {
          type: 'p',
          text: 'ServerHello selects the cipher suite, confirms version `0x0304` in `supported_versions` and returns the server’s `key_share`. The suite names only the record protection (an AEAD cipher) and the hash; key exchange and signatures are negotiated separately.',
        },
        {
          type: 'p',
          text: 'Each side now holds its own private key and the other’s public key. Client private with server public gives the same value as server private with client public: the ephemeral Diffie-Hellman secret. A ChangeCipherSpec record follows for middlebox compatibility and is ignored.',
        },
        {
          type: 'callout',
          tone: 'tip',
          text: 'Both keys are ephemeral and discarded after the handshake, so stealing the server’s certificate key later does not decrypt a recorded session (forward secrecy). TLS 1.3 has no static RSA key exchange.',
        },
      ],
      packets: [
        {
          id: 'p-server-hello',
          from: 'server',
          to: 'laptop',
          via: ['router'],
          protocol: 'tls',
          label: 'ServerHello',
          summary: 'ServerHello, Change Cipher Spec',
          headers: [
            ...serverHelloSegment.headers,
            tlsHandshake({ message: 'ServerHello', fields: SERVER_HELLO_FIELDS }),
            tlsHandshake({
              message: 'ChangeCipherSpec',
              fields: [{ name: 'Payload', value: '0x01', note: 'one byte; no meaning in TLS 1.3' }],
            }),
          ],
          sizeBytes: serverHelloSegment.sizeBytes,
          at: 800,
          wireTimeMs: 7.5,
          meta: serverHelloSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-server-ecdhe',
          node: 'server',
          kind: 'process',
          label: 'ECDHE: compute shared secret',
          at: 0,
          durationMs: 700,
        },
      ],
      focus: ['server', 'laptop'],
      simplifications: [
        'The Ethernet addresses on the server side are placeholders; every real hop rewrites them.',
      ],
      references: [
        REF_8446('section 4.1.3: ServerHello', 'section-4.1.3'),
        REF_8446('section 7.4.2: elliptic curve Diffie-Hellman', 'section-7.4.2'),
        REF_8446('appendix D.4: middlebox compatibility mode', 'appendix-D.4'),
      ],
    },
    {
      id: 'handshake-keys',
      title: 'Both sides derive the handshake keys',
      phase: 'hello',
      summary:
        'Each side feeds the shared secret and a hash of the messages so far into HKDF and obtains handshake traffic keys. Everything the server sends next is encrypted with them.',
      body: [
        {
          type: 'p',
          text: 'The key schedule is a chain of HKDF steps. The shared secret and a hash of the transcript so far (ClientHello and ServerHello) produce the **handshake secret**, and from it one traffic key per direction. Later, the **master secret** and a hash of the transcript up to the server’s Finished yield the application keys.',
        },
        {
          type: 'p',
          text: 'Because every stage mixes in the transcript hash, the keys are bound to exactly what was negotiated. If an attacker had altered the ClientHello, the two sides would derive different keys and the Finished check would fail. No packet moves in this step; the work is local.',
        },
      ],
      packets: [],
      actions: [
        {
          id: 'a-client-keys',
          node: 'laptop',
          kind: 'process',
          label: 'HKDF: handshake keys',
          at: 0,
          durationMs: 1500,
        },
        {
          id: 'a-server-keys',
          node: 'server',
          kind: 'process',
          label: 'HKDF: handshake keys',
          at: 0,
          durationMs: 1500,
        },
      ],
      focus: ['laptop', 'server'],
      simplifications: [
        'The key schedule is summarised: the real one has an early secret, “derived” steps and more labels, and also produces finished keys and a resumption secret.',
      ],
      references: [
        REF_8446('section 7.1: key schedule', 'section-7.1'),
        { label: 'RFC 5869: HKDF', url: 'https://www.rfc-editor.org/rfc/rfc5869' },
      ],
    },
    {
      id: 'encrypted-extensions',
      title: 'EncryptedExtensions: first protected message',
      phase: 'server-flight',
      summary:
        'The server’s first protected message carries extensions that need not be public, here the chosen ALPN protocol. On the wire every record is now typed application_data.',
      body: [
        {
          type: 'p',
          text: 'From here the server encrypts each handshake message with its handshake key. On the wire each is a record whose outer type is `application_data` (23); the real handshake type is hidden inside.',
        },
        {
          type: 'p',
          text: '**EncryptedExtensions** carries extensions that do not affect key setup, such as ALPN: the server picks `http/1.1` from the client’s list. In TLS 1.2 such choices travelled in the clear in ServerHello; in TLS 1.3 a passive observer no longer sees them.',
        },
      ],
      packets: [
        {
          id: 'p-encrypted-extensions',
          from: 'server',
          to: 'laptop',
          via: ['router'],
          protocol: 'tls',
          label: 'EncryptedExt.',
          summary: 'Application Data (EncryptedExtensions)',
          headers: [
            ...encryptedExtensionsSegment.headers,
            tlsHandshake({
              message: 'EncryptedExtensions',
              fields: [{ name: 'alpn', value: 'http/1.1', note: 'the server’s choice' }],
            }),
          ],
          sizeBytes: encryptedExtensionsSegment.sizeBytes,
          encrypted: true,
          at: 700,
          wireTimeMs: 7.53,
          meta: encryptedExtensionsSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-server-encrypts',
          node: 'server',
          kind: 'encrypt',
          label: 'Encrypt with handshake key',
          at: 0,
          durationMs: 600,
        },
        {
          id: 'a-client-decrypts-ee',
          node: 'laptop',
          kind: 'decrypt',
          label: 'Decrypt EncryptedExtensions',
          at: 2400,
          durationMs: 600,
        },
      ],
      focus: ['server', 'laptop'],
      simplifications: [
        'Servers normally batch EncryptedExtensions, Certificate, CertificateVerify and Finished into one or two TCP segments; they are drawn separately to name each message.',
        'The server could also pick `h2`; `http/1.1` keeps the later plaintext easy to read.',
      ],
      references: [
        REF_8446('section 4.3.1: EncryptedExtensions', 'section-4.3.1'),
        REF_8446('section 5.2: record payload protection', 'section-5.2'),
      ],
    },
    {
      id: 'certificate',
      title: 'Certificate: the chain, now encrypted',
      phase: 'server-flight',
      summary:
        'The server sends its leaf certificate for `www.example.com` and one intermediate CA. The root is not sent; the client already has it. TLS 1.3 encrypts the whole message.',
      body: [
        {
          type: 'p',
          text: 'The **Certificate** message lists certificates leaf first: the leaf, whose subject alternative name is `www.example.com` and which holds an ECDSA P-256 public key, then the intermediate CA that signed it. The root CA is **not** sent. Clients ship with a trust store that already contains roots, so sending one would only waste bytes.',
        },
        {
          type: 'p',
          text: 'TLS 1.2 sent this message in the clear. TLS 1.3 encrypts it, so a passive observer no longer reads the certificate, although the SNI still names the site.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'A certificate contains a public key, never the private one. The private key stays on the server and is used for the signature in the next step.',
        },
      ],
      packets: [
        {
          id: 'p-certificate',
          from: 'server',
          to: 'laptop',
          via: ['router'],
          protocol: 'tls',
          label: 'Certificate',
          summary: 'Application Data (Certificate: leaf + intermediate)',
          headers: [
            ...certificateSegment.headers,
            tlsHandshake({ message: 'Certificate', fields: CERTIFICATE_FIELDS }),
          ],
          sizeBytes: certificateSegment.sizeBytes,
          encrypted: true,
          at: 0,
          wireTimeMs: 7.55,
          meta: certificateSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-client-decrypts-cert',
          node: 'laptop',
          kind: 'decrypt',
          label: 'Decrypt Certificate',
          at: 1700,
          durationMs: 600,
        },
      ],
      focus: ['server', 'laptop'],
      simplifications: [
        'The certificates are summarised in one field each; real ones are DER-encoded X.509 structures with more fields (key usage, policies, SCTs). The names, sizes and dates are made up.',
      ],
      references: [
        REF_8446('section 4.4.2: Certificate', 'section-4.4.2'),
        {
          label: 'RFC 5280: X.509 certificate profile',
          url: 'https://www.rfc-editor.org/rfc/rfc5280',
        },
      ],
    },
    {
      id: 'certificate-verify',
      title: 'CertificateVerify: proof of key possession',
      phase: 'server-flight',
      summary:
        'The server signs a hash of the handshake so far with the certificate’s private key. Only the key’s owner can produce that signature, which ties the key exchange to the certificate.',
      body: [
        {
          type: 'p',
          text: 'A certificate alone proves nothing, since anyone can copy it. In **CertificateVerify** the server signs the transcript hash (ClientHello through Certificate) with its private key, using an algorithm from the client’s `signature_algorithms` list, here `ecdsa_secp256r1_sha256`.',
        },
        {
          type: 'p',
          text: 'The signed data includes a fixed context string, so a signature made for this purpose cannot be reused for another. The client will verify the signature with the public key in the leaf certificate.',
        },
      ],
      packets: [
        {
          id: 'p-certificate-verify',
          from: 'server',
          to: 'laptop',
          via: ['router'],
          protocol: 'tls',
          label: 'CertificateVerify',
          summary: 'Application Data (CertificateVerify, ecdsa_secp256r1_sha256)',
          headers: [
            ...certificateVerifySegment.headers,
            tlsHandshake({
              message: 'CertificateVerify',
              fields: [
                { name: 'signature_algorithm', value: 'ecdsa_secp256r1_sha256 (0x0403)' },
                {
                  name: 'signature',
                  value: '72 bytes (DER)',
                  note: 'over the transcript hash with a fixed context string',
                },
              ],
            }),
          ],
          sizeBytes: certificateVerifySegment.sizeBytes,
          encrypted: true,
          at: 700,
          wireTimeMs: 7.82,
          meta: certificateVerifySegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-server-signs',
          node: 'server',
          kind: 'process',
          label: 'Sign transcript hash',
          at: 0,
          durationMs: 600,
        },
      ],
      focus: ['server', 'laptop'],
      references: [REF_8446('section 4.4.3: CertificateVerify', 'section-4.4.3')],
    },
    {
      id: 'server-finished',
      title: 'Server Finished: a MAC over the handshake',
      phase: 'server-flight',
      summary:
        'Finished is an HMAC over the whole handshake so far, keyed from the handshake secret. It confirms that both sides saw the same messages, and it ends the server’s flight.',
      body: [
        {
          type: 'p',
          text: 'Finished closes the server’s flight. Its `verify_data` is an HMAC of the transcript hash under a key derived from the server’s handshake traffic secret. Had an attacker altered an earlier message, such as the cipher suite list in ClientHello, the client’s MAC would not match.',
        },
        {
          type: 'p',
          text: 'That is how TLS 1.3 protects the negotiation itself from downgrade tampering. The server can now derive the application keys, but it waits for the client’s Finished before treating the handshake as complete.',
        },
      ],
      packets: [
        {
          id: 'p-server-finished',
          from: 'server',
          to: 'laptop',
          via: ['router'],
          protocol: 'tls',
          label: 'Finished',
          summary: 'Application Data (Finished)',
          headers: [
            ...serverFinishedSegment.headers,
            tlsHandshake({
              message: 'Finished',
              fields: [
                {
                  name: 'verify_data',
                  value: '32 bytes: HMAC-SHA256(finished_key, transcript hash)',
                },
              ],
            }),
          ],
          sizeBytes: serverFinishedSegment.sizeBytes,
          encrypted: true,
          at: 700,
          wireTimeMs: 7.85,
          meta: serverFinishedSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-server-mac',
          node: 'server',
          kind: 'process',
          label: 'HMAC over transcript',
          at: 0,
          durationMs: 600,
        },
      ],
      focus: ['server', 'laptop'],
      references: [REF_8446('section 4.4.4: Finished', 'section-4.4.4')],
    },
    {
      id: 'validate-chain',
      title: 'Client validates the certificate chain',
      phase: 'client-flight',
      summary:
        'Before trusting anything, the client checks locally: signatures up to a root in its trust store, the hostname in the SAN, validity dates, then CertificateVerify and Finished.',
      body: [
        {
          type: 'list',
          ordered: true,
          items: [
            'The leaf’s signature verifies with the intermediate’s public key.',
            'The intermediate’s signature verifies with a root key from the client’s **trust store**. The root was never sent; it is trusted because it is already installed.',
            'The name `www.example.com` appears among the certificate’s subject alternative names. The old common name field is not used for this.',
            'Every certificate in the chain is within its validity dates.',
            'The CertificateVerify signature and the server’s Finished MAC check out.',
          ],
        },
        {
          type: 'p',
          text: 'No packet moves here. A failed check ends the handshake with an alert such as `bad_certificate` or `certificate_expired`, and no application data is ever sent.',
        },
      ],
      packets: [],
      actions: [
        {
          id: 'a-verify-leaf',
          node: 'laptop',
          kind: 'verify',
          label: 'Leaf signed by intermediate',
          at: 0,
          durationMs: 800,
        },
        {
          id: 'a-verify-root',
          node: 'laptop',
          kind: 'verify',
          label: 'Intermediate signed by trusted root',
          at: 900,
          durationMs: 800,
        },
        {
          id: 'a-verify-san',
          node: 'laptop',
          kind: 'verify',
          label: 'SAN matches www.example.com',
          at: 1800,
          durationMs: 800,
        },
        {
          id: 'a-verify-dates',
          node: 'laptop',
          kind: 'verify',
          label: 'Validity dates cover today',
          at: 2700,
          durationMs: 800,
        },
        {
          id: 'a-verify-signature',
          node: 'laptop',
          kind: 'verify',
          label: 'CertificateVerify signature',
          at: 3600,
          durationMs: 800,
        },
        {
          id: 'a-verify-finished',
          node: 'laptop',
          kind: 'verify',
          label: 'Server Finished MAC',
          at: 4500,
          durationMs: 800,
        },
      ],
      focus: ['laptop'],
      simplifications: [
        'Real clients also check key usage, basic constraints, name constraints, revocation and certificate transparency policy; only the core checks are shown.',
        'Validation can start as soon as the Certificate arrives; it is shown after the server flight to keep the order readable.',
      ],
      references: [
        {
          label: 'RFC 5280, section 6: certification path validation',
          url: 'https://www.rfc-editor.org/rfc/rfc5280#section-6',
        },
        {
          label: 'RFC 9525: service identity in TLS',
          url: 'https://www.rfc-editor.org/rfc/rfc9525',
        },
        REF_8446('section 4.4.2.4: receiving a Certificate message', 'section-4.4.2.4'),
      ],
    },
    {
      id: 'client-finished',
      title: 'Client Finished: the handshake is complete',
      phase: 'client-flight',
      summary:
        'The client answers with its own Finished, and both sides switch to application traffic keys. One round trip was enough; TLS 1.2 needed two.',
      body: [
        {
          type: 'p',
          text: 'Client **Finished** mirrors the server’s: an HMAC over the transcript, now including the server’s Finished. It travels in a record protected by the client’s handshake key, after a dummy ChangeCipherSpec. Both sides then derive the **application traffic keys** from the master secret and retire the handshake keys.',
        },
        {
          type: 'callout',
          tone: 'tip',
          text: 'How TLS 1.2 differs: ServerHello, Certificate and ServerKeyExchange arrived in plaintext, and the client’s key exchange needed a second round trip. It also allowed RSA key exchange, where the client encrypted a secret to the server’s public key, so a stolen key exposed old sessions. TLS 1.3 dropped that mode; certificate keys now only sign.',
        },
      ],
      packets: [
        {
          id: 'p-client-finished',
          from: 'laptop',
          to: 'server',
          via: ['router'],
          protocol: 'tls',
          label: 'Finished',
          summary: 'Change Cipher Spec, Application Data (Finished)',
          headers: [
            ...clientFinishedSegment.headers,
            tlsHandshake({
              message: 'ChangeCipherSpec',
              fields: [{ name: 'Payload', value: '0x01', note: 'compatibility record' }],
            }),
            tlsHandshake({
              message: 'Finished',
              fields: [
                {
                  name: 'verify_data',
                  value: '32 bytes: HMAC-SHA256(finished_key, transcript hash)',
                },
              ],
            }),
          ],
          sizeBytes: clientFinishedSegment.sizeBytes,
          encrypted: true,
          at: 700,
          wireTimeMs: 15.8,
          meta: clientFinishedSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-client-mac',
          node: 'laptop',
          kind: 'process',
          label: 'HMAC over transcript',
          at: 0,
          durationMs: 600,
        },
        {
          id: 'a-client-app-keys',
          node: 'laptop',
          kind: 'process',
          label: 'Derive application keys',
          at: 1500,
          durationMs: 700,
        },
        {
          id: 'a-server-checks-finished',
          node: 'server',
          kind: 'verify',
          label: 'Client Finished valid',
          at: 2350,
          durationMs: 700,
        },
        {
          id: 'a-server-app-keys',
          node: 'server',
          kind: 'process',
          label: 'Derive application keys',
          at: 3100,
          durationMs: 700,
        },
      ],
      focus: ['laptop', 'server'],
      simplifications: [
        'The client may send its first request in the same flight as Finished; it is drawn in the next step.',
        'The compact TLS 1.2 comparison leaves out session resumption and renegotiation.',
      ],
      references: [
        REF_8446('section 2: protocol overview (1-RTT)', 'section-2'),
        REF_8446('section 7.1: key schedule', 'section-7.1'),
        { label: 'RFC 5246: TLS 1.2', url: 'https://www.rfc-editor.org/rfc/rfc5246' },
      ],
    },
    {
      id: 'application-data',
      title: 'Application data under the new keys',
      phase: 'data',
      summary:
        'The first HTTP request and its response travel as encrypted application-data records. Each is authenticated, so any change in transit is detected.',
      body: [
        {
          type: 'p',
          text: 'With application keys in place, HTTP flows through TLS records. Each record is encrypted and authenticated by an AEAD cipher, here AES-128-GCM. The per-record nonce comes from a sequence number, so a record cannot be reordered or replayed within the connection, and any alteration fails the authentication tag.',
        },
        {
          type: 'p',
          text: `Protection adds ${TLS_OVERHEAD} bytes per record: a 5-byte header, a 1-byte inner content type and a 16-byte tag. An observer sees the lengths and the timing, never the content.`,
        },
      ],
      packets: [
        {
          id: 'p-get',
          from: 'laptop',
          to: 'server',
          via: ['router'],
          protocol: 'http',
          label: 'GET / (encrypted)',
          summary: `Application Data, ${sealed(GET_BYTES)} bytes (HTTP request inside TLS)`,
          headers: [
            ...getSegment.headers,
            sealedRecord(GET_BYTES),
            http1Request({ method: 'GET', path: '/', host: HOST.www, headers: GET_FIELDS }),
          ],
          payload: `On the wire: TLS record header + ${sealed(GET_BYTES) - 5} bytes of ciphertext.`,
          sizeBytes: getSegment.sizeBytes,
          encrypted: true,
          at: 0,
          wireTimeMs: 15.9,
          meta: getSegment.meta,
        },
        {
          id: 'p-ok',
          from: 'server',
          to: 'laptop',
          via: ['router'],
          protocol: 'http',
          label: '200 (encrypted)',
          summary: `Application Data, ${sealed(OK_BYTES)} bytes (HTTP response inside TLS)`,
          headers: [
            ...okSegment.headers,
            sealedRecord(OK_BYTES),
            http1Response({ status: 200, headers: OK_FIELDS }),
          ],
          payload: `On the wire: TLS record header + ${sealed(OK_BYTES) - 5} bytes of ciphertext.`,
          sizeBytes: okSegment.sizeBytes,
          encrypted: true,
          at: 2300,
          wireTimeMs: 23.5,
          meta: okSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-server-handles',
          node: 'server',
          kind: 'decrypt',
          label: 'Decrypt · handle request',
          at: 1700,
          durationMs: 500,
        },
        {
          id: 'a-client-reads',
          node: 'laptop',
          kind: 'decrypt',
          label: 'Decrypt response',
          at: 3950,
          durationMs: 500,
        },
      ],
      focus: ['laptop', 'server'],
      simplifications: [
        'The headers listed for each packet are what the endpoints see after decryption; a capture on the wire shows only the TLS record.',
        'HTTP/1.1 is used for readability; with ALPN `h2` the same protection carries HTTP/2 frames. Pure ACK segments are left out.',
      ],
      references: [
        REF_8446('section 5.2: record payload protection', 'section-5.2'),
        { label: 'RFC 9112: HTTP/1.1', url: 'https://www.rfc-editor.org/rfc/rfc9112' },
      ],
    },
    {
      id: 'session-ticket',
      title: 'NewSessionTicket: resumption and 0-RTT',
      phase: 'data',
      summary:
        'After the handshake the server can hand out a session ticket. A later connection can present it as a pre-shared key to resume faster, optionally sending early data (0-RTT).',
      body: [
        {
          type: 'p',
          text: 'The ticket is an opaque blob only the server can read, plus a lifetime and an age-obfuscation value. The client stores it together with a resumption secret derived from this session. A server may send a ticket at any point after the handshake; this one sends it after the first response.',
        },
        {
          type: 'p',
          text: 'On a later connection the ClientHello offers the ticket as a **PSK** with `psk_dhe_ke`. The server can then skip the certificate steps, while a fresh ECDHE exchange still gives forward secrecy.',
        },
        {
          type: 'callout',
          tone: 'warning',
          text: '**0-RTT** lets the client send a request in its first flight. That early data can be replayed by an attacker, so servers should accept only safe, idempotent requests there.',
        },
      ],
      packets: [
        {
          id: 'p-session-ticket',
          from: 'server',
          to: 'laptop',
          via: ['router'],
          protocol: 'tls',
          label: 'NewSessionTicket',
          summary: 'Application Data (NewSessionTicket)',
          headers: [
            ...ticketSegment.headers,
            tlsHandshake({
              message: 'NewSessionTicket',
              fields: [
                { name: 'ticket_lifetime', value: '7200 s (2 h)' },
                { name: 'ticket_age_add', value: '32-bit random value' },
                { name: 'ticket_nonce', value: '8 bytes' },
                { name: 'ticket', value: '192 opaque bytes', note: 'only the server can read it' },
              ],
            }),
          ],
          sizeBytes: ticketSegment.sizeBytes,
          encrypted: true,
          at: 0,
          wireTimeMs: 23.8,
          meta: ticketSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-client-stores-ticket',
          node: 'laptop',
          kind: 'store',
          label: 'Stores ticket and secret',
          at: 1700,
          durationMs: 600,
        },
      ],
      focus: ['server', 'laptop'],
      simplifications: [
        'The resumed handshake and 0-RTT data are described but not drawn.',
        'Real servers often send two tickets; one is shown.',
      ],
      references: [
        REF_8446('section 4.6.1: New Session Ticket', 'section-4.6.1'),
        REF_8446('section 2.2: resumption and PSK', 'section-2.2'),
        REF_8446('section 2.3: 0-RTT data', 'section-2.3'),
        REF_8446('appendix E.5: replay attacks on 0-RTT', 'appendix-E.5'),
      ],
    },
  ],
});
