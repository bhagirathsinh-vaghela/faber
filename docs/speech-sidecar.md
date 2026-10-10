# Speech sidecar

Faber's dictation and read-aloud features (see [voice](features/voice.md)) do no speech processing in the server binary. They call a separate local HTTP service, the speech sidecar, over a small wire API. Faber does not ship a sidecar; this page specifies the API so any server that implements it works.

One working setup is a sidecar built on [FluidAudio](https://github.com/FluidInference/FluidAudio), an open-source Swift SDK, running Parakeet for speech-to-text and Kokoro for text-to-speech on the Apple Neural Engine. Any engine works behind the API, as long as it serves these four endpoints.

## Topology

```text
browser ──WebSocket /dictation/connect──▶ Faber server ──POST /transcribe──▶ sidecar
browser ──POST /tts/prepare, /tts/speak──▶ Faber server ──POST /speak──────▶ sidecar
```

Browsers never talk to the sidecar. The Faber server proxies every call, so a client needs only the server's origin, and the sidecar can stay bound to loopback.

## Configuration

| Key               | Default                 | Meaning                                           |
| ----------------- | ----------------------- | ------------------------------------------------- |
| `dictation.url`   | `http://127.0.0.1:4111` | base URL of the sidecar (`Dictation.DEFAULT_URL`) |
| `dictation.voice` | unset                   | default voice name sent to `/speak`               |

Both are read from the **global** config (`Config.getGlobal`), not a project config, because the dictation WebSocket upgrade and the `/tts` routes run without a project instance.

```json
{
  "dictation": {
    "url": "http://127.0.0.1:4111",
    "voice": "af_heart"
  }
}
```

## Endpoints

| Endpoint           | Used for   | Request                                                       | Response                                 |
| ------------------ | ---------- | ------------------------------------------------------------- | ---------------------------------------- |
| `GET /health`      | dictation  | none                                                          | JSON `{ "sampleRate": number }`          |
| `POST /transcribe` | dictation  | `application/octet-stream`, raw mono PCM16                    | JSON `{ "text": string, "ms"?: number }` |
| `POST /speak`      | read-aloud | JSON `{ text, voice?, priority? }`, header `x-speech-session` | audio body, optional `x-audio-seconds`   |
| `POST /done`       | read-aloud | header `x-speech-session`                                     | any 2xx                                  |

### `GET /health`

Returns the sample rate the speech-to-text model expects, as JSON with a numeric `sampleRate`. Other fields are ignored.

- Faber calls it with a 2 second timeout and caches the answer (`DictationRate`). If the sidecar is unreachable or the field is missing, it uses 16000.
- The rate is sent to the browser at the start of every dictation, and the browser captures at that rate.
- When a dictation stops, Faber calls `/health` again. If `sampleRate` changed since capture started, the dictation fails with "The dictation model changed. Please try again." and the cache updates, so the next dictation captures at the new rate.

### `POST /transcribe`

The body is raw audio with no container or header: mono, 16-bit signed little-endian PCM, at the rate `/health` announced (16 kHz by default). Content type `application/octet-stream`.

Each request is one utterance. Faber sends a request when the user pauses, when they stop, and when an unpaused chunk reaches 10 minutes of audio at 16 kHz. The sidecar must decode every request from fresh state; no request should inherit decoder state from the previous one.

Response: JSON with `text` (the transcript; empty is fine) and optionally `ms` (engine time, logged only). Faber strips leading periods and commas from each chunk, since a chunk cut at a pause can start with a stray boundary mark.

| Behaviour           | Value                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| Attempts            | 3, with a 400 ms backoff; a non-2xx status counts as a failed attempt |
| Timeout per attempt | 30 s plus the chunk's audio duration                                  |
| Ordering            | chunks are sent one at a time, in capture order                       |
| Unreadable JSON     | the dictation fails; it is not retried                                |

The retries exist because a restarting sidecar refuses connections for about a second, and the same audio is re-sent on each attempt.

### `POST /speak`

Request body:

```json
{ "text": "Next, run the rollout status check.", "voice": "af_heart", "priority": "now" }
```

| Field      | Meaning                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `text`     | one chunk of plain spoken text, already rewritten from markdown; up to about 400 characters                      |
| `voice`    | the voice picked in the UI, else `dictation.voice`; omitted when neither is set, so the sidecar uses its default |
| `priority` | `now` (the chunk playing next), `next` (the one after), or `background`; omitted means `now`                     |

Header `x-speech-session` identifies one showing of one reading in one browser tab. Use it to group queued renders so `/done` can release them.

Response: the audio as the body. Faber passes `content-type` through (defaulting to `audio/wav` when absent) and passes `x-audio-seconds` through when present. WAV works in every browser.

What the client expects of the sidecar's queue:

- Renders run one at a time, highest priority first.
- A job's rank is the highest priority of any live request for it. To re-rank a chunk the client sends a new request for the same text at the new priority, then aborts the old one, so a sidecar should attach the new request to the already-queued job rather than render it twice.
- When the client disconnects, the request is aborted; the sidecar should drop work nobody is waiting for.

Status codes: a 4xx (bad JSON, empty text) is returned to the browser with its status. A 5xx becomes a 502 at the browser. The convention is 503 when a render was cancelled (the client left, or `/done` ran) and 500 when synthesis failed.

### `POST /done`

Header `x-speech-session`. Releases every queued render for that session; called when a reading is closed or replaced. The body and status are ignored, and a failure is only logged.

## Writing a sidecar

- Bind to `127.0.0.1`. The sidecar has no authentication, and the Faber server is its only client.
- Keep the models resident. Every dictation pause is a request, and read-aloud sends one request per chunk.
- If the speech-to-text model changes sample rate, report the new one from `/health`; Faber picks it up without a restart.
- The read-aloud voice picker in the web UI lists Kokoro v1's English speaker names (`af_heart`, `am_adam`, `bf_emma` and so on). A sidecar on another engine can map those names to its own voices, or accept any name set through `dictation.voice`.

## Code

| Area                    | Pointer                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Default URL, WebSocket  | `packages/opencode/src/dictation/index.ts` (`Dictation.DEFAULT_URL`, `Dictation.connect`) |
| `/transcribe` client    | `packages/opencode/src/dictation/local.ts` (`local`)                                      |
| `/health` and rate      | `packages/opencode/src/dictation/rate.ts` (`DictationRate`)                               |
| `/speak`, `/done` proxy | `packages/opencode/src/server/routes/tts.ts` (`TtsRoutes`)                                |
| Priority scheduling     | `packages/app/src/utils/speak.ts`                                                         |
| Config schema           | `packages/opencode/src/config/config.ts` (`Config.Dictation`)                             |
