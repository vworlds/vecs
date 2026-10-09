# Frames

A connection carries two messages: `Server2Client`, the server's frame, and `Client2Server`, the
client's ack. Each is a list of optional fields, written only when set.

## What you'll learn

- Which fields each message can carry, their tags, and when each is present.
- How a diff is labelled, and what a client may do with one that starts past what it holds.
- What the optimistic marker and the gap report are, and who sends them.
- Why a frame is byte-identical to the one before a field existed, and how to roll out a new field.

## The messages

`Server2Client` and `Client2Server` are `IEncodable` classes from `@vworlds/vecs-protocol`. A field
is encoded only when it differs from its default, so a frame with nothing to say is empty, and a
field that a peer never sets never reaches the wire.

| `Server2Client` field | Tag | Present when                                                               |
| --------------------- | --- | -------------------------------------------------------------------------- |
| `diff`                | 1   | The frame carries state: a delta or a baseline (a `StateDiff`).            |
| `rpc`                 | 2   | There are calls or replies to deliver.                                     |
| `close`               | 4   | The server is closing the session on purpose (the graceful-close frame).   |
| `rpcSettledBelow`     | 5   | Above `0`: the low watermark of the calls the server issued.               |
| `optimistic`          | 6   | `true`: the diff starts past the frame the server last saw the client ack. |

| `Client2Server` field | Tag | Present when                                                          |
| --------------------- | --- | --------------------------------------------------------------------- |
| `ackFrame`            | -   | Always, as a leading `u32`: the newest frame the client has accepted. |
| `rpc`                 | 2   | There are calls or replies to deliver.                                |
| `input`               | 3   | The client has input to send.                                         |
| `rpcSettledBelow`     | 5   | Above `0`: the low watermark of the calls the client issued.          |
| `gap`                 | 7   | `true`: the client holds an optimistic diff it cannot apply yet.      |

A decoder rejects a tag it does not know, so a frame from a peer with a newer protocol closes the
connection with `CLOSE_PROTOCOL_ERROR_CODE`. Add fields as new tags, set only when needed, and roll
the reading side out first.

## Diffs and their labels

A `StateDiff` carries `toFrame`, `fromFrame`, the encoded component snapshots and the removed
components. `fromFrame` `0` marks a **baseline**, the whole view as of `toFrame`. Any other value
marks a **delta**: everything that changed after `fromFrame`, up to and including `toFrame`, each
component once at its latest value.

The label is a claim about the client: _you hold the state at `fromFrame`_. A client accepts a delta
when `fromFrame` is no later than the newest frame it has accepted, and that is what keeps its state
equal to the server's at every frame it reports (see
[Replication](../../../architecture/REPLICATION.md#the-invariant)). A delta that starts later is
missing what changed in between.

## The optimistic marker and the gap report

By default the server labels a delta with the frame the client last acked, which the client holds by
definition, so the claim is always true. A server with `redundancyFrames` set labels it with a later
frame, to avoid resending a change in every frame until its ack arrives: the frame it sent the client
`redundancyFrames` sends ago, which is always a frame the client was sent, never one that went out
empty. The claim may then be false, because that frame was lost along with every send after it, and
`Server2Client.optimistic` says so:

- An **unmarked** delta that starts past the client's frame is the server's mistake, and a protocol
  error.
- A **marked** one is a gap. The client does not close: it holds the diff until the frames before it
  arrive, applies it then, and sets `Client2Server.gap` on its next ack so that the server sends
  deltas from the ack until the client has caught up.

```ts
import { Client2Server, Server2Client, StateDiff } from "@vworlds/vecs-protocol";
import { Decoder, Encoder } from "@vworlds/vecs-wire";

const frameEncoder = new Encoder(new Uint8Array(1024));
frameEncoder.write(
  new Server2Client({ diff: new StateDiff({ fromFrame: 6, toFrame: 8 }), optimistic: true })
);
const frame = new Decoder(frameEncoder.getBuffer()).read(Server2Client);
frame.optimistic; // true: the server presumed the client holds frame 6

const ackEncoder = new Encoder(new Uint8Array(1024));
ackEncoder.write(new Client2Server({ ackFrame: 4, gap: true }));
const ack = new Decoder(ackEncoder.getBuffer()).read(Client2Server);
ack.gap; // true: the client is at frame 4 and holds a diff it cannot apply
```

Neither field is encoded unless it is `true`, as a bare tag with no payload. A server that does not
set `redundancyFrames` never sends the marker, so every frame it sends is byte-identical to one built
before the field existed, and a client only sets `gap` after receiving a marked frame, so it never
does against such a server. The server enabling `redundancyFrames` must only serve clients that
understand the marker; the mechanism, its cost and the liveness timer that backs it are in
[Replication](../../../architecture/REPLICATION.md#the-optimistic-base).

## See also

- [Remote procedure calls](./rpc.md) — the `rpc` field and the settled watermark.
- [Sessions](../../vecs-server/docs/sessions.md#redundancy-redundancyframes) — enabling the optimistic base.
- [Client world](../../vecs-client/docs/client-world.md#optimistic-frames-and-gaps) — what the client does with a marked diff.
