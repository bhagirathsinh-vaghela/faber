# Voice: dictation and read-aloud

Faber has two voice features. **Dictation** turns speech into text in the composer or a question answer, from any device, with pause and resume, a live transcript, and recovery when the connection drops mid-dictation. **Read-aloud** speaks an assistant answer or a thinking card: a model first rewrites the markdown into natural spoken English, and the result is synthesized and played chunk by chunk. Both run on a local speech sidecar that you provide; the wire API it must implement is in [speech-sidecar.md](../speech-sidecar.md).

## How it works

### Dictation

```text
mic ─▶ AudioWorklet (PCM16 at the sidecar's rate) ─WebSocket /dictation/connect─▶ server ─POST /transcribe─▶ sidecar
                                                   ◀── transcript frames ─────────
```

1. The browser opens `GET /dictation/connect` as a WebSocket, passing a client-minted id. The server looks up the model's sample rate (`DictationRate.get`, from the sidecar's `/health`, cached) and tells the browser which rate to capture at.
2. An AudioWorklet captures mono audio at that rate and sends PCM16 frames. The browser's own resampler does the conversion; a box-average decimator runs only if the browser ignores the requested rate.
3. The server buffers frames. A **pause** commits the audio so far as one chunk and posts it to `/transcribe`, so a thinking gap is transcribed early and a noisy stretch can be skipped. **Stop** posts the rest. Chunks are posted one at a time in capture order, and each is decoded from fresh state.
4. Final text streams back over the socket and accumulates in an overlay above the input, behind a live waveform. Enter, the check button or a tap outside accepts and inserts it at the caret; Escape discards.

Frames that arrive before the engine is ready are buffered rather than dropped, since the browser starts sending as soon as the socket opens.

**Recovery.** If the socket drops before a clean stop, the server treats it as a stop: it transcribes the buffered audio and holds the finished text under the client's id for five minutes (`DictationRecover`). The client pulls it from `GET /dictation/recover/:id` straight away and again on reconnect. A pull does not consume it: the client releases it with `DELETE /dictation/recover/:id` once it has been inserted, and an unreleased transcript expires. A pull waits up to 45 seconds for a recovery still running and returns 202 if it is not done yet.

**Capture details.**

| Detail              | Behaviour                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Armed cue           | the overlay says "Starting" until the worklet delivers its first frame, then shows the recording cue                      |
| Raw or enhanced mic | browser echo cancellation, noise suppression and auto gain are off by default (raw); "enhanced" turns them on, per device |
| Model rate change   | if the sidecar's rate changed during capture, the dictation fails with a retry message and the cache updates              |
| Runaway buffer      | a chunk never paused is flushed on its own at 10 minutes of audio                                                         |
| Origin check        | the WebSocket upgrade rejects a browser `Origin` from another site (`Origin.socket`)                                      |

### Read-aloud

A speaker button on assistant text and thinking cards starts a reading.

1. **Rewrite.** The client posts the part's text to `POST /tts/prepare`. The server runs `TtsRewrite.prepare`, which asks a model to rewrite the markdown into what a person would say reading it aloud to a colleague, and streams the result back as NDJSON chunk lines. Tables and code blocks are bracketed by spoken phrases and get chunks of their own, so the forward control skips a whole table.
2. **Chunk.** `TtsChunk` cuts the rewrite into speakable chunks only once no later text can change them. The first sentence is emitted alone so audio can start early; the second flushes at 200 characters so it can render while the first plays; later chunks pack toward 350 characters with a 400 character cap, cut at sentence, then clause, then word boundaries.
3. **Synthesize.** The client requests each chunk through `POST /tts/speak`, which the server proxies to the sidecar's `/speak`. The chunk about to play is requested at priority `now`, the one after at `next`, and one more at `background`. Skipping re-ranks requests rather than starting over.
4. **Release.** Closing or replacing a reading calls `POST /tts/done`, which releases that reading's queued renders on the sidecar.

The rewrite prompt is long on purpose and is the request's only cache marker, so repeated rewrites read it from the prompt cache. It fences the message as data, since assistant messages often contain text like "run npm test" that must be narrated, not obeyed. Each rewrite attempt must produce its first chunk within 15 seconds and the whole rewrite must finish within 120 seconds. A failed or refused rewrite gets one retry, on `dictation.rewrite.fallback` when configured. If both attempts fail before anything was spoken, the original text is read as written and not cached. A guard rejects a rewrite that leaves markdown (code fences, table pipes, brackets, emphasis, headings) or tags in the spoken text.

Playback speed ranges from 0.5x to 2.5x in 0.1 steps. The voice picker in the playback panel stores the choice on the server (`/preference/voice`), so every client uses the same voice; it wins over `dictation.voice`.

### Keys and surfaces

| Surface                                          | Action                                    |
| ------------------------------------------------ | ----------------------------------------- |
| Mic in the composer, question panel, reader pill | start dictation                           |
| `alt+.`                                          | toggle dictation for the focused composer |
| Pause / resume in the overlay                    | commit audio so far, or skip a stretch    |
| Raw / Enhanced in the dock preferences           | browser mic processing on or off          |
| Speaker on assistant text and thinking cards     | read aloud                                |

## Configuration

All keys live under `dictation` in the global config.

| Key                                  | Meaning                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `dictation.url`                      | sidecar base URL; default `http://127.0.0.1:4111`                         |
| `dictation.voice`                    | default read-aloud voice name, e.g. `af_heart`                            |
| `dictation.rewrite.model`            | `provider/model` for the read-aloud rewrite; the default model when unset |
| `dictation.rewrite.variant`          | variant of the rewrite model                                              |
| `dictation.rewrite.fallback.model`   | where the one retry goes; the rewrite model itself when unset             |
| `dictation.rewrite.fallback.variant` | variant of the fallback model                                             |

```json
{
  "dictation": {
    "url": "http://127.0.0.1:4111",
    "voice": "af_heart"
  }
}
```

## Why

- **A local sidecar outside the binary.** Dictation began on a hosted streaming API, which sent audio off the machine and fixed the model. The engine moved behind a seam and then to a local sidecar only. It lives outside the binary because `bun --compile` cannot embed the native addon its runtime needs, and because the model changes far less often than the binary.
- **Server proxy.** The sidecar is bound to loopback and a phone is not on that host, so the server proxies synthesis and a client needs only one origin.
- **Raw mic by default.** Browser noise suppression clips consonants, auto gain pumps levels, and echo cancellation eats parts of the voice. That damage happens at capture and cannot be undone server-side; it helps only a quiet built-in mic.
- **The armed cue.** Opening the OS capture route takes about a fifth of a second warm and most of a second cold, and words spoken in that gap are lost, so the recording cue waits for the first frame.
- **Recovery.** A dropped socket used to discard everything, including text already transcribed and on screen.
- **Chunk sizes.** Only the chunk being played covers the next one's synthesis. An earlier sizing, a 90 character opening chunk followed by a 600 character one, put 5.6 seconds of synthesis behind 3.2 seconds of audio, so the listener heard the first phrase and then waited.
- **Fallback model.** A model can refuse some thinking parts as reasoning extraction, and the same request is usually refused again, so the retry can go to a different model.

## Code

| Area                  | Pointer                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Dictation socket      | `packages/opencode/src/dictation/index.ts` (`Dictation.connect`)                           |
| Sidecar transcription | `packages/opencode/src/dictation/local.ts` (`local`)                                       |
| Sample rate           | `packages/opencode/src/dictation/rate.ts` (`DictationRate`)                                |
| Recovery store        | `packages/opencode/src/dictation/recover.ts` (`DictationRecover`)                          |
| Dictation routes      | `packages/opencode/src/server/routes/dictation.ts` (`DictationRoutes`)                     |
| Read-aloud routes     | `packages/opencode/src/server/routes/tts.ts` (`TtsRoutes`)                                 |
| Rewrite               | `packages/opencode/src/session/tts-rewrite.ts` (`TtsRewrite.prepare`, `TtsRewrite.PROMPT`) |
| Chunker               | `packages/opencode/src/session/tts-chunk.ts` (`TtsChunk`)                                  |
| Voice preference      | `packages/opencode/src/preference/voice.ts` (`VoicePreference`)                            |
| Capture, worklet      | `packages/app/src/utils/dictation.ts`                                                      |
| Playback, scheduling  | `packages/app/src/utils/speak.ts` (`RATE`, `VOICES`)                                       |
| Overlays              | `packages/app/src/components/dictation-overlay.tsx`, `speech-overlay.tsx`                  |
